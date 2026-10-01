import { deriveAvailability } from "../../domain/availability.js";
import { LimitIdAllocator, slug } from "../../domain/ids.js";
import { makeIssue } from "../../domain/issues.js";
import type { CreditBalance, LimitScope, ProviderIssue, RateLimit } from "../../domain/model.js";
import { clamp, round2, toDecimal } from "../../domain/numbers.js";
import { isoOrNull } from "../../domain/time.js";
import type { UntimedProviderReport } from "../types.js";
import type { ClaudeAuthStatus } from "./authStatus.js";
import { ClaudeExtraUsageSchema, ClaudeModelWindowSchema, ClaudeWindowSchema, type ClaudeUsageResponse, type ClaudeWindow } from "./schema.js";

const namedWindows: readonly { key: string; id: string; kind: "session" | "weekly"; scope: LimitScope; label: string; minutes: number }[] = [
  { key: "five_hour", id: "session", kind: "session", scope: { type: "account" }, label: "5h", minutes: 300 },
  { key: "seven_day", id: "weekly", kind: "weekly", scope: { type: "account" }, label: "Weekly", minutes: 10080 },
  { key: "seven_day_opus", id: "weekly:model:opus", kind: "weekly", scope: { type: "model", model: "opus" }, label: "Weekly (Opus)", minutes: 10080 },
  { key: "seven_day_sonnet", id: "weekly:model:sonnet", kind: "weekly", scope: { type: "model", model: "sonnet" }, label: "Weekly (Sonnet)", minutes: 10080 },
  { key: "seven_day_oauth_apps", id: "weekly:product:oauth_apps", kind: "weekly", scope: { type: "product", product: "oauth_apps" }, label: "Weekly (OAuth apps)", minutes: 10080 },
  { key: "seven_day_cowork", id: "weekly:product:cowork", kind: "weekly", scope: { type: "product", product: "cowork" }, label: "Weekly (Cowork)", minutes: 10080 },
];
const reserved = new Set([...namedWindows.map((row) => row.key), "extra_usage", "limits", "spend", "model_scoped", "seven_day_breakdown", "member_dashboard_available"]);

export interface ClaudeNormalizationOptions {
  providerVersion: string | null;
  includeAnalytics: boolean;
  authStatus?: ClaudeAuthStatus | null;
}

function percent(value: number | null | undefined, warnings: ProviderIssue[]): number | null {
  if (value == null) return null;
  if (Number.isFinite(value)) return round2(value);
  warnings.push(makeIssue("invalid_number", "Claude utilization must be finite."));
  return null;
}

/** Normalize only validated Claude observations, with no I/O or provider payloads in the result. */
export function normalizeClaudeUsage(data: ClaudeUsageResponse, options: ClaudeNormalizationOptions): Extract<UntimedProviderReport, { status: "ok" }> {
  const limits: RateLimit[] = [];
  const credits: CreditBalance[] = [];
  const warnings: ProviderIssue[] = [];
  const allocator = new LimitIdAllocator();
  const raw = data.rate_limits ?? {};
  function broken(key: string): void { warnings.push(makeIssue("invalid_window", `Malformed Claude usage field ${key} was skipped.`)); }
  function add(window: ClaudeWindow, definition: Omit<RateLimit, "id" | "usedPercent" | "remainingPercent" | "resetsAt"> & { id: string }): void {
    const usedPercent = percent(window.utilization, warnings);
    limits.push({ ...definition, id: allocator.allocate(definition.id, warnings), usedPercent,
      remainingPercent: usedPercent === null ? null : round2(clamp(100 - usedPercent, 0, 100)),
      resetsAt: isoOrNull(window.resets_at, warnings) });
  }
  for (const row of namedWindows) {
    if (raw[row.key] == null) continue;
    const parsed = ClaudeWindowSchema.safeParse(raw[row.key]);
    if (!parsed.success) { broken(row.key); continue; }
    add(parsed.data, { id: row.id, kind: row.kind, scope: row.scope, label: row.label,
      windowMinutes: row.minutes, windowSource: "inferred", providerKey: `rate_limits.${row.key}` });
  }
  const namedIds = new Set(limits.map((limit) => limit.id));
  if (raw.model_scoped != null) {
    if (!Array.isArray(raw.model_scoped)) broken("model_scoped");
    else raw.model_scoped.forEach((value: unknown, index: number) => {
      const parsed = ClaudeModelWindowSchema.safeParse(value);
      if (!parsed.success) { broken(`model_scoped.${index}`); return; }
      const model = slug(parsed.data.display_name);
      const id = `weekly:model:${model}`;
      if (namedIds.has(id)) return;
      add(parsed.data, { id, kind: "weekly", scope: { type: "model", model }, label: `Weekly (${parsed.data.display_name})`,
        windowMinutes: 10080, windowSource: "inferred", providerKey: `rate_limits.model_scoped.${index}` });
    });
  }
  for (const [key, value] of Object.entries(raw)) {
    if (reserved.has(key) || value == null || typeof value !== "object" || Array.isArray(value)) continue;
    // Unknown objects only count as windows if both defining fields exist;
    // empty metadata objects must not turn into fabricated limits.
    if (!("utilization" in value) || !("resets_at" in value)) continue;
    const parsed = ClaudeWindowSchema.safeParse(value);
    if (!parsed.success) continue;
    warnings.push(makeIssue("unknown_limit_key", `Unknown Claude rate-limit key ${key}.`));
    add(parsed.data, { id: `other:${slug(key)}`, kind: "other", scope: { type: "bucket", bucket: key, name: null, model: null },
      label: key, windowMinutes: null, windowSource: "unknown", providerKey: `rate_limits.${key}` });
  }
  if (raw.extra_usage != null) {
    const parsed = ClaudeExtraUsageSchema.safeParse(raw.extra_usage);
    if (!parsed.success) broken("extra_usage");
    else {
      const extra = parsed.data;
      const currency = extra.currency != null && /^[A-Za-z]{3}$/.test(extra.currency) ? extra.currency.toUpperCase() : null;
      const dp = extra.decimal_places;
      const validDp = dp !== undefined && Number.isInteger(dp) && dp >= 0 && dp <= 6;
      if (currency === null || !validDp) warnings.push(makeIssue("ambiguous_units", "Claude extra usage requires a valid currency and decimal_places from 0 to 6."));
      credits.push({
        id: "claude_extra_usage", label: "Extra usage", unit: currency === null ? { type: "provider_credits" } : { type: "currency", currency },
        balance: null, used: currency !== null && validDp ? toDecimal(extra.used_credits, dp, warnings) : null,
        limit: currency !== null && validDp ? toDecimal(extra.monthly_limit, dp, warnings) : null,
        usedPercent: percent(extra.utilization, warnings), unlimited: null, hasCredits: null,
        enabled: extra.is_enabled, disabledReason: extra.disabled_reason ?? null, providerKey: "rate_limits.extra_usage",
      });
    }
  }
  if (options.includeAnalytics) warnings.push(makeIssue("analytics_not_supported", "Claude token analytics are not supported."));
  return {
    provider: "claude", status: "ok",
    source: { method: "claude-control-get-usage", stability: "experimental", providerVersion: options.providerVersion },
    account: { plan: data.subscription_type?.toLowerCase() ?? null, authMode: data.rate_limits_available ? "claude.ai" : options.authStatus?.authMethod ?? null },
    availability: deriveAvailability(limits, "derived_from_limits"), limits, credits, resetCredits: null, analytics: null, errors: [], warnings,
  };
}
