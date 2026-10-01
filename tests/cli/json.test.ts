import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { afterEach, expect, test } from "vitest";
import { UsageReportSchema, type UsageReport } from "../../src/index.js";
import { HELP_TEXT } from "../../src/cli/args.js";
import { codexHarness, fakeCodex, type CodexHarness } from "../helpers/codex.js";
import { claudeHarness, fakeClaude, type ClaudeHarness } from "../helpers/claude.js";

const project = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const fixedNow = "2026-10-01T13:40:00Z";
const ajv = new Ajv2020({ allErrors: true });
const addFormats = createRequire(import.meta.url)("ajv-formats") as FormatsPlugin;
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(new URL("../../schema/usage-report.v1.schema.json", import.meta.url), "utf8")));
const harnesses: (CodexHarness | ClaudeHarness)[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
  }
  try { for (const harness of harnesses) await harness.dispose(); } finally { harnesses.length = 0; }
});

async function setup(codexScenario = "ok", claudeScenario = "ok") {
  const codex = await codexHarness(codexScenario);
  const claude = await claudeHarness(claudeScenario);
  harnesses.push(codex, claude);
  const env: NodeJS.ProcessEnv = { ...codex.env,
    FAKE_CLAUDE_SCENARIO: claude.env.FAKE_CLAUDE_SCENARIO, FAKE_CLAUDE_RECORD_FILE: claude.env.FAKE_CLAUDE_RECORD_FILE,
    AGENT_USAGE_CODEX_BIN: fakeCodex, AGENT_USAGE_CLAUDE_BIN: fakeClaude, TZ: "UTC", AGENT_USAGE_NOW: fixedNow };
  return { codex, claude, env };
}

interface Output { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function start(argv: string[], env: NodeJS.ProcessEnv, preload?: string) {
  const nodeArgs = preload === undefined ? [] : [`--import=data:text/javascript,${encodeURIComponent(preload)}`];
  const child = spawn(process.execPath, [...nodeArgs, cli, ...argv], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const output = new Promise<Output>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, output };
}

function parseReport(output: Output): UsageReport {
  expect(output.signal).toBeNull();
  const report: unknown = JSON.parse(output.stdout);
  expect(validate(report), ajv.errorsText(validate.errors)).toBe(true);
  const parsed = UsageReportSchema.parse(report);
  expect(report).toEqual(parsed);
  expect(output.stdout).toBe(`${JSON.stringify(report, null, 2)}\n`);
  return parsed;
}

async function expectNoFetch(codex: CodexHarness, claude: ClaudeHarness): Promise<void> {
  expect(await codex.records()).toEqual([]);
  expect(await claude.records()).toEqual([]);
  await expect(fs.stat(codex.env.FAKE_CODEX_RECORD_FILE!)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(claude.env.FAKE_CLAUDE_RECORD_FILE!)).rejects.toMatchObject({ code: "ENOENT" });
}

test("compiled entry begins with the executable shebang", () => {
  expect(readFileSync(cli, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
});

test.each([["--json"], []])("both successful providers use the selected output mode with arguments %j", async (...argv) => {
  const { env } = await setup();
  const output = await start(argv, env).output;
  expect(output.code).toBe(0);
  expect(output.stderr).toBe("");
  if (argv.length === 0) {
    expect(output.stdout).toMatch(/^CODEX · /);
    expect(output.stdout).toContain("\n\nCLAUDE · ");
    expect(output.stdout).toContain("resets today 18:39          (in 4h 59m)");
    expect(output.stdout).not.toContain("\u001b");
    expect(output.stdout.endsWith("\n")).toBe(true);
    return;
  }
  const report = parseReport(output);
  expect(report.generatedAt).toBe("2026-10-01T13:40:00.000Z");
  expect(report.providers.map((provider) => [provider.provider, provider.status])).toEqual([["codex", "ok"], ["claude", "ok"]]);
});

test("Claude selection starts only Claude", async () => {
  const { env, codex } = await setup();
  const output = await start(["claude", "--json", "--no-color"], env).output;
  expect(output.code).toBe(0);
  expect(output.stderr).toBe("");
  expect(parseReport(output).providers.map((provider) => provider.provider)).toEqual(["claude"]);
  expect(await codex.records()).toEqual([]);
});

test("duplicate providers are fetched once in first-occurrence order", async () => {
  const { env, codex, claude } = await setup();
  const output = await start(["codex", "claude", "codex", "--json"], env).output;
  expect(output.code).toBe(0);
  expect(parseReport(output).providers.map((provider) => provider.provider)).toEqual(["codex", "claude"]);
  expect((await codex.records()).filter((record) => record.type === "spawn")).toHaveLength(1);
  expect((await claude.records()).filter((record) => record.type === "spawn" && record.argv[0] === "-p")).toHaveLength(1);
});

test("Codex success and logged-out Claude produce exit 3 and an authentication error", async () => {
  const { env } = await setup("ok", "unavailable-loggedout");
  const output = await start(["--json"], env).output;
  expect(output.code).toBe(3);
  expect(output.stderr).toBe("");
  const report = parseReport(output);
  expect(report.providers[0]?.status).toBe("ok");
  expect(report.providers[1]?.errors[0]?.code).toBe("not_authenticated");
});

test("both missing binaries produce a complete report and exit 4", async () => {
  const { env, codex, claude } = await setup();
  env.AGENT_USAGE_CODEX_BIN = "/nonexistent/codex";
  env.AGENT_USAGE_CLAUDE_BIN = "/nonexistent/claude";
  const output = await start(["--json"], env).output;
  expect(output.code).toBe(4);
  expect(output.stderr).toBe("");
  expect(parseReport(output).providers.map((provider) => provider.errors[0]?.code)).toEqual(["not_installed", "not_installed"]);
  await expectNoFetch(codex, claude);
});

test("optional Codex analytics failure is partial with exit 0", async () => {
  const { env } = await setup("analytics-error");
  const output = await start(["codex", "--json", "--analytics"], env).output;
  expect(output.code).toBe(0);
  expect(output.stderr).toBe("");
  expect(parseReport(output).providers[0]).toMatchObject({ status: "partial", analytics: null });
});

test("Claude limited availability still produces exit 0", async () => {
  const { env } = await setup("ok", "exhausted");
  const output = await start(["claude", "--json"], env).output;
  expect(output.code).toBe(0);
  expect(parseReport(output).providers[0]).toMatchObject({ status: "ok", availability: { state: "limited" } });
});

test.each([["--raw"], ["--watch"], ["--watch", "60"], ["--timeout", "0"], ["bogus"]])(
  "binary usage error %j performs no fetch", async (...argv) => {
    const { env, codex, claude } = await setup();
    const output = await start(argv, env).output;
    expect(output.code).toBe(2);
    expect(output.stdout).toBe("");
    expect(output.stderr).toMatch(/^agent-usage: .+\nTry 'agent-usage --help'\.\n$/);
    await expectNoFetch(codex, claude);
  },
);

test.each([["--help", HELP_TEXT], ["-h", HELP_TEXT], ["--version", "0.1.0\n"], ["-V", "0.1.0\n"]])(
  "%s prints exact output without starting any fake", async (argument, expected) => {
    const { env, codex, claude } = await setup();
    const output = await start([argument], env).output;
    expect(output).toEqual({ code: 0, signal: null, stdout: expected, stderr: "" });
    await expectNoFetch(codex, claude);
  },
);

test("an invalid injected clock is a usage error before fetching", async () => {
  const { env, codex, claude } = await setup();
  env.AGENT_USAGE_NOW = "invalid-date";
  const output = await start(["--json"], env).output;
  expect(output).toEqual({ code: 2, signal: null, stdout: "",
    stderr: "agent-usage: AGENT_USAGE_NOW must contain a valid date.\nTry 'agent-usage --help'.\n" });
  await expectNoFetch(codex, claude);
});

test.each(["SIGINT", "SIGTERM"] as const)("%s waits for both hanging providers to clean up", async (signal) => {
  const { env, codex, claude } = await setup("hang-after-init", "hang");
  const { child, output } = start(["--json", "--timeout", "120"], env);
  const deadline = performance.now() + 5000;
  while (true) {
    const codexStarted = (await codex.records()).some((record) => record.type === "spawn");
    const claudeStarted = (await claude.records()).some((record) => record.type === "spawn" && record.argv[0] === "-p");
    if (codexStarted && claudeStarted) break;
    if (performance.now() >= deadline) throw new Error("Fake providers did not start");
    await delay(10);
  }
  expect(child.kill(signal)).toBe(true);
  expect(await output).toEqual({ code: 130, signal: null, stdout: "", stderr: "" });
  // Each harness verifies every recorded PID and Claude's ephemeral cwd after exit.
});

test.each(["ok", "unavailable-loggedout", "unavailable-apikey"])(
  "debug output redacts Codex crash data and Claude %s data", async (scenario) => {
    const { env } = await setup("crash-after-init", scenario);
    const output = await start(["--json", "--debug"], env).output;
    expect(output.code).toBe(scenario === "ok" ? 3 : 4);
    parseReport(output);
    expect(output.stderr).toContain("[agent-usage] ");
    for (const text of [output.stdout, output.stderr]) expect(text).not.toMatch(/example\.invalid|FAKEFAKE|eyJ|FIXTURE|\/home\/user/);
  },
);

test.each([false, true])("internal CLI failure redacts errors, with debug=%s", async (debug) => {
  const { env, codex, claude } = await setup();
  const preload = 'process.stdout.write = () => { const error = new Error("CLI failure Bearer eyJFAKEFAKE user@example.invalid"); error.stack = "Error: " + error.message + "\\n    at cli-fixture:1:1"; throw error; };';
  const output = await start(["--help", ...(debug ? ["--debug"] : [])], env, preload).output;
  expect(output.code).toBe(1);
  expect(output.stdout).toBe("");
  expect(output.stderr).toMatch(/^agent-usage: internal error: CLI failure /);
  expect(output.stderr).not.toMatch(/example\.invalid|FAKEFAKE|eyJ|\/home\/user/);
  expect(output.stderr.includes("at ")).toBe(debug);
  await expectNoFetch(codex, claude);
});

test("signals after report output preserve the successful exit code", async () => {
  const { env } = await setup();
  const preload = 'const write = process.stdout.write.bind(process.stdout); process.stdout.write = (...args) => { const result = write(...args); queueMicrotask(() => { process.emit("SIGINT"); process.emit("SIGTERM"); }); return result; };';
  const output = await start(["--json"], env, preload).output;
  expect(output.code).toBe(0);
  expect(output.stderr).toBe("");
  expect(parseReport(output).providers.every((provider) => provider.status === "ok")).toBe(true);
});
