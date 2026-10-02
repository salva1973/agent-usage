import { afterEach, expect, test } from "vitest";
import { ProviderReportSchema } from "../../src/domain/reportSchema.js";
import type { ProviderReport } from "../../src/domain/model.js";
import { claudeProvider } from "../../src/providers/claude/index.js";
import { claudeHarness, fakeClaude, fixedNow, type ClaudeHarness } from "../helpers/claude.js";

const harnesses: ClaudeHarness[] = [];
afterEach(async () => { for (const harness of harnesses) await harness.dispose(); harnesses.length = 0; });
async function harness(scenario: string) { const result = await claudeHarness(scenario); harnesses.push(result); return result; }
function validate(report: ProviderReport, fake: ClaudeHarness): void {
  expect(ProviderReportSchema.parse(report)).toEqual(report);
  expect(report.fetchedAt).toBe(fixedNow);
  expect(Number.isInteger(report.durationMs)).toBe(true);
  expect(report.durationMs).toBeGreaterThanOrEqual(0);
  expect(report.source).toMatchObject({ method: "claude-control-get-usage", stability: "experimental" });
  expect(report.analytics).toBeNull();
  expect(report.resetCredits).toBeNull();
  expect(report).not.toHaveProperty("raw");
  expect(JSON.stringify(report) + fake.debug.join("\n")).not.toMatch(/example\.invalid|FIXTURE|eyJ|sk-ant|fake-secret|private|\/home\/user/);
}

test.each(["ok", "ok-noise", "pii-initialize", "init-error", "usage-before-init", "stderr-noise"])("%s returns safe normalized observations", async (scenario) => {
  const fake = await harness(scenario);
  const report = await claudeProvider.fetch(fake.context());
  validate(report, fake);
  expect(report.status).toBe("ok");
  expect(report.source.providerVersion).toBe("2.1.286");
  expect(report.account).toEqual({ plan: "pro", authMode: "claude.ai" });
  expect(report.limits.map((limit) => [limit.id, limit.usedPercent, limit.remainingPercent, limit.resetsAt])).toEqual([
    ["session", 7, 93, "2026-10-01T18:00:00.214Z"], ["weekly", 26, 74, "2026-10-07T09:00:00.214Z"],
  ]);
  expect(report.credits[0]).toMatchObject({ limit: "50.00", used: "12.50", unit: { type: "currency", currency: "USD" } });
  expect(report.errors).toEqual([]);
  expect(report.warnings).toEqual([]);
  const records = await fake.records();
  const spawns = records.filter((record) => record.type === "spawn");
  expect(spawns.map((record) => record.argv[0]).sort()).toEqual(["--version", "-p"].sort());
  expect(new Set(spawns.map((record) => record.cwd)).size).toBe(1);
  expect(records.some((record) => record.type === "stdin-closed")).toBe(true);
  const lines = records.filter((record) => record.type === "line").map((record) => record.message);
  expect(lines).not.toContainEqual(expect.objectContaining({ type: "user" }));
});

test.each([
  ["unsupported", "incompatible_provider", false], ["upstream-error", "upstream_error", true],
  ["unavailable-loggedout", "not_authenticated", false], ["unavailable-apikey", "unsupported_auth", false],
  ["unavailable-bedrock", "unsupported_auth", false], ["unavailable-loggedin", "rate_limits_unavailable", false],
  ["auth-invalid", "rate_limits_unavailable", false], ["auth-schema-invalid", "rate_limits_unavailable", false],
  ["auth-failed", "rate_limits_unavailable", false], ["fetch-failed", "upstream_unavailable", true],
  ["malformed", "protocol_error", false], ["bad-rate-limits", "protocol_error", false],
  ["garbage-line", "protocol_error", false], ["malformed-envelope", "protocol_error", false],
  ["exit-early", "process_error", true],
])("%s yields %s with retryable=%s", async (scenario, code, retryable) => {
  const fake = await harness(scenario);
  const report = await claudeProvider.fetch(fake.context());
  validate(report, fake);
  expect(report.status).toBe("error");
  expect(report.errors).toHaveLength(1);
  expect(report.errors[0]).toMatchObject({ code, retryable });
  expect(report.limits).toEqual([]);
  expect(report.availability.state).toBe("unknown");
  const spawns = (await fake.records()).filter((record) => record.type === "spawn");
  const authSpawns = spawns.filter((record) => record.argv[0] === "auth");
  if (scenario.startsWith("unavailable-") || scenario.startsWith("auth-")) {
    expect(authSpawns).toHaveLength(1);
    expect(new Set(spawns.map((record) => record.cwd)).size).toBe(1);
  } else expect(authSpawns).toHaveLength(0);
  if (scenario.startsWith("auth-")) expect(report.warnings.map((issue) => issue.code)).toEqual(["auth_status_failed"]);
  if (scenario === "exit-early") expect(report.errors[0]?.message).toContain("exit code 1");
});

test.each(["version-failed", "version-malformed"])("%s leaves status ok and providerVersion null", async (scenario) => {
  const fake = await harness(scenario);
  const report = await claudeProvider.fetch(fake.context());
  validate(report, fake);
  expect(report.status).toBe("ok");
  expect(report.source.providerVersion).toBeNull();
  expect(report.errors).toEqual([]);
});

test("version's own five-second deadline leaves successful usage intact", async () => {
  const fake = await harness("version-hang");
  const began = performance.now();
  const report = await claudeProvider.fetch(fake.context({ timeoutMs: 7500 }));
  validate(report, fake);
  expect(report.status).toBe("ok");
  expect(report.source.providerVersion).toBeNull();
  expect(performance.now() - began).toBeGreaterThanOrEqual(4900);
  expect(performance.now() - began).toBeLessThan(6500);
}, 10000);

test.each(["scoped", "exhausted", "bad-extra"])("%s normalizes without losing core observations", async (scenario) => {
  const fake = await harness(scenario);
  const report = await claudeProvider.fetch(fake.context());
  validate(report, fake);
  expect(report.status).toBe("ok");
  if (scenario === "scoped") {
    expect(report.availability.state).toBe("available");
    expect(report.availability.exhaustedLimitIds).toEqual(["weekly:model:opus"]);
    expect(report.warnings[0]?.code).toBe("unknown_limit_key");
  }
  if (scenario === "exhausted") expect(report.availability.state).toBe("limited");
  if (scenario === "bad-extra") {
    expect(report.credits[0]).toMatchObject({ used: null, limit: null, unit: { type: "provider_credits" } });
    expect(report.warnings[0]?.code).toBe("ambiguous_units");
  }
});

test("analytics requested remains null with a warning and no additional control requests", async () => {
  const fake = await harness("ok");
  const report = await claudeProvider.fetch(fake.context({ includeAnalytics: true }));
  validate(report, fake);
  expect(report.status).toBe("ok");
  expect(report.warnings.map((issue) => issue.code)).toEqual(["analytics_not_supported"]);
  expect((await fake.records()).filter((record) => record.type === "line")).toHaveLength(2);
});

test.each(["unsupported", "malformed", "unavailable-loggedout"])("%s still marks requested analytics unsupported", async (scenario) => {
  const fake = await harness(scenario);
  const report = await claudeProvider.fetch(fake.context({ includeAnalytics: true }));
  validate(report, fake);
  expect(report.status).toBe("error");
  expect(report.warnings.map((issue) => issue.code)).toEqual(["analytics_not_supported"]);
});

test.each(["hang", "hang-grandchild"])("%s respects the shared deadline and leaves no children/cwd", async (scenario) => {
  const fake = await harness(scenario);
  const began = performance.now();
  const report = await claudeProvider.fetch(fake.context({ timeoutMs: 1000 }));
  validate(report, fake);
  expect(report.errors[0]).toMatchObject({ code: "timeout", retryable: true });
  expect(performance.now() - began).toBeLessThan(2500);
  if (scenario === "hang-grandchild") expect((await fake.records()).some((record) => record.type === "child")).toBe(true);
});

test("version-hang cut off by the shared deadline preserves successful usage", async () => {
  const fake = await harness("version-hang");
  const began = performance.now();
  const report = await claudeProvider.fetch(fake.context({ timeoutMs: 1000 }));
  validate(report, fake);
  expect(report.status).toBe("ok");
  expect(report.source.providerVersion).toBeNull();
  expect(report.limits.map((limit) => limit.id)).toEqual(["session", "weekly"]);
  expect(report.errors).toEqual([]);
  expect(performance.now() - began).toBeLessThan(2500);
});

test("auth-hang cut off by the shared deadline uses the auth-status-failed branch", async () => {
  const fake = await harness("auth-hang");
  const began = performance.now();
  const report = await claudeProvider.fetch(fake.context({ timeoutMs: 1000 }));
  validate(report, fake);
  expect(report.status).toBe("error");
  expect(report.errors[0]?.code).toBe("rate_limits_unavailable");
  expect(report.warnings.map((issue) => issue.code)).toContain("auth_status_failed");
  expect(performance.now() - began).toBeLessThan(2500);
});

test.each(["version-hang", "slow-shutdown-version-hang"])("%s: caller abort after usage preserves the core result during helper/child cleanup", async (scenario) => {
  const fake = await harness(scenario);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let observedUsage = false;
  const began = performance.now();
  try {
    const report = await claudeProvider.fetch(fake.context({ signal: controller.signal, debug: (message) => {
      fake.debug.push(message);
      if (message === "usage control response received") {
        observedUsage = true;
        // Trigger from the actual response, not a guessed startup delay.
        timer = setTimeout(() => controller.abort(), 100);
      }
    } }));
    validate(report, fake);
    expect(observedUsage).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(report.status).toBe("ok");
    expect(report.source.providerVersion).toBeNull();
    expect(report.limits.map((limit) => limit.id)).toEqual(["session", "weekly"]);
    expect(performance.now() - began).toBeLessThan(2500);
  } finally { if (timer !== undefined) clearTimeout(timer); }
});

test("caller cancellation is aborted and cleans up", async () => {
  const fake = await harness("hang");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 500);
  try {
    const report = await claudeProvider.fetch(fake.context({ signal: controller.signal }));
    validate(report, fake);
    expect(report.errors[0]?.code).toBe("aborted");
  } finally { clearTimeout(timer); }
});

test("already aborted callers do not spawn", async () => {
  const fake = await harness("ok");
  const report = await claudeProvider.fetch(fake.context({ signal: AbortSignal.abort() }));
  validate(report, fake);
  expect(report.errors[0]?.code).toBe("aborted");
  expect(await fake.records()).toEqual([]);
});

test("missing binary becomes not_installed with a schema-valid error report", async () => {
  const fake = await harness("ok");
  const report = await claudeProvider.fetch(fake.context({ bin: `${fakeClaude}.missing` }));
  validate(report, fake);
  expect(report.errors[0]?.code).toBe("not_installed");
});

test("own binary environment override is supported without changing the environment", async () => {
  const fake = await harness("ok");
  fake.env.AGENT_USAGE_CLAUDE_BIN = fakeClaude;
  Object.freeze(fake.env);
  const report = await claudeProvider.fetch(fake.context({ bin: undefined }));
  validate(report, fake);
  expect(report.status).toBe("ok");
});

test("throwing debug callbacks cannot fail a fetch", async () => {
  const fake = await harness("ok");
  const report = await claudeProvider.fetch(fake.context({ debug: () => { throw new Error("diagnostic callback failed"); } }));
  validate(report, fake);
  expect(report.status).toBe("ok");
});
