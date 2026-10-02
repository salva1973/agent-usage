import { describe, expect, test } from "vitest";
import { makeIssue } from "../../src/domain/issues.js";
import { UsageReportSchema } from "../../src/domain/reportSchema.js";
import { normalizeCodexUsage, type CodexNormalizationInfo } from "../../src/providers/codex/normalize.js";
import {
  GetAccountRateLimitsResponseSchema, GetAccountResponseSchema, GetAccountTokenUsageResponseSchema, InitializeResultSchema,
} from "../../src/providers/codex/schema.js";
import type { UntimedProviderReport } from "../../src/providers/types.js";
import { fixture, fixedNow } from "../helpers/codex.js";

const account = GetAccountResponseSchema.parse(fixture("account-chatgpt.json")).account;
const info: CodexNormalizationInfo = { account, providerVersion: "0.159.2" };
const expectedBase = {
  provider: "codex", status: "ok",
  source: { method: "codex-app-server", stability: "supported", providerVersion: "0.159.2" },
  account: { plan: "plus", authMode: "chatgpt" },
  availability: { state: "available", basis: "provider_flag", reason: null, exhaustedLimitIds: [] },
  limits: [
    { id: "session", kind: "session", scope: { type: "account" }, label: "5h", usedPercent: 12, remainingPercent: 88,
      windowMinutes: 300, windowSource: "reported", resetsAt: "2026-10-01T19:12:00.000Z", providerKey: "rateLimits.primary" },
    { id: "weekly", kind: "weekly", scope: { type: "account" }, label: "Weekly", usedPercent: 41, remainingPercent: 59,
      windowMinutes: 10080, windowSource: "reported", resetsAt: "2026-10-05T08:30:00.000Z", providerKey: "rateLimits.secondary" },
  ],
  credits: [{ id: "codex_credits", label: "Credits", unit: { type: "provider_credits" }, balance: "318.2716000000",
    used: null, limit: null, usedPercent: null, unlimited: false, hasCredits: true, enabled: null, disabledReason: null, providerKey: "rateLimits.credits" }],
  resetCredits: { availableCount: 3 }, analytics: null, errors: [], warnings: [],
} satisfies UntimedProviderReport;

function validate(report: UntimedProviderReport): void {
  const full = { ...report, fetchedAt: fixedNow, durationMs: 0 };
  expect(UsageReportSchema.parse({ schemaVersion: 1, tool: { name: "agent-usage", version: "0.1.0" }, generatedAt: fixedNow, providers: [full] }).providers[0]).toEqual(full);
  expect(report).not.toHaveProperty("raw");
}

function normalize(name = "ratelimits-plus.json", extra: Partial<CodexNormalizationInfo> = {}) {
  const raw = GetAccountRateLimitsResponseSchema.parse(fixture(name));
  const before = structuredClone(raw);
  const result = normalizeCodexUsage(raw, { ...info, ...extra });
  expect(raw).toEqual(before);
  validate(result);
  return result;
}

test("Plus fixture equals the complete Section 12.2 Codex example without timing", () => {
  expect(normalize()).toEqual(expectedBase);
});

test("reached fixture preserves the explicit provider flag and exhausted ids", () => {
  expect(normalize("ratelimits-reached.json")).toEqual({
    ...expectedBase,
    availability: { state: "limited", basis: "provider_flag", reason: "rate_limit_reached", exhaustedLimitIds: ["session"] },
    limits: [{ ...expectedBase.limits[0], usedPercent: 100, remainingPercent: 0 }, expectedBase.limits[1]],
  });
});

test("null flags fixture derives account-wide weekly exhaustion", () => {
  expect(normalize("ratelimits-nullflags.json")).toEqual({
    ...expectedBase,
    availability: { state: "limited", basis: "derived_from_limits", reason: "limit_exhausted:weekly", exhaustedLimitIds: ["weekly"] },
    limits: [expectedBase.limits[0], { ...expectedBase.limits[1], usedPercent: 100, remainingPercent: 0 }],
  });
});

test("multibucket fixture has account defaults and first-class extra bucket scopes and ids", () => {
  const scope = { type: "bucket", bucket: "codex_other", name: "GPT-5.x-Codex-Spark", model: "gpt-5.x-codex-spark" };
  expect(normalize("ratelimits-multibucket.json")).toEqual({
    ...expectedBase, limits: [...expectedBase.limits,
      { ...expectedBase.limits[0], id: "session:bucket:codex_other", scope, usedPercent: 50, remainingPercent: 50, providerKey: "rateLimitsByLimitId.codex_other.primary" },
      { ...expectedBase.limits[1], id: "weekly:bucket:codex_other", scope, providerKey: "rateLimitsByLimitId.codex_other.secondary" },
    ],
  });
});

test("sparse fixture skips null windows, omits unknown credits, and reports spend control without its raw amounts", () => {
  expect(normalize("ratelimits-sparse.json")).toEqual({
    ...expectedBase, credits: [], resetCredits: null, limits: [expectedBase.limits[1],
      { id: "spend_control", kind: "spend_control", scope: { type: "account" }, label: "Spend cap", usedPercent: 25, remainingPercent: 75,
        windowMinutes: null, windowSource: "unknown", resetsAt: "2026-10-05T08:30:00.000Z", providerKey: "individualLimit" },
    ],
  });
});

test("millisecond fixture preserves the same UTC resets and emits one warning per timestamp", () => {
  expect(normalize("ratelimits-ms-timestamps.json")).toEqual({
    ...expectedBase, warnings: Array.from({ length: 2 }, () => makeIssue("timestamp_unit_heuristic", "Epoch timestamp was interpreted as milliseconds.")),
  });
});

test("analytics fixture maps the summary, sorts daily buckets, ignores thread data, and preserves its input", () => {
  const usage = GetAccountTokenUsageResponseSchema.parse(fixture("usage.json"));
  const before = structuredClone(usage);
  expect(normalize("ratelimits-plus.json", { analytics: usage })).toEqual({
    ...expectedBase, analytics: {
      lifetimeTokens: 1846203917, peakDailyTokens: 64820000, longestRunningTurnSec: 132, currentStreakDays: 5, longestStreakDays: 12,
      daily: [
        { date: "2026-09-27", tokens: 2000 }, { date: "2026-09-28", tokens: 4000 }, { date: "2026-09-29", tokens: 5000 },
        { date: "2026-09-30", tokens: 3000 }, { date: "2026-10-01", tokens: 1000 },
      ],
    },
  });
  expect(usage).toEqual(before);
});

test("unsafe or invalid analytics integers become warnings, null summary fields and omitted daily buckets", () => {
  const usage = GetAccountTokenUsageResponseSchema.parse(fixture("usage.json"));
  usage.summary.lifetimeTokens = Number.MAX_SAFE_INTEGER + 1;
  usage.summary.peakDailyTokens = 1.5;
  usage.dailyUsageBuckets![0]!.tokens = Number.MAX_SAFE_INTEGER + 1;
  const report = normalize("ratelimits-plus.json", { analytics: usage });
  expect(report.analytics?.lifetimeTokens).toBeNull();
  expect(report.analytics?.peakDailyTokens).toBeNull();
  expect(report.analytics?.daily).toHaveLength(4);
  expect(report.warnings.map((warning) => warning.code)).toEqual(["precision_loss", "precision_loss", "invalid_number"]);
});

describe("raw schemas and privacy", () => {
  test.each(["ratelimits-malformed.json", "ratelimits-missing.json"])("%s is a core schema failure", (name) => {
    expect(GetAccountRateLimitsResponseSchema.safeParse(fixture(name)).success).toBe(false);
  });
  test("initialize and account fixtures discard PII at parse time", () => {
    expect(InitializeResultSchema.parse(fixture("initialize.json"))).toEqual({ userAgent: "codex_cli_rs/0.159.2 (Linux; aarch64)" });
    expect(GetAccountResponseSchema.parse(fixture("account-chatgpt.json"))).toEqual({ account: { type: "chatgpt", planType: "plus" } });
    expect(GetAccountResponseSchema.parse(fixture("account-none.json"))).toEqual({ account: null });
    expect(GetAccountResponseSchema.parse(fixture("account-apikey.json"))).toEqual({ account: { type: "apiKey", planType: undefined } });
    expect(GetAccountRateLimitsResponseSchema.parse(fixture("ratelimits-plus.json"))).not.toHaveProperty("accountId");
    expect(GetAccountRateLimitsResponseSchema.parse(fixture("ratelimits-plus.json")).rateLimitResetCredits).toEqual({ availableCount: 3 });
    expect(fixture("error-unauth.json")).toEqual({ code: -32600, message: "codex account authentication required to read rate limits" });
  });
  test("nullable and optional protocol fields stay unknown, while unknown fields are accepted", () => {
    const raw = GetAccountRateLimitsResponseSchema.parse({ rateLimits: { primary: null, extra: "allowed" }, arbitrary: true });
    const report = normalizeCodexUsage(raw, { account: null, providerVersion: null });
    validate(report);
    expect(report.limits).toEqual([]);
    expect(report.credits).toEqual([]);
    expect(report.resetCredits).toBeNull();
    expect(report.account).toEqual({ plan: null, authMode: null });
    expect(report.availability).toEqual({ state: "unknown", basis: "none", reason: null, exhaustedLimitIds: [] });
  });
});

describe("availability priority", () => {
  test.each([
    [{ rateLimitReachedType: "reached", ordinaryUsageAllowed: true, spendControlReached: true }, "limited", "provider_flag", "reached"],
    [{ ordinaryUsageAllowed: false, spendControlReached: true }, "limited", "provider_flag", "ordinary_usage_not_allowed"],
    [{ ordinaryUsageAllowed: true, spendControlReached: true }, "limited", "provider_flag", "spend_control_reached"],
    [{ ordinaryUsageAllowed: true }, "available", "provider_flag", null],
    [{ ordinaryUsageAllowed: null }, "available", "derived_from_limits", null],
  ])("applies flags %j", (flags, state, basis, reason) => {
    const raw = GetAccountRateLimitsResponseSchema.parse(fixture("ratelimits-plus.json"));
    Object.assign(raw, flags);
    const report = normalizeCodexUsage(raw, info);
    validate(report);
    expect(report.availability).toEqual({ state, basis, reason, exhaustedLimitIds: [] });
  });
  test("explicit available wins over percentages but records all exhausted limits", () => {
    const raw = GetAccountRateLimitsResponseSchema.parse(fixture("ratelimits-multibucket.json"));
    raw.rateLimitsByLimitId!.codex!.primary!.usedPercent = 100;
    raw.rateLimitsByLimitId!.codex_other!.primary!.usedPercent = 150;
    expect(normalizeCodexUsage(raw, info).availability).toEqual({
      state: "available", basis: "provider_flag", reason: null, exhaustedLimitIds: ["session", "session:bucket:codex_other"],
    });
  });
  test("bucket exhaustion alone is recorded without making derived availability limited", () => {
    const raw = GetAccountRateLimitsResponseSchema.parse(fixture("ratelimits-multibucket.json"));
    raw.ordinaryUsageAllowed = null;
    raw.rateLimitsByLimitId!.codex_other!.primary!.usedPercent = 100;
    expect(normalizeCodexUsage(raw, info).availability).toEqual({
      state: "available", basis: "derived_from_limits", reason: null, exhaustedLimitIds: ["session:bucket:codex_other"],
    });
  });
});

describe("windows, numbers and ids", () => {
  test("classifies windows by duration even when primary and secondary are swapped", () => {
    const raw = GetAccountRateLimitsResponseSchema.parse(fixture("ratelimits-plus.json"));
    raw.rateLimitsByLimitId = null;
    raw.rateLimits.primary!.windowDurationMins = 10080;
    raw.rateLimits.secondary!.windowDurationMins = 300;
    expect(normalizeCodexUsage(raw, info).limits).toEqual([
      { ...expectedBase.limits[0], id: "weekly", kind: "weekly", label: "Weekly", windowMinutes: 10080 },
      { ...expectedBase.limits[1], id: "session", kind: "session", label: "5h", windowMinutes: 300 },
    ]);
  });
  test.each([[90, "90m"], [480, "8h"], [4320, "3d"], [null, "Primary"]])("other duration %s is reported without inventing a window", (minutes, label) => {
    const raw = GetAccountRateLimitsResponseSchema.parse(fixture("ratelimits-plus.json"));
    raw.rateLimitsByLimitId = {};
    raw.rateLimits.primary!.windowDurationMins = minutes;
    const report = normalizeCodexUsage(raw, info);
    validate(report);
    expect(report.limits[0]).toEqual({ ...expectedBase.limits[0], id: "other:ratelimits_primary", kind: "other", label,
      windowMinutes: minutes, windowSource: minutes === null ? "unknown" : "reported" });
  });
  test.each([[12.345, 12.35, 87.65], [120, 120, 0], [-5, -5, 100]])("percent %s is rounded without clamping used usage", (input, usedPercent, remainingPercent) => {
    const raw = GetAccountRateLimitsResponseSchema.parse(fixture("ratelimits-plus.json"));
    raw.rateLimitsByLimitId = null;
    raw.rateLimits.primary!.usedPercent = input;
    const report = normalizeCodexUsage(raw, info);
    validate(report);
    expect(report.limits[0]).toMatchObject({ usedPercent, remainingPercent });
  });
  test("invalid percentages and timestamps warn and stay unknown", () => {
    const raw = GetAccountRateLimitsResponseSchema.parse(fixture("ratelimits-plus.json"));
    raw.rateLimitsByLimitId = null;
    raw.rateLimits.primary!.usedPercent = NaN;
    raw.rateLimits.primary!.resetsAt = 0;
    const report = normalizeCodexUsage(raw, info);
    validate(report);
    expect(report.limits[0]).toMatchObject({ usedPercent: null, remainingPercent: null, resetsAt: null });
    expect(report.warnings.map((warning) => warning.code)).toEqual(["invalid_number", "invalid_timestamp"]);
  });
  test("limit-id collisions suffix later windows and warn", () => {
    const raw = GetAccountRateLimitsResponseSchema.parse(fixture("ratelimits-plus.json"));
    raw.rateLimitsByLimitId = null;
    raw.rateLimits.secondary!.windowDurationMins = 300;
    const report = normalizeCodexUsage(raw, info);
    expect(report.limits.map((limit) => limit.id)).toEqual(["session", "session#2"]);
    expect(report.warnings.map((warning) => warning.code)).toEqual(["duplicate_limit_id"]);
  });
  test("the matching limitId wins over codex and default windows come first", () => {
    const raw = GetAccountRateLimitsResponseSchema.parse(fixture("ratelimits-multibucket.json"));
    raw.rateLimits.limitId = "codex_other";
    const report = normalizeCodexUsage(raw, info);
    expect(report.limits.map((limit) => limit.id)).toEqual(["session", "weekly", "session:bucket:codex", "weekly:bucket:codex"]);
    expect(report.limits[0]?.usedPercent).toBe(50);
  });
  test("an unmatched limitId uses codex as the default", () => {
    const raw = GetAccountRateLimitsResponseSchema.parse(fixture("ratelimits-multibucket.json"));
    raw.rateLimits.limitId = "missing";
    expect(normalizeCodexUsage(raw, info).limits[0]?.usedPercent).toBe(12);
  });
});

test.each(["318.2716000000", "-1.000", "000.10"])("credit balance %s is verbatim opaque provider credits", (balance) => {
  const raw = GetAccountRateLimitsResponseSchema.parse(fixture("ratelimits-plus.json"));
  raw.rateLimits.credits!.balance = balance;
  const report = normalizeCodexUsage(raw, info);
  validate(report);
  expect(report.credits[0]).toEqual({ ...expectedBase.credits[0], balance });
});

test("an invalid decimal balance becomes null with an invalid_number warning", () => {
  const raw = GetAccountRateLimitsResponseSchema.parse(fixture("ratelimits-plus.json"));
  raw.rateLimits.credits!.balance = "not money";
  const report = normalizeCodexUsage(raw, info);
  validate(report);
  expect(report.credits[0]?.balance).toBeNull();
  expect(report.warnings.map((warning) => warning.code)).toEqual(["invalid_number"]);
});

test("account plan fallback is lowercased and a failed account read leaves only auth mode unknown", () => {
  expect(normalize("ratelimits-plus.json", { account: null }).account).toEqual({ plan: "plus", authMode: null });
  const raw = GetAccountRateLimitsResponseSchema.parse(fixture("ratelimits-plus.json"));
  raw.rateLimits.planType = null;
  expect(normalizeCodexUsage(raw, { ...info, account: { type: "chatgpt", planType: "PLUS" } }).account).toEqual({ plan: "plus", authMode: "chatgpt" });
});

test("analytics errors produce partial while leaving core observations intact", () => {
  const error = makeIssue("analytics_failed", "Codex analytics failed (upstream_error).", { retryable: true });
  expect(normalize("ratelimits-plus.json", { errors: [error] })).toEqual({ ...expectedBase, status: "partial", errors: [error] });
});
