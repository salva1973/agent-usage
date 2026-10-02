import { expect, test } from "vitest";
import { z } from "zod";
import { ProviderReportSchema } from "../../src/domain/reportSchema.js";
import { normalizeClaudeUsage } from "../../src/providers/claude/normalize.js";
import { GetUsageResponseSchema } from "../../src/providers/claude/schema.js";
import { fixedNow, fixture } from "../helpers/claude.js";

const options = { providerVersion: "2.1.286", includeAnalytics: false };
function normalize(value: unknown = fixture("get-usage-pro.json"), overrides = {}) {
  const report = normalizeClaudeUsage(GetUsageResponseSchema.parse(value), { ...options, ...overrides });
  expect(ProviderReportSchema.parse({ ...report, fetchedAt: fixedNow, durationMs: 0 })).toEqual({ ...report, fetchedAt: fixedNow, durationMs: 0 });
  expect(JSON.stringify(report)).not.toMatch(/FIXTURE|example\.invalid|behaviors|"raw"|\/home\/user/);
  return report;
}
function withLimits(rate_limits: unknown) { return { subscription_type: "pro", rate_limits_available: true, rate_limits }; }
function proLimits() { return z.record(z.string(), z.unknown()).parse(GetUsageResponseSchema.parse(fixture("get-usage-pro.json")).rate_limits); }

test("pro fixture matches the complete Claude example in SPEC.md §12.2", () => {
  expect(normalize()).toEqual({
    provider: "claude", status: "ok",
    source: { method: "claude-control-get-usage", stability: "experimental", providerVersion: "2.1.286" },
    account: { plan: "pro", authMode: "claude.ai" },
    availability: { state: "available", basis: "derived_from_limits", reason: null, exhaustedLimitIds: [] },
    limits: [
      { id: "session", kind: "session", scope: { type: "account" }, label: "5h", usedPercent: 7, remainingPercent: 93,
        windowMinutes: 300, windowSource: "inferred", resetsAt: "2026-10-01T18:00:00.214Z", providerKey: "rate_limits.five_hour" },
      { id: "weekly", kind: "weekly", scope: { type: "account" }, label: "Weekly", usedPercent: 26, remainingPercent: 74,
        windowMinutes: 10080, windowSource: "inferred", resetsAt: "2026-10-07T09:00:00.214Z", providerKey: "rate_limits.seven_day" },
    ],
    credits: [{ id: "claude_extra_usage", label: "Extra usage", unit: { type: "currency", currency: "USD" },
      balance: null, used: "12.50", limit: "50.00", usedPercent: 25, unlimited: null, hasCredits: null,
      enabled: false, disabledReason: "out_of_credits", providerKey: "rate_limits.extra_usage" }],
    resetCredits: null, analytics: null, errors: [], warnings: [],
  });
});

test("scenario fixtures retain the real capture fields except the required scenario changes", () => {
  const pro = z.record(z.string(), z.unknown()).parse(fixture("get-usage-pro.json"));
  const rateLimits = z.record(z.string(), z.unknown()).parse(pro.rate_limits);
  const window = z.record(z.string(), z.unknown()).parse(rateLimits.five_hour);
  const extra = z.record(z.string(), z.unknown()).parse(rateLimits.extra_usage);
  expect(fixture("get-usage-exhausted.json")).toEqual({ ...pro, rate_limits: { ...rateLimits, five_hour: { ...window, utilization: 100 } } });
  const { decimal_places: _removed, ...withoutDp } = extra;
  expect(fixture("get-usage-bad-extra.json")).toEqual({ ...pro, rate_limits: { ...rateLimits, extra_usage: { ...withoutDp, currency: null } } });
  expect(fixture("get-usage-fetch-failed.json")).toEqual({ ...pro, rate_limits: null });
  const scoped = GetUsageResponseSchema.parse(fixture("get-usage-max-scoped.json")).rate_limits;
  const scenarioKeys = new Set(["seven_day_opus", "seven_day_sonnet", "seven_day_oauth_apps", "seven_day_cowork", "model_scoped", "nimbus_quill"]);
  for (const [key, value] of Object.entries(rateLimits)) if (!scenarioKeys.has(key)) expect(scoped?.[key]).toEqual(value);
  expect(pro).toHaveProperty("session");
  expect(rateLimits).toHaveProperty("seven_day_breakdown");
  expect(rateLimits).toHaveProperty("spend");
  expect(window).toHaveProperty("locked_reason");
  expect(window).toHaveProperty("remaining_dollars");
});

test("all named scoped windows, model_scoped dedupe and unknown windows have the specified identities", () => {
  const report = normalize(fixture("get-usage-max-scoped.json"));
  expect(report.account?.plan).toBe("max");
  expect(report.limits.map((limit) => limit.id)).toEqual([
    "session", "weekly", "weekly:model:opus", "weekly:model:sonnet", "weekly:product:oauth_apps", "weekly:product:cowork", "weekly:model:fable", "other:nimbus_quill",
  ]);
  expect(report.limits[2]).toMatchObject({ scope: { type: "model", model: "opus" }, usedPercent: 100 });
  expect(report.limits[4]).toMatchObject({ scope: { type: "product", product: "oauth_apps" }, label: "Weekly (OAuth apps)" });
  expect(report.limits[5]).toMatchObject({ scope: { type: "product", product: "cowork" }, label: "Weekly (Cowork)" });
  expect(report.limits[6]).toMatchObject({ scope: { type: "model", model: "fable" }, label: "Weekly (Fable)", windowSource: "inferred", windowMinutes: 10080 });
  expect(report.limits[7]).toEqual({ id: "other:nimbus_quill", kind: "other", scope: { type: "bucket", bucket: "nimbus_quill", name: null, model: null },
    label: "nimbus_quill", usedPercent: 5, remainingPercent: 95, windowMinutes: null, windowSource: "unknown",
    resetsAt: "2026-10-07T09:00:00.214Z", providerKey: "rate_limits.nimbus_quill" });
  expect(report.warnings.map((issue) => issue.code)).toEqual(["unknown_limit_key"]);
  expect(report.availability).toEqual({ state: "available", basis: "derived_from_limits", reason: null, exhaustedLimitIds: ["weekly:model:opus"] });
});

test("account exhaustion limits availability", () => {
  expect(normalize(fixture("get-usage-exhausted.json")).availability).toEqual({
    state: "limited", basis: "derived_from_limits", reason: "limit_exhausted:session", exhaustedLimitIds: ["session"],
  });
});

test("ambiguous extra-usage units never fabricate currency or amounts", () => {
  const report = normalize(fixture("get-usage-bad-extra.json"));
  expect(report.credits[0]).toMatchObject({ unit: { type: "provider_credits" }, used: null, limit: null, balance: null, usedPercent: 25 });
  expect(report.warnings.map((issue) => issue.code)).toEqual(["ambiguous_units"]);
  expect(report.status).toBe("ok");
});

test.each([undefined, -1, 7, 1.5])("invalid decimal_places %s leaves currency amounts unknown", (decimal_places) => {
  const report = normalize(withLimits({ extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 12, currency: "usd", decimal_places } }));
  expect(report.credits[0]).toMatchObject({ unit: { type: "currency", currency: "USD" }, used: null, limit: null });
  expect(report.warnings[0]?.code).toBe("ambiguous_units");
});

test.each([null, "USDO", "", "123"])("invalid currency %s does not expose amounts", (currency) => {
  const report = normalize(withLimits({ extra_usage: { is_enabled: false, monthly_limit: 5000, used_credits: 0, currency, decimal_places: 2 } }));
  expect(report.credits[0]).toMatchObject({ unit: { type: "provider_credits" }, used: null, limit: null });
  expect(report.warnings[0]?.code).toBe("ambiguous_units");
});

test.each([[0, "5000", "1250"], [2, "50.00", "12.50"], [6, "0.005000", "0.001250"]])("valid decimal_places %s uses string money conversion", (decimal_places, limit, used) => {
  const report = normalize(withLimits({ extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, currency: "usd", decimal_places } }));
  expect(report.credits[0]).toMatchObject({ unit: { type: "currency", currency: "USD" }, used, limit, enabled: true, disabledReason: null });
});

test.each([[Number.MAX_SAFE_INTEGER + 1, "precision_loss"], [-1, "invalid_number"], [1.25, "invalid_number"]])("unsafe monetary count %s is unknown", (value, code) => {
  const report = normalize(withLimits({ extra_usage: { is_enabled: true, monthly_limit: value, used_credits: null, currency: "USD", decimal_places: 2 } }));
  expect(report.credits[0]?.limit).toBeNull();
  expect(report.warnings.map((issue) => issue.code)).toContain(code);
});

test.each([0.123456, 125, -5, null])("utilization %s remains on the 0–100 scale, rounded, with bounded remaining", (utilization) => {
  const limit = normalize(withLimits({ five_hour: { utilization, resets_at: null } })).limits[0];
  expect(limit?.usedPercent).toBe(utilization === 0.123456 ? 0.12 : utilization);
  expect(limit?.remainingPercent).toBe(utilization === null ? null : utilization === 125 ? 0 : utilization === -5 ? 100 : 99.88);
});

test.each([
  ["2026-10-01T20:00:00.214999+02:00", "2026-10-01T18:00:00.214Z", null],
  ["not-a-time", null, "invalid_timestamp"], [null, null, null],
])("timestamp %s converts to UTC milliseconds or emits a warning", (resets_at, expected, code) => {
  const report = normalize(withLimits({ five_hour: { utilization: 2, resets_at } }));
  expect(report.limits[0]?.resetsAt).toBe(expected);
  expect(report.warnings.map((issue) => issue.code)).toEqual(code === null ? [] : [code]);
});

test.each(["high", [], { utilization: "high" }, { resets_at: 123 }])("broken individual window %j is skipped without failing other windows", (five_hour) => {
  const report = normalize(withLimits({ ...proLimits(), five_hour }));
  expect(report.limits.map((limit) => limit.id)).toEqual(["weekly"]);
  expect(report.warnings.map((issue) => issue.code)).toEqual(["invalid_window"]);
  expect(report.status).toBe("ok");
});

test("sparse windows preserve unknown fields as null", () => {
  expect(normalize(withLimits({ five_hour: {} })).limits[0]).toMatchObject({ usedPercent: null, remainingPercent: null, resetsAt: null });
});

test.each([NaN, Infinity, -Infinity])("nonfinite utilization %s is skipped with a warning", (utilization) => {
  const report = normalize(withLimits({ ...proLimits(), five_hour: { utilization, resets_at: null } }));
  expect(report.limits.map((limit) => limit.id)).toEqual(["weekly"]);
  expect(report.warnings[0]?.code).toBe("invalid_window");
});

test("empty limits have unknown availability with derived basis", () => {
  expect(normalize(withLimits({})).availability).toEqual({ state: "unknown", basis: "derived_from_limits", reason: null, exhaustedLimitIds: [] });
});

test("reserved metadata and null/invalid unknown windows do not become limits", () => {
  const report = normalize(withLimits({ limits: [{ utilization: 100 }], spend: { utilization: 100, resets_at: null },
    seven_day_breakdown: { utilization: 100, resets_at: null }, member_dashboard_available: true,
    tangelo: null, metadata: {}, other: { utilization: "high", resets_at: null }, scalar: 4 }));
  expect(report.limits).toEqual([]);
  expect(report.warnings).toEqual([]);
});

test("malformed model entries and extras emit warnings, without losing core windows", () => {
  const report = normalize(withLimits({ ...proLimits(), model_scoped: [null, { display_name: 123 }, { display_name: "Fable", utilization: 10 }], extra_usage: {} }));
  expect(report.limits.map((limit) => limit.id)).toEqual(["session", "weekly", "weekly:model:fable"]);
  expect(report.credits).toEqual([]);
  expect(report.warnings.map((issue) => issue.code)).toEqual(["invalid_window", "invalid_window", "invalid_window"]);
  expect(normalize(withLimits({ model_scoped: {} })).warnings[0]?.code).toBe("invalid_window");
});

test("colliding unknown keys and model names have unique ids with warnings", () => {
  const report = normalize(withLimits({ model_scoped: [{ display_name: "Fable", utilization: 10 }, { display_name: "FABLE", utilization: 20 }],
    "new-key": { utilization: 1, resets_at: null }, new_key: { utilization: 2, resets_at: null } }));
  expect(report.limits.map((limit) => limit.id)).toEqual(["weekly:model:fable", "weekly:model:fable#2", "other:new_key", "other:new_key#2"]);
  expect(report.warnings.filter((issue) => issue.code === "duplicate_limit_id")).toHaveLength(2);
  expect(report.warnings.filter((issue) => issue.code === "unknown_limit_key")).toHaveLength(2);
});

test("analytics request adds only an informational warning", () => {
  const report = normalize(undefined, { includeAnalytics: true });
  expect(report.status).toBe("ok");
  expect(report.analytics).toBeNull();
  expect(report.warnings.map((issue) => issue.code)).toEqual(["analytics_not_supported"]);
});

test("normalization is pure and does not mutate fixtures or retain extra PII fields", () => {
  const value = withLimits({ ...proLimits(), five_hour: { utilization: 2, resets_at: null, email: "leak@example.invalid", accountId: "FIXTURE" } });
  const before = JSON.stringify(value);
  expect(normalize(value)).toEqual(normalize(value));
  expect(JSON.stringify(value)).toBe(before);
  expect(normalize({ ...value, subscription_type: "PRO", account: { id: "FIXTURE" }, behaviors: { secret: "FIXTURE" } }).account?.plan).toBe("pro");
});
