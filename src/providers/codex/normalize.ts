import { deriveAvailability } from "../../domain/availability.js";
import { LimitIdAllocator, slug } from "../../domain/ids.js";
import { makeIssue } from "../../domain/issues.js";
import type { Availability, CreditBalance, LimitKind, LimitScope, ProviderIssue, RateLimit, TokenAnalytics } from "../../domain/model.js";
import { clamp, isDecimalString, round2, safeInt } from "../../domain/numbers.js";
import { epochToIso, formatDuration } from "../../domain/time.js";
import type { UntimedProviderReport } from "../types.js";
import type { CodexAccount, CodexRateLimitsResponse, CodexSnapshot, CodexTokenUsageResponse } from "./schema.js";

export interface CodexNormalizationInfo {
  account: CodexAccount | null;
  providerVersion: string | null;
  analytics?: CodexTokenUsageResponse | null;
  errors?: ProviderIssue[];
}

function percent(value: unknown, warnings: ProviderIssue[]): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    warnings.push(makeIssue("invalid_number", "Codex percentage is not a finite number."));
    return null;
  }
  return round2(value);
}

function analytics(usage: CodexTokenUsageResponse, warnings: ProviderIssue[]): TokenAnalytics {
  const summary = usage.summary;
  const daily: TokenAnalytics["daily"] = [];
  for (const bucket of usage.dailyUsageBuckets ?? []) {
    const tokens = safeInt(bucket.tokens, warnings);
    // The contract requires a number for daily tokens; omit unsafe buckets
    // rather than fabricate a count or return a schema-invalid null.
    if (tokens !== null) daily.push({ date: bucket.startDate, tokens });
  }
  daily.sort((left, right) => left.date.localeCompare(right.date));
  return {
    lifetimeTokens: safeInt(summary.lifetimeTokens, warnings), peakDailyTokens: safeInt(summary.peakDailyTokens, warnings),
    longestRunningTurnSec: safeInt(summary.longestRunningTurnSec, warnings),
    currentStreakDays: safeInt(summary.currentStreakDays, warnings), longestStreakDays: safeInt(summary.longestStreakDays, warnings), daily,
  };
}

function availability(raw: CodexRateLimitsResponse, limits: RateLimit[]): Availability {
  const derived = deriveAvailability(limits);
  const flags = { basis: "provider_flag" as const, exhaustedLimitIds: derived.exhaustedLimitIds };
  if (raw.rateLimitReachedType != null) return { ...flags, state: "limited", reason: raw.rateLimitReachedType };
  if (raw.ordinaryUsageAllowed === false) return { ...flags, state: "limited", reason: "ordinary_usage_not_allowed" };
  if (raw.spendControlReached === true) return { ...flags, state: "limited", reason: "spend_control_reached" };
  if (raw.ordinaryUsageAllowed === true) return { ...flags, state: "available", reason: null };
  return derived;
}

/** Purely normalize validated Codex snapshots; retain no raw data in the result. */
export function normalizeCodexUsage(
  raw: CodexRateLimitsResponse,
  info: CodexNormalizationInfo,
): Extract<UntimedProviderReport, { status: "ok" | "partial" }> {
  const warnings: ProviderIssue[] = [];
  const limits: RateLimit[] = [];
  const allocator = new LimitIdAllocator();

  function windows(snapshot: CodexSnapshot, scope: LimitScope, prefix: string): void {
    for (const position of ["primary", "secondary"] as const) {
      const window = snapshot[position];
      if (window == null) continue;
      const minutes = window.windowDurationMins ?? null;
      const kind: LimitKind = minutes === 300 ? "session" : minutes === 10080 ? "weekly" : "other";
      const providerKey = `${prefix}.${position}`;
      const id = scope.type === "bucket" ? `${kind}:bucket:${slug(scope.bucket)}`
        : kind === "other" ? `other:${slug(providerKey)}` : kind;
      const usedPercent = percent(window.usedPercent, warnings);
      limits.push({
        id: allocator.allocate(id, warnings), kind, scope,
        label: kind === "session" ? "5h" : kind === "weekly" ? "Weekly" : minutes === null
          ? position === "primary" ? "Primary" : "Secondary" : formatDuration(minutes),
        usedPercent, remainingPercent: usedPercent === null ? null : round2(clamp(100 - usedPercent, 0, 100)),
        windowMinutes: minutes, windowSource: minutes === null ? "unknown" : "reported",
        resetsAt: epochToIso(window.resetsAt, warnings), providerKey,
      });
    }
  }

  const entries = Object.entries(raw.rateLimitsByLimitId ?? {});
  if (entries.length === 0) windows(raw.rateLimits, { type: "account" }, "rateLimits");
  else {
    const defaultKey = entries.some(([key]) => key === raw.rateLimits.limitId) ? raw.rateLimits.limitId : "codex";
    const defaultSnapshot = entries.find(([key]) => key === defaultKey)?.[1];
    // Default windows retain the canonical origin used by the v1 example.
    if (defaultSnapshot !== undefined) windows(defaultSnapshot, { type: "account" }, "rateLimits");
    for (const [key, snapshot] of entries) {
      if (key === defaultKey) continue;
      windows(snapshot, { type: "bucket", bucket: key, name: snapshot.limitName ?? null, model: snapshot.normalModelSlug ?? null }, `rateLimitsByLimitId.${key}`);
    }
  }

  if (raw.individualLimit != null) {
    const remaining = raw.individualLimit.remainingPercent;
    const usedPercent = typeof remaining === "number" && Number.isFinite(remaining) ? round2(100 - remaining) : percent(remaining, warnings);
    limits.push({
      id: allocator.allocate("spend_control", warnings), kind: "spend_control", scope: { type: "account" }, label: "Spend cap",
      usedPercent, remainingPercent: usedPercent === null ? null : round2(clamp(100 - usedPercent, 0, 100)),
      windowMinutes: null, windowSource: "unknown", resetsAt: epochToIso(raw.individualLimit.resetsAt, warnings), providerKey: "individualLimit",
    });
  }

  const credits: CreditBalance[] = [];
  if (raw.rateLimits.credits != null) {
    const reported = raw.rateLimits.credits;
    const balance = isDecimalString(reported.balance) ? reported.balance : null;
    if (reported.balance != null && balance === null) warnings.push(makeIssue("invalid_number", "Codex credit balance is not a decimal string."));
    credits.push({
      id: "codex_credits", label: "Credits", unit: { type: "provider_credits" }, balance,
      used: null, limit: null, usedPercent: null, unlimited: reported.unlimited, hasCredits: reported.hasCredits,
      enabled: null, disabledReason: null, providerKey: "rateLimits.credits",
    });
  }

  const errors = [...(info.errors ?? [])];
  return {
    provider: "codex", status: errors.length === 0 ? "ok" : "partial",
    source: { method: "codex-app-server", stability: "supported", providerVersion: info.providerVersion },
    account: { plan: (raw.rateLimits.planType ?? info.account?.planType ?? null)?.toLowerCase() ?? null, authMode: info.account?.type ?? null },
    availability: availability(raw, limits), limits, credits,
    resetCredits: raw.rateLimitResetCredits == null ? null : { availableCount: Number(raw.rateLimitResetCredits.availableCount) },
    analytics: info.analytics == null ? null : analytics(info.analytics, warnings), errors, warnings,
  };
}
