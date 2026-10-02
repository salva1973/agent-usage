import { afterEach, expect, test, vi } from "vitest";
import { UsageReportSchema } from "../../src/index.js";
import { createDemoReport } from "../../src/cli/demo.js";

const options = { now: new Date("2026-10-01T13:40:00Z"), providers: ["codex", "claude"] as ("codex" | "claude")[],
  includeAnalytics: false, version: "0.1.1" };
const demoWarning = { code: "demo_data", message: "Synthetic demo data; no provider was contacted.", retryable: false, hint: null };
const analyticsWarning = { code: "analytics_not_supported", message: "Claude token analytics are not supported.", retryable: false, hint: null };
const iso = "2026-10-01T13:40:00.000Z";

afterEach(() => vi.useRealTimers());

test("demo deep-equals every normative field and validates without analytics", () => {
  const report = createDemoReport(options);
  expect(report).toEqual({ schemaVersion: 1, tool: { name: "agent-usage", version: "0.1.1" }, generatedAt: iso, providers: [
    {
      provider: "codex", status: "ok", fetchedAt: iso, durationMs: 0, errors: [], warnings: [demoWarning],
      source: { method: "codex-app-server", stability: "supported", providerVersion: null },
      account: { plan: "plus", authMode: "chatgpt" },
      availability: { state: "available", basis: "provider_flag", reason: null, exhaustedLimitIds: [] },
      limits: [
        { id: "session", kind: "session", scope: { type: "account" }, label: "5h", usedPercent: 37, remainingPercent: 63,
          windowMinutes: 300, windowSource: "reported", resetsAt: "2026-10-01T16:27:00.000Z", providerKey: "rateLimits.primary" },
        { id: "weekly", kind: "weekly", scope: { type: "account" }, label: "Weekly", usedPercent: 58, remainingPercent: 42,
          windowMinutes: 10080, windowSource: "reported", resetsAt: "2026-10-04T19:00:00.000Z", providerKey: "rateLimits.secondary" },
      ],
      credits: [{ id: "codex_credits", label: "Credits", unit: { type: "provider_credits" }, balance: "125.5000000000", used: null,
        limit: null, usedPercent: null, unlimited: false, hasCredits: true, enabled: null, disabledReason: null, providerKey: "rateLimits.credits" }],
      resetCredits: { availableCount: 1 }, analytics: null,
    },
    {
      provider: "claude", status: "ok", fetchedAt: iso, durationMs: 0, errors: [], warnings: [demoWarning],
      source: { method: "claude-control-get-usage", stability: "experimental", providerVersion: null },
      account: { plan: "max", authMode: "claude.ai" },
      availability: { state: "available", basis: "derived_from_limits", reason: null, exhaustedLimitIds: [] },
      limits: [
        { id: "session", kind: "session", scope: { type: "account" }, label: "5h", usedPercent: 64, remainingPercent: 36,
          windowMinutes: 300, windowSource: "inferred", resetsAt: "2026-10-01T15:05:00.000Z", providerKey: "rate_limits.five_hour" },
        { id: "weekly", kind: "weekly", scope: { type: "account" }, label: "Weekly", usedPercent: 82, remainingPercent: 18,
          windowMinutes: 10080, windowSource: "inferred", resetsAt: "2026-10-06T07:40:00.000Z", providerKey: "rate_limits.seven_day" },
        { id: "weekly:model:opus", kind: "weekly", scope: { type: "model", model: "opus" }, label: "Weekly (Opus)", usedPercent: 91, remainingPercent: 9,
          windowMinutes: 10080, windowSource: "inferred", resetsAt: "2026-10-06T07:40:00.000Z", providerKey: "rate_limits.seven_day_opus" },
      ],
      credits: [{ id: "claude_extra_usage", label: "Extra usage", unit: { type: "currency", currency: "USD" }, balance: null, used: "4.20",
        limit: "20.00", usedPercent: 21, unlimited: null, hasCredits: null, enabled: true, disabledReason: null, providerKey: "rate_limits.extra_usage" }],
      resetCredits: null, analytics: null,
    },
  ] });
  expect(UsageReportSchema.parse(report)).toEqual(report);
});

test("demo is deterministic and independent of the wall clock and leaves inputs unchanged", () => {
  const first = createDemoReport(options);
  expect(createDemoReport(options)).toEqual(first);
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2040-05-15T09:00:00Z"));
  expect(createDemoReport(options)).toEqual(first);
  expect(options.now.toISOString()).toBe(iso);
  expect(options.providers).toEqual(["codex", "claude"]);
});

test("demo preserves provider selection and order", () => {
  expect(createDemoReport({ ...options, providers: ["claude"] }).providers.map((p) => p.provider)).toEqual(["claude"]);
  expect(createDemoReport({ ...options, providers: ["claude", "codex"] }).providers.map((p) => p.provider)).toEqual(["claude", "codex"]);
});

test("analytics use normative counters and UTC daily buckets with ordered Claude warnings", () => {
  const report = createDemoReport({ ...options, includeAnalytics: true });
  expect(report.providers[0]!.analytics).toEqual({ lifetimeTokens: 742318905, peakDailyTokens: 38120447,
    longestRunningTurnSec: 5400, currentStreakDays: 4, longestStreakDays: 9, daily: [
      { date: "2026-09-25", tokens: 5210000 }, { date: "2026-09-26", tokens: 8432000 },
      { date: "2026-09-27", tokens: 3120500 }, { date: "2026-09-28", tokens: 12045000 },
      { date: "2026-09-29", tokens: 6730000 }, { date: "2026-09-30", tokens: 9981200 },
      { date: "2026-10-01", tokens: 4400300 },
    ] });
  expect(report.providers[1]!.analytics).toBeNull();
  expect(report.providers[1]!.warnings).toEqual([analyticsWarning, demoWarning]);
  expect(UsageReportSchema.parse(report)).toEqual(report);
  const boundary = createDemoReport({ ...options, includeAnalytics: true, now: new Date("2026-11-03T01:00:00Z") });
  expect(boundary.providers[0]!.analytics!.daily.map((bucket) => bucket.date)).toEqual([
    "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03",
  ]);
  expect(UsageReportSchema.parse(boundary)).toEqual(boundary);
});

test.each([false, true])("every provider carries exactly one demo warning and no acquired metadata (analytics=%s)", (includeAnalytics) => {
  for (const provider of createDemoReport({ ...options, includeAnalytics }).providers) {
    expect(provider.warnings.filter((warning) => warning.code === "demo_data")).toEqual([demoWarning]);
    expect(provider.source.providerVersion).toBeNull();
    expect(provider.durationMs).toBe(0);
  }
});

test("synthetic measurements exclude the fixture-derived values", () => {
  const report = createDemoReport({ ...options, includeAnalytics: true });
  const measurements = report.providers.flatMap((p) => [
    ...p.limits.flatMap((l) => [l.usedPercent, l.remainingPercent]),
    ...p.credits.flatMap((c) => [c.balance, c.used, c.limit, c.usedPercent]),
    ...(p.analytics === null ? [] : [p.analytics.lifetimeTokens, p.analytics.peakDailyTokens, ...p.analytics.daily.map((d) => d.tokens)]),
  ]);
  for (const value of [12, 41, 7, 26, "318.2716000000", "12.50", "50.00", 1846203917]) expect(measurements).not.toContain(value);
});
