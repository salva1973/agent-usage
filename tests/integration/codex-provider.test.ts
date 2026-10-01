import { afterEach, expect, test } from "vitest";
import { UsageReportSchema } from "../../src/domain/reportSchema.js";
import type { ProviderReport } from "../../src/domain/model.js";
import { codexProvider } from "../../src/providers/codex/index.js";
import { codexHarness, fakeCodex, fixedNow, type CodexHarness } from "../helpers/codex.js";

const harnesses: CodexHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses) await harness.dispose();
  harnesses.length = 0;
});

async function harness(scenario: string) {
  const result = await codexHarness(scenario);
  harnesses.push(result);
  return result;
}

function validate(report: ProviderReport): void {
  expect(UsageReportSchema.parse({ schemaVersion: 1, tool: { name: "agent-usage", version: "0.1.0" }, generatedAt: fixedNow, providers: [report] }).providers[0]).toEqual(report);
  expect(report.fetchedAt).toBe(fixedNow);
  expect(Number.isInteger(report.durationMs)).toBe(true);
  expect(report.durationMs).toBeGreaterThanOrEqual(0);
  expect(report).not.toHaveProperty("raw");
  expect(JSON.stringify(report)).not.toMatch(/example\.invalid|FIXTURE|eyJ|sk-FAKE|fake-secret|codexHome/);
}

test.each(["ok", "ok-out-of-order", "notifications-noise", "stderr-noise"])("%s returns schema-valid core and analytics observations", async (scenario) => {
  const fake = await harness(scenario);
  const report = await codexProvider.fetch(fake.context({ includeAnalytics: true }));
  validate(report);
  expect(report.status).toBe("ok");
  expect(report.source).toEqual({ method: "codex-app-server", stability: "supported", providerVersion: "0.159.2" });
  expect(report.account).toEqual({ plan: "plus", authMode: "chatgpt" });
  expect(report.limits.map((limit) => [limit.id, limit.usedPercent])).toEqual([["session", 0], ["weekly", 22]]);
  expect(report.credits[0]?.balance).toBe("452.0439000000");
  expect(report.resetCredits).toEqual({ availableCount: 2 });
  expect(report.analytics?.lifetimeTokens).toBe(3103172254);
  expect(report.analytics?.daily.map((bucket) => bucket.date)).toEqual(["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]);
  expect(report.errors).toEqual([]);
  expect(report.warnings).toEqual([]);
  expect(fake.debug.join("\n")).not.toMatch(/example\.invalid|FIXTURE|eyJ|sk-FAKE|fake-secret/);
  const records = await fake.records();
  expect(records.some((record) => record.type === "stdin-closed")).toBe(true);
  const requests = records.filter((record) => record.type === "line").map((record) => record.message);
  expect(requests).toContainEqual({ method: "account/read", id: 2, params: { refreshToken: false } });
  expect(requests).toContainEqual({ method: "account/rateLimits/read", id: 3, params: { excludeResetCreditDetails: true } });
  expect(requests).toContainEqual({ method: "account/usage/read", id: 4, params: null });
  expect(JSON.stringify(requests)).not.toContain("rateLimitResetCredit");
});

test("analytics is not requested by default", async () => {
  const fake = await harness("ok");
  const report = await codexProvider.fetch(fake.context());
  validate(report);
  expect(report.analytics).toBeNull();
  const records = await fake.records();
  expect(records.filter((record) => record.type === "line").map((record) => record.message.method)).toEqual([
    "initialize", "initialized", "account/read", "account/rateLimits/read",
  ]);
});

test.each([
  ["unauth", "not_authenticated", false], ["auth-error", "not_authenticated", false],
  ["apikey", "unsupported_auth", false], ["method-not-found", "incompatible_provider", false],
  ["invalid-params", "upstream_error", false], ["upstream-error", "upstream_error", true],
  ["garbage-line", "protocol_error", false], ["malformed-envelope", "protocol_error", false],
  ["malformed", "protocol_error", false], ["missing-ratelimits", "protocol_error", false],
  ["crash-after-init", "process_error", true],
])("%s is classified as %s with retryable=%s", async (scenario, code, retryable) => {
  const fake = await harness(scenario);
  const report = await codexProvider.fetch(fake.context({ includeAnalytics: true }));
  validate(report);
  expect(report.status).toBe("error");
  expect(report.limits).toEqual([]);
  expect(report.availability).toEqual({ state: "unknown", basis: "none", reason: null, exhaustedLimitIds: [] });
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0]).toMatchObject({ code, retryable });
  if (code === "not_authenticated") expect(report.errors[0]?.hint).toBe("Run `codex login`.");
  if (scenario === "malformed") expect(report.errors[0]?.message).toContain("rateLimits.primary.usedPercent");
  if (scenario === "missing-ratelimits") expect(report.errors[0]?.message).toContain("rateLimits");
  if (scenario === "crash-after-init") {
    expect(report.errors[0]?.message).toContain("exit code 1");
    expect(report.errors[0]?.message).toContain("[REDACTED]");
  }
  if (scenario === "upstream-error") expect(report.errors[0]?.message).toContain("[REDACTED]");
});

test.each([["analytics-error", "upstream_error", true], ["analytics-malformed", "protocol_error", false]])(
  "%s yields partial with the underlying %s in its analytics_failed error", async (scenario, code, retryable) => {
    const fake = await harness(scenario);
    const report = await codexProvider.fetch(fake.context({ includeAnalytics: true }));
    validate(report);
    expect(report.status).toBe("partial");
    expect(report.analytics).toBeNull();
    expect(report.limits).toHaveLength(2);
    expect(report.credits[0]?.balance).toBe("452.0439000000");
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({ code: "analytics_failed", retryable });
    expect(report.errors[0]?.message).toContain(code);
  },
);

test("account read failure does not fail an otherwise valid core read", async () => {
  const fake = await harness("account-error");
  const report = await codexProvider.fetch(fake.context());
  validate(report);
  expect(report.status).toBe("ok");
  expect(report.account).toEqual({ plan: "plus", authMode: null });
  expect(report.errors).toEqual([]);
});

test("a non-chatgpt auth mode is still reported if rate limits succeed", async () => {
  const fake = await harness("apikey-supported");
  const report = await codexProvider.fetch(fake.context());
  validate(report);
  expect(report.status).toBe("ok");
  expect(report.account).toEqual({ plan: "plus", authMode: "apiKey" });
});

test("providerVersion stays null when userAgent has no version match", async () => {
  const fake = await harness("unversioned");
  const report = await codexProvider.fetch(fake.context());
  validate(report);
  expect(report.status).toBe("ok");
  expect(report.source.providerVersion).toBeNull();
});

test.each(["hang-after-init", "hang-grandchild"])("%s respects the provider deadline and leaves no children", async (scenario) => {
  const fake = await harness(scenario);
  const began = performance.now();
  const report = await codexProvider.fetch(fake.context({ timeoutMs: 1000 }));
  validate(report);
  expect(report.status).toBe("error");
  expect(report.errors[0]).toMatchObject({ code: "timeout", retryable: true });
  expect(performance.now() - began).toBeLessThan(2500);
  if (scenario === "hang-grandchild") expect((await fake.records()).some((record) => record.type === "child")).toBe(true);
});

test("caller cancellation is classified as aborted and cleans up", async () => {
  const fake = await harness("hang-after-init");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const report = await codexProvider.fetch(fake.context({ signal: controller.signal }));
    validate(report);
    expect(report.errors[0]).toMatchObject({ code: "aborted", retryable: false });
  } finally { clearTimeout(timer); }
});

test("a missing explicit binary returns not_installed without any real provider invocation", async () => {
  const fake = await harness("ok");
  const report = await codexProvider.fetch(fake.context({ bin: "/nonexistent/agent-usage-codex" }));
  validate(report);
  expect(report.status).toBe("error");
  expect(report.source.providerVersion).toBeNull();
  expect(report.errors[0]).toMatchObject({ code: "not_installed", retryable: false });
  expect(await fake.records()).toEqual([]);
});

test("the own binary environment override works when no explicit bin is given", async () => {
  const fake = await harness("ok");
  fake.env.AGENT_USAGE_CODEX_BIN = fakeCodex;
  const report = await codexProvider.fetch(fake.context({ bin: undefined }));
  validate(report);
  expect(report.status).toBe("ok");
});

test("an explicit bin takes precedence over the environment override", async () => {
  const fake = await harness("ok");
  fake.env.AGENT_USAGE_CODEX_BIN = "/nonexistent/ignored-codex";
  const report = await codexProvider.fetch(fake.context());
  validate(report);
  expect(report.status).toBe("ok");
});
