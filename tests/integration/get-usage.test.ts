import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { getUsage, getCodexUsage, getClaudeUsage, UsageReportSchema, SCHEMA_VERSION, type GetUsageOptions } from "../../src/index.js";
import { runProviders } from "../../src/core/getUsage.js";
import { codexProvider } from "../../src/providers/codex/index.js";
import { claudeProvider } from "../../src/providers/claude/index.js";
import type { UsageProvider } from "../../src/providers/types.js";
import { codexHarness, fakeCodex, type CodexHarness } from "../helpers/codex.js";
import { claudeHarness, fakeClaude, type ClaudeHarness } from "../helpers/claude.js";

const fixedNow = "2026-10-01T13:40:02.120Z";
// Observe forwarding to the real spawn while continuing to run only fakes.
vi.mock("node:child_process", { spy: true });
const harnesses: (CodexHarness | ClaudeHarness)[] = [];
afterEach(async () => { for (const harness of harnesses) await harness.dispose(); harnesses.length = 0; vi.clearAllMocks(); });
async function setup(codexScenario = "ok", claudeScenario = "ok") {
  const codex = await codexHarness(codexScenario);
  const claude = await claudeHarness(claudeScenario);
  harnesses.push(codex, claude);
  const env: NodeJS.ProcessEnv = { ...codex.env, FAKE_CLAUDE_SCENARIO: claude.env.FAKE_CLAUDE_SCENARIO, FAKE_CLAUDE_RECORD_FILE: claude.env.FAKE_CLAUDE_RECORD_FILE };
  const options: GetUsageOptions = { env, binaries: { codex: fakeCodex, claude: fakeClaude }, now: () => new Date(fixedNow) };
  return { codex, claude, env, options };
}

test("default provider order produces a schema-valid report with the package version", async () => {
  const { options } = await setup();
  const report = await getUsage(options);
  expect(UsageReportSchema.parse(report)).toEqual(report);
  expect(report.providers.map((provider) => [provider.provider, provider.status])).toEqual([["codex", "ok"], ["claude", "ok"]]);
  expect(report.generatedAt).toBe(fixedNow);
  expect(report.schemaVersion).toBe(SCHEMA_VERSION);
  const pkg = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")));
  expect(report.tool).toEqual({ name: "agent-usage", version: pkg.version });
  expect(report.providers.every((provider) => provider.analytics === null)).toBe(true);
  expect(JSON.stringify(report)).not.toMatch(/example\.invalid|FIXTURE|eyJ|FAKE|\/home\/user/);
});

test("requested order is preserved and duplicate providers are fetched only once", async () => {
  const { options, codex, claude } = await setup();
  const requested: GetUsageOptions["providers"] = ["claude", "codex", "claude"];
  const report = await getUsage({ ...options, providers: requested });
  expect(report.providers.map((provider) => provider.provider)).toEqual(["claude", "codex"]);
  expect(requested).toEqual(["claude", "codex", "claude"]);
  expect((await codex.records()).filter((record) => record.type === "spawn")).toHaveLength(1);
  expect((await claude.records()).filter((record) => record.type === "spawn" && record.argv[0] === "-p")).toHaveLength(1);
});

test("Claude hang does not prevent successful Codex observations; cleanup is bounded", async () => {
  const { options } = await setup("ok", "hang");
  const timeoutMs = 1500;
  const began = performance.now();
  const report = await getUsage({ ...options, timeoutMs });
  expect(UsageReportSchema.safeParse(report).success).toBe(true);
  expect(report.providers[0]?.status).toBe("ok");
  expect(report.providers[1]?.errors[0]).toMatchObject({ code: "timeout", retryable: true });
  expect(performance.now() - began).toBeLessThan(timeoutMs + 2500);
});

test("a missing Codex binary is isolated from Claude", async () => {
  const { options } = await setup();
  const report = await getUsage({ ...options, binaries: { codex: "/nonexistent/codex", claude: fakeClaude } });
  expect(UsageReportSchema.safeParse(report).success).toBe(true);
  expect(report.providers[0]?.errors[0]?.code).toBe("not_installed");
  expect(report.providers[1]?.status).toBe("ok");
});

test("caller abort after 300 ms cancels both hanging providers and cleans up", async () => {
  const { options } = await setup("hang-after-init", "hang");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300);
  try {
    const report = await getUsage({ ...options, signal: controller.signal });
    expect(UsageReportSchema.safeParse(report).success).toBe(true);
    expect(report.providers.map((provider) => provider.errors[0]?.code)).toEqual(["aborted", "aborted"]);
  } finally { clearTimeout(timer); }
});

test.each(["codex", "claude"] as const)("a thrown %s provider becomes a redacted internal report with core timing", async (id) => {
  const { options, env } = await setup();
  const otherId = id === "claude" ? "codex" : "claude";
  const throwing: UsageProvider = { id, fetch() { throw new Error("provider bug Bearer fake-secret leak@example.invalid"); } };
  const healthy = otherId === "codex" ? codexProvider : claudeProvider;
  const reports = await runProviders([throwing, healthy], {
    timeoutMs: 5000, signal: undefined, env, binaries: options.binaries, includeAnalytics: false,
    now: () => new Date(fixedNow), debug: () => {},
  });
  const failed = reports[0];
  expect(failed).toEqual({ provider: id, status: "error", fetchedAt: fixedNow, durationMs: expect.any(Number),
    source: { method: id === "codex" ? "codex-app-server" : "claude-control-get-usage", stability: id === "codex" ? "supported" : "experimental", providerVersion: null },
    account: null, availability: { state: "unknown", basis: "none", reason: null, exhaustedLimitIds: [] },
    limits: [], credits: [], resetCredits: null, analytics: null,
    errors: [{ code: "internal", message: "provider bug [REDACTED] [REDACTED]", retryable: false, hint: null }], warnings: [],
  });
  expect(Number.isInteger(failed?.durationMs)).toBe(true);
  expect(failed?.durationMs).toBeGreaterThanOrEqual(0);
  expect(reports[1]?.status).toBe("ok");
  expect(UsageReportSchema.safeParse({ schemaVersion: 1, tool: { name: "agent-usage", version: "0.1.0" }, generatedAt: fixedNow, providers: reports }).success).toBe(true);
});

test("a rejected provider is isolated and all fetches begin before either finishes", async () => {
  const { env } = await setup();
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first: UsageProvider = { id: "codex", fetch: async () => { started.push("codex"); await gate; throw "Bearer fake-secret"; } };
  const second: UsageProvider = { id: "claude", fetch: async () => { started.push("claude"); release(); throw new Error("independent failure"); } };
  const reports = await runProviders([first, second], { timeoutMs: 1000, signal: undefined, env, binaries: undefined,
    includeAnalytics: false, now: () => new Date(fixedNow), debug: () => {} });
  expect(started).toEqual(["codex", "claude"]);
  expect(reports.map((provider) => provider.errors[0]?.code)).toEqual(["internal", "internal"]);
  expect(reports[0]?.errors[0]?.message).toBe("[REDACTED]");
});

test.each([
  { providers: ["unknown"] }, { providers: [] }, { providers: "codex" }, { providers: [null] },
  ...[999, 1.5, 2147483648, NaN, Infinity, null, "1500"].map((timeoutMs) => ({ timeoutMs })),
  { binaries: { codex: "" } }, { binaries: { claude: 12 } }, { binaries: { codex: undefined } },
  { binaries: { unknown: "/fake" } }, { binaries: null },
  { includeAnalytics: "yes" }, { debug: "debug" }, { now: 123 }, { signal: {} }, { env: null },
])("invalid options %j reject with TypeError before any provider runs", async (invalid) => {
  await expect(getUsage(invalid as unknown as GetUsageOptions)).rejects.toBeInstanceOf(TypeError);
});

test.each([null, [], 42])("invalid options object %j rejects with TypeError", async (options) => {
  await expect(getUsage(options as unknown as GetUsageOptions)).rejects.toBeInstanceOf(TypeError);
});

test("env identity is preserved by core, and fake recording variables arrive unchanged", async () => {
  const { options, env, codex, claude } = await setup();
  const marker = "M7_NON_SECRET_MARKER";
  env[marker] = "unchanged";
  Object.freeze(env);
  const observing: UsageProvider = { id: "codex", fetch: async (ctx) => {
    expect(ctx.env === env).toBe(true);
    expect(ctx.env[marker]).toBe("unchanged");
    return codexProvider.fetch(ctx);
  } };
  const reports = await runProviders([observing], { timeoutMs: 5000, signal: undefined, env, binaries: options.binaries,
    includeAnalytics: false, now: () => new Date(fixedNow), debug: () => {} });
  expect(reports[0]?.status).toBe("ok");
  // The existing fakes use these non-secret recording/scenario variables.
  // Successful records at both supplied paths demonstrate their inheritance.
  expect((await codex.records()).some((record) => record.type === "spawn")).toBe(true);
  const report = await getClaudeUsage(options);
  expect(report.status).toBe("ok");
  expect((await claude.records()).some((record) => record.type === "spawn")).toBe(true);
  const spawns = vi.mocked(spawn).mock.calls;
  expect(spawns.length).toBeGreaterThanOrEqual(3);
  for (const call of spawns) {
    // Compare references/only the non-secret marker; never print an env object.
    const inherited = call[2]?.env;
    expect(inherited === env).toBe(true);
    expect(inherited?.[marker]).toBe("unchanged");
  }
  expect(env[marker]).toBe("unchanged");
});

test.each([1000, 2147483647])("valid timeout boundary %s is accepted", async (timeoutMs) => {
  const { options } = await setup();
  expect((await getUsage({ ...options, timeoutMs })).providers.every((provider) => provider.status === "ok")).toBe(true);
});

test("a debug callback that throws cannot break a public fetch", async () => {
  const { options } = await setup();
  let calls = 0;
  const report = await getUsage({ ...options, debug: () => { calls += 1; throw new Error("debug failed"); } });
  expect(calls).toBeGreaterThan(0);
  expect(report.providers.every((provider) => provider.status === "ok")).toBe(true);
});

test.each([getCodexUsage, getClaudeUsage])("single-provider wrappers validate options and return the requested provider", async (fetch) => {
  const { options } = await setup();
  const report = await fetch(options);
  const id = fetch === getCodexUsage ? "codex" : "claude";
  expect(report).toMatchObject({ provider: id, status: "ok" });
  await expect(fetch({ ...options, timeoutMs: 999 })).rejects.toBeInstanceOf(TypeError);
  await expect(fetch(null as unknown as GetUsageOptions)).rejects.toBeInstanceOf(TypeError);
});

test("analytics option reaches both providers without changing the contract", async () => {
  const { options } = await setup();
  const report = await getUsage({ ...options, includeAnalytics: true });
  expect(UsageReportSchema.safeParse(report).success).toBe(true);
  expect(report.providers[0]?.analytics?.lifetimeTokens).toBe(1846203917);
  expect(report.providers[1]?.warnings.map((issue) => issue.code)).toEqual(["analytics_not_supported"]);
});

test("own provider binary overrides remain the providers' responsibility", async () => {
  const { options, env } = await setup();
  env.AGENT_USAGE_CODEX_BIN = fakeCodex;
  env.AGENT_USAGE_CLAUDE_BIN = fakeClaude;
  const { binaries: _removed, ...withoutExplicitBinaries } = options;
  expect((await getUsage(withoutExplicitBinaries)).providers.every((provider) => provider.status === "ok")).toBe(true);
});
