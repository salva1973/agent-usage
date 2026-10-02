import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { UsageReport } from "../../../src/domain/model.js";
import { UsageReportSchema } from "../../../src/domain/reportSchema.js";

const addFormats = createRequire(import.meta.url)("ajv-formats") as FormatsPlugin;
const schemaPath = new URL("../../../schema/usage-report.v1.schema.json", import.meta.url);
const generated = z.toJSONSchema(UsageReportSchema, { target: "draft-2020-12", io: "input" });
const ajv = new Ajv2020({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(generated);

function fullReport(): UsageReport {
  return {
    schemaVersion: 1,
    tool: { name: "agent-usage", version: "0.1.0" },
    generatedAt: "2026-10-01T13:40:02.120Z",
    providers: [
      {
        provider: "codex", status: "ok", fetchedAt: "2026-10-01T13:40:01.050Z", durationMs: 1081,
        source: { method: "codex-app-server", stability: "supported", providerVersion: "0.159.2" },
        account: { plan: "plus", authMode: "chatgpt" },
        availability: { state: "available", basis: "provider_flag", reason: null, exhaustedLimitIds: [] },
        limits: [
          {
            id: "session", kind: "session", scope: { type: "account" }, label: "5h", usedPercent: 12,
            remainingPercent: 88, windowMinutes: 300, windowSource: "reported",
            resetsAt: "2026-10-01T19:12:00.000Z", providerKey: "rateLimits.primary",
          },
          {
            id: "weekly", kind: "weekly", scope: { type: "account" }, label: "Weekly", usedPercent: 41,
            remainingPercent: 59, windowMinutes: 10080, windowSource: "reported",
            resetsAt: "2026-10-05T08:30:00.000Z", providerKey: "rateLimits.secondary",
          },
          {
            id: "other:bucket:extra", kind: "other",
            scope: { type: "bucket", bucket: "extra", name: null, model: null }, label: "Extra",
            usedPercent: null, remainingPercent: null, windowMinutes: null, windowSource: "unknown",
            resetsAt: null, providerKey: "test.extra",
          },
          {
            id: "spend_control", kind: "spend_control", scope: { type: "account" }, label: "Spend cap",
            usedPercent: 25.12, remainingPercent: 74.88, windowMinutes: null, windowSource: "unknown",
            resetsAt: null, providerKey: "individualLimit",
          },
        ],
        credits: [{
          id: "codex_credits", label: "Credits", unit: { type: "provider_credits" }, balance: "318.2716000000",
          used: null, limit: null, usedPercent: null, unlimited: false, hasCredits: true, enabled: null,
          disabledReason: null, providerKey: "rateLimits.credits",
        }],
        resetCredits: { availableCount: 3 },
        analytics: {
          lifetimeTokens: 1846203917, peakDailyTokens: null, longestRunningTurnSec: 100,
          currentStreakDays: 1, longestStreakDays: 2,
          daily: [{ date: "2026-10-01", tokens: 1000 }],
        },
        errors: [], warnings: [],
      },
      {
        provider: "claude", status: "ok", fetchedAt: "2026-10-01T13:40:02.110Z", durationMs: 1752,
        source: { method: "claude-control-get-usage", stability: "experimental", providerVersion: "2.1.286" },
        account: { plan: "pro", authMode: "claude.ai" },
        availability: { state: "available", basis: "derived_from_limits", reason: null, exhaustedLimitIds: ["weekly:model:opus"] },
        limits: [
          {
            id: "session", kind: "session", scope: { type: "account" }, label: "5h", usedPercent: 7,
            remainingPercent: 93, windowMinutes: 300, windowSource: "inferred",
            resetsAt: "2026-10-01T18:00:00.214Z", providerKey: "rate_limits.five_hour",
          },
          {
            id: "weekly", kind: "weekly", scope: { type: "account" }, label: "Weekly", usedPercent: 26,
            remainingPercent: 74, windowMinutes: 10080, windowSource: "inferred",
            resetsAt: "2026-10-07T09:00:00.214Z", providerKey: "rate_limits.seven_day",
          },
          {
            id: "weekly:model:opus", kind: "weekly", scope: { type: "model", model: "opus" }, label: "Weekly (Opus)",
            usedPercent: 110, remainingPercent: 0, windowMinutes: 10080, windowSource: "inferred",
            resetsAt: null, providerKey: "rate_limits.seven_day_opus",
          },
          {
            id: "weekly:product:cowork", kind: "weekly", scope: { type: "product", product: "cowork" }, label: "Weekly (Cowork)",
            usedPercent: null, remainingPercent: null, windowMinutes: 10080, windowSource: "inferred",
            resetsAt: null, providerKey: "rate_limits.seven_day_cowork",
          },
        ],
        credits: [{
          id: "claude_extra_usage", label: "Extra usage", unit: { type: "currency", currency: "USD" }, balance: null,
          used: "12.50", limit: "50.00", usedPercent: 25, unlimited: null, hasCredits: null, enabled: false,
          disabledReason: "out_of_credits", providerKey: "rate_limits.extra_usage",
        }],
        resetCredits: null, analytics: null, errors: [], warnings: [],
      },
    ],
  };
}

test("a hand-built full report validates in Zod and JSON Schema without losing fields", () => {
  const report = fullReport();
  expect(UsageReportSchema.parse(report)).toEqual(report);
  expect(validate(report), ajv.errorsText(validate.errors)).toBe(true);
});

test("the generated file matches the schema byte for byte and contains no raw contract property", () => {
  const file = readFileSync(schemaPath, "utf8");
  expect(file).toBe(`${JSON.stringify(generated, null, 2)}\n`);
  function inspect(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    if ("properties" in value && value.properties !== null && typeof value.properties === "object") {
      expect(value.properties).not.toHaveProperty("raw");
    }
    for (const nested of Object.values(value)) inspect(nested);
  }
  inspect(JSON.parse(file) as unknown);
});

test("missing schemaVersion fails in both validators", () => {
  const { schemaVersion: _omitted, ...report } = fullReport();
  expect(UsageReportSchema.safeParse(report).success).toBe(false);
  expect(validate(report)).toBe(false);
});

test("unknown object fields are ignored, not returned as public data", () => {
  const report = fullReport();
  const input = {
    ...report, futureField: true,
    providers: report.providers.map((provider) => ({
      ...provider, raw: { secret: "fixture" },
      account: { ...provider.account, email: "user@example.invalid" },
    })),
  };
  expect(UsageReportSchema.parse(input)).toEqual(report);
  expect(validate(input)).toBe(true);
});

test("warning codes are open and warnings leave status ok", () => {
  const report = fullReport();
  report.providers[0]!.warnings.push({ code: "future_warning", message: "Observation.", retryable: false, hint: null });
  expect(UsageReportSchema.safeParse(report).success).toBe(true);
  expect(validate(report)).toBe(true);
});

describe("invalid report values", () => {
  test.each([
    ["wrong version", (report: UsageReport) => ({ ...report, schemaVersion: 2 })],
    ["missing millisecond precision", (report: UsageReport) => ({ ...report, generatedAt: "2026-10-01T13:40:02Z" })],
    ["non-UTC timestamp", (report: UsageReport) => ({ ...report, generatedAt: "2026-10-01T13:40:02.000+00:00" })],
    ["invalid calendar date", (report: UsageReport) => ({ ...report, generatedAt: "2026-02-30T13:40:02.000Z" })],
    ["missing required null", (report: UsageReport) => ({ ...report, providers: [{ ...report.providers[0], account: undefined }] })],
    ["fractional timing", (report: UsageReport) => ({ ...report, providers: [{ ...report.providers[0], durationMs: 1.5 }] })],
    ["negative timing", (report: UsageReport) => ({ ...report, providers: [{ ...report.providers[0], durationMs: -1 }] })],
    ["float money", (report: UsageReport) => ({ ...report, providers: [{ ...report.providers[0], credits: [{ ...report.providers[0]!.credits[0], balance: 318.27 }] }] })],
    ["exponential money", (report: UsageReport) => ({ ...report, providers: [{ ...report.providers[0], credits: [{ ...report.providers[0]!.credits[0], balance: "1e3" }] }] })],
    ["unsafe token count", (report: UsageReport) => ({ ...report, providers: [{ ...report.providers[0], analytics: { ...report.providers[0]!.analytics, lifetimeTokens: Number.MAX_SAFE_INTEGER + 1 } }] })],
    ["oversized message", (report: UsageReport) => ({ ...report, providers: [{ ...report.providers[0], warnings: [{ code: "warning", message: "x".repeat(301), retryable: false, hint: null }] }] })],
  ])("rejects %s in both validators", (_description, mutate) => {
    const report = mutate(fullReport());
    expect(UsageReportSchema.safeParse(report).success).toBe(false);
    expect(validate(report)).toBe(false);
  });
});

test("status semantics agree in Zod and JSON Schema", () => {
  const report = fullReport();
  const provider = report.providers[0]!;
  const issue = { code: "timeout", message: "Timed out.", retryable: true, hint: null };
  const unknown = { state: "unknown", basis: "none", reason: null, exhaustedLimitIds: [] };
  const scenarios = [
    [{ ...provider, status: "ok", errors: [issue] }, false],
    [{ ...provider, status: "partial", errors: [] }, false],
    [{ ...provider, status: "partial", errors: [issue] }, true],
    [{ ...provider, status: "error", errors: [issue], availability: unknown, limits: [] }, true],
    [{ ...provider, status: "error", errors: [issue], availability: unknown }, false],
    [{ ...provider, status: "error", errors: [issue], limits: [] }, false],
    [{ ...provider, status: "error", errors: [], availability: unknown, limits: [] }, false],
  ] as const;
  for (const [candidate, expected] of scenarios) {
    const input = { ...report, providers: [candidate] };
    expect(UsageReportSchema.safeParse(input).success).toBe(expected);
    expect(validate(input)).toBe(expected);
  }
});
