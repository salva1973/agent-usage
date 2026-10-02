import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { UsageReportSchema } from "../../src/index.js";
import { codexHarness, fakeCodex, type CodexHarness } from "../helpers/codex.js";
import { claudeHarness, fakeClaude, type ClaudeHarness } from "../helpers/claude.js";

const project = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
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
  const env: NodeJS.ProcessEnv = { ...codex.env, FAKE_CLAUDE_SCENARIO: claude.env.FAKE_CLAUDE_SCENARIO,
    FAKE_CLAUDE_RECORD_FILE: claude.env.FAKE_CLAUDE_RECORD_FILE,
    AGENT_USAGE_CODEX_BIN: fakeCodex, AGENT_USAGE_CLAUDE_BIN: fakeClaude,
    TZ: "UTC", AGENT_USAGE_NOW: "2026-10-01T13:40:00Z", NO_COLOR: "" };
  return { codex, claude, env };
}

function run(argv: string[], env: NodeJS.ProcessEnv, tty = false) {
  // Simulate stdout's TTY property deterministically without a PTY dependency.
  const preload = 'Object.defineProperty(process.stdout, "isTTY", { value: true });';
  const nodeArgs = tty ? [`--import=data:text/javascript,${encodeURIComponent(preload)}`] : [];
  const child = spawn(process.execPath, [...nodeArgs, cli, ...argv], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test.each([
  { noColor: undefined, argv: [] }, { noColor: "", argv: [] }, { noColor: "1", argv: [] },
  { noColor: "", argv: ["--no-color"] }, { noColor: "1", argv: ["--no-color"] },
])("non-TTY output has no ANSI codes with %j", async ({ noColor, argv }) => {
  const { env } = await setup();
  if (noColor === undefined) delete env.NO_COLOR; else env.NO_COLOR = noColor;
  const output = await run(argv, env);
  expect(output.code).toBe(0);
  expect(output.signal).toBeNull();
  expect(output.stderr).toBe("");
  expect(output.stdout).toMatch(/^CODEX · plus · available\n/);
  expect(output.stdout).toContain("\n\nCLAUDE · pro · available (derived)\n");
  expect(output.stdout).not.toContain("\u001b");
});

test.each([
  { noColor: undefined, argv: [], color: true }, { noColor: "", argv: [], color: true },
  { noColor: "1", argv: [], color: false }, { noColor: "0", argv: [], color: false },
  { noColor: "", argv: ["--no-color"], color: false },
])("simulated TTY follows the exact color rule with %j", async ({ noColor, argv, color }) => {
  const { env } = await setup();
  if (noColor === undefined) delete env.NO_COLOR; else env.NO_COLOR = noColor;
  const output = await run(argv, env, true);
  expect(output.code).toBe(0);
  expect(output.stderr).toBe("");
  expect(output.stdout.includes("\u001b")).toBe(color);
  if (color) expect(output.stdout).toContain("\u001b[1m\u001b[36mCODEX\u001b[0m");
});

test("human mode preserves requested provider order", async () => {
  const { env } = await setup();
  const output = await run(["claude", "codex"], env);
  expect(output.code).toBe(0);
  expect(output.stdout).toMatch(/^CLAUDE · /);
  expect(output.stdout).toContain("\n\nCODEX · ");
});

test("human mode preserves exit 3 and renders authentication errors and hints", async () => {
  const { env } = await setup("ok", "unavailable-loggedout");
  const output = await run([], env);
  expect(output.code).toBe(3);
  expect(output.stderr).toBe("");
  expect(output.stdout).toMatch(/^CODEX · /);
  expect(output.stdout).toContain("\n\nCLAUDE · error\n  not_authenticated  Claude is not logged in.\n                     → Run `claude` and use /login.\n");
});

test("human mode preserves exit 4 and renders both missing-binary error blocks", async () => {
  const { env, codex, claude } = await setup();
  env.AGENT_USAGE_CODEX_BIN = "/nonexistent/codex";
  env.AGENT_USAGE_CLAUDE_BIN = "/nonexistent/claude";
  const output = await run([], env);
  expect(output.code).toBe(4);
  expect(output.stderr).toBe("");
  expect(output.stdout).toMatch(/^CODEX · error\n  not_installed  /);
  expect(output.stdout).toContain("\n\nCLAUDE · error\n  not_installed  ");
  expect(await codex.records()).toEqual([]);
  expect(await claude.records()).toEqual([]);
});

test("human mode shows limited observations without changing exit 0", async () => {
  const { env } = await setup("ok", "exhausted");
  const output = await run(["claude"], env);
  expect(output.code).toBe(0);
  expect(output.stdout).toContain("CLAUDE · pro · LIMITED (limit_exhausted:session) (derived)\n");
});

test("human mode shows partial analytics failures without changing exit 0", async () => {
  const { env } = await setup("analytics-error");
  const output = await run(["codex", "--analytics"], env);
  expect(output.code).toBe(0);
  expect(output.stderr).toBe("");
  expect(output.stdout).toMatch(/^CODEX · plus · available\n/);
  expect(output.stdout).toContain("  ! analytics_failed  ");
});

test.each(["ok", "unavailable-loggedout", "unavailable-apikey"])(
  "human debug mode redacts Codex crash data and Claude %s data", async (scenario) => {
    const { env } = await setup("crash-after-init", scenario);
    const output = await run(["--debug"], env);
    expect(output.code).toBe(scenario === "ok" ? 3 : 4);
    expect(output.stdout).toMatch(/^CODEX · error\n/);
    expect(output.stderr).toContain("[agent-usage] ");
    for (const text of [output.stdout, output.stderr]) expect(text).not.toMatch(/example\.invalid|FAKEFAKE|eyJ|FIXTURE|\/home\/user/);
  },
);

test("JSON remains schema-valid and uncolored even on a simulated TTY", async () => {
  const { env } = await setup();
  const output = await run(["--json"], env, true);
  expect(output.code).toBe(0);
  expect(output.stderr).toBe("");
  expect(output.stdout).not.toContain("\u001b");
  const report: unknown = JSON.parse(output.stdout);
  expect(UsageReportSchema.parse(report)).toEqual(report);
  expect(output.stdout).toBe(`${JSON.stringify(report, null, 2)}\n`);
});

test.each([
  [["--raw"], "unknown option '--raw'"], [["--timeout"], "option '--timeout' requires a value"],
  [["--json=true"], "option '--json' does not take a value"],
])("usage error %j has the approved short message and does not fetch", async (argv, reason) => {
  const { env, codex, claude } = await setup();
  const output = await run(argv, env);
  expect(output).toEqual({ code: 2, signal: null, stdout: "", stderr: `agent-usage: ${reason}\nTry 'agent-usage --help'.\n` });
  expect(await codex.records()).toEqual([]);
  expect(await claude.records()).toEqual([]);
});
