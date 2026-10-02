import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { afterEach, expect, test } from "vitest";
import { UsageReportSchema } from "../../src/index.js";
import { HELP_TEXT } from "../../src/cli/args.js";
import { createDemoReport } from "../../src/cli/demo.js";

const project = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const fixedNow = "2026-10-01T13:40:00Z";
const version: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const codexGolden = `CODEX · plus · available
  5h           37% used   resets today 16:27          (in 2h 47m)
  Weekly       58% used   resets Sun 04 Oct 19:00     (in 3d 5h)
  Credits      125.50 credits
  Resets       1 reset credit available (never used by agent-usage)
`;
const claudeGolden = `CLAUDE · max · available (derived)
  5h             64% used   resets today 15:05          (in 1h 25m)
  Weekly         82% used   resets Tue 06 Oct 07:40     (in 4d 18h)
  Weekly (Opus)  91% used   resets Tue 06 Oct 07:40     (in 4d 18h)
  Extra usage    on · 4.20 / 20.00 USD
`;
const golden = `${codexGolden}\n${claudeGolden}`;
const analyticsGolden = `${codexGolden}  Tokens       lifetime 742.32M · peak day 38.12M · last 7 days 49.92M\n\n${claudeGolden}`;
const debugGolden = `${codexGolden}  · demo_data  Synthetic demo data; no provider was contacted.\n`;
const debugLine = "[agent-usage] demo mode: synthetic data; no provider contacted\n";
const children: ChildProcess[] = [];
const directories: string[] = [];
const ajv = new Ajv2020({ allErrors: true });
const addFormats = createRequire(import.meta.url)("ajv-formats") as FormatsPlugin;
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(new URL("../../schema/usage-report.v1.schema.json", import.meta.url), "utf8")));

function environment(): NodeJS.ProcessEnv {
  return { ...process.env, TZ: "UTC", AGENT_USAGE_NOW: fixedNow, NO_COLOR: "" };
}

function run(argv: string[], env = environment(), tty = false) {
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

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
  }
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

test.each([
  { argv: ["--demo"], expected: golden, stderr: "" },
  { argv: ["--demo", "--analytics"], expected: analyticsGolden, stderr: "" },
  { argv: ["--demo", "codex", "--debug"], expected: debugGolden, stderr: debugLine },
])("demo golden output is byte-exact for $argv", async ({ argv, expected, stderr }) => {
  const output = await run(argv);
  expect(output).toEqual({ code: 0, signal: null, stdout: expected, stderr });
  expect(output.stdout).not.toContain("\u001b");
});

test("demo JSON validates against both committed JSON Schema and UsageReportSchema", async () => {
  const output = await run(["--demo", "--json"]);
  expect(output.code).toBe(0);
  expect(output.stderr).toBe("");
  expect(output.stdout).not.toContain("\u001b");
  const report: unknown = JSON.parse(output.stdout);
  expect(validate(report), ajv.errorsText(validate.errors)).toBe(true);
  const parsed = UsageReportSchema.parse(report);
  expect(report).toEqual(parsed);
  expect(parsed.generatedAt).toBe("2026-10-01T13:40:00.000Z");
  expect(parsed.tool.version).toBe(version);
  expect(output.stdout).toBe(`${JSON.stringify(report, null, 2)}\n`);
});

test.each([
  { argv: ["--demo", "--no-color"], noColor: "" },
  { argv: ["--demo"], noColor: "1" },
])("demo simulated TTY disables color for $argv with NO_COLOR=$noColor", async ({ argv, noColor }) => {
  const output = await run(argv, { ...environment(), NO_COLOR: noColor }, true);
  expect(output).toEqual({ code: 0, signal: null, stdout: golden, stderr: "" });
  expect(output.stdout).not.toContain("\u001b");
});

test("demo simulated TTY uses provider colors and percentage thresholds", async () => {
  const env = environment();
  delete env.NO_COLOR;
  const output = await run(["--demo"], env, true);
  expect(output.code).toBe(0);
  expect(output.stderr).toBe("");
  expect(output.stdout).toContain("\u001b[1m\u001b[36mCODEX\u001b[0m");
  expect(output.stdout).toContain("\u001b[1m\u001b[35mCLAUDE\u001b[0m");
  expect(output.stdout).toContain("\u001b[33m 82%\u001b[0m");
  expect(output.stdout).toContain("\u001b[31m 91%\u001b[0m");
  expect(output.stdout.replace(/\u001b\[\d+m/g, "")).toBe(golden);
});

test("demo JSON has no ANSI even on a TTY", async () => {
  const output = await run(["--demo", "--json"], environment(), true);
  expect(output.code).toBe(0);
  expect(output.stdout).not.toContain("\u001b");
  expect(UsageReportSchema.safeParse(JSON.parse(output.stdout)).success).toBe(true);
});

test("demo timeout remains validated and an accepted timeout has no effect", async () => {
  const invalid = await run(["--demo", "--timeout", "0"]);
  expect(invalid.code).toBe(2);
  expect(invalid.stdout).toBe("");
  expect(invalid.stderr).toContain("--timeout must be an integer number of seconds from 1 to 2147483.");
  expect(await run(["--demo", "--timeout", "1"])).toEqual({ code: 0, signal: null, stdout: golden, stderr: "" });
});

test("help and version take precedence over demo output", async () => {
  expect(await run(["--demo", "--help"])).toEqual({ code: 0, signal: null, stdout: HELP_TEXT, stderr: "" });
  expect(HELP_TEXT).toContain("  --demo              Print synthetic demo data (no providers are contacted)\n");
  expect(await run(["--demo", "--version"])).toEqual({ code: 0, signal: null, stdout: `${version}\n`, stderr: "" });
});

test("demo rejects invalid AGENT_USAGE_NOW before printing a report", async () => {
  expect(await run(["--demo"], { ...environment(), AGENT_USAGE_NOW: "invalid-date" })).toEqual({ code: 2, signal: null, stdout: "",
    stderr: "agent-usage: AGENT_USAGE_NOW must contain a valid date.\nTry 'agent-usage --help'.\n" });
});

test("demo provider selection deduplicates and retains first-occurrence order", async () => {
  expect((await run(["--demo", "claude", "codex", "claude"])).stdout).toBe(`${claudeGolden}\n${codexGolden}`);
});

test("demo debug analytics prints Claude warnings in production order", async () => {
  const output = await run(["--demo", "claude", "--analytics", "--debug"]);
  expect(output).toEqual({ code: 0, signal: null, stdout: `${claudeGolden}  · analytics_not_supported  Claude token analytics are not supported.\n  · demo_data  Synthetic demo data; no provider was contacted.\n`, stderr: debugLine });
});

test("decoy-binary isolation: every demo invocation avoids binaries and the normal-mode control invokes them", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "agent-usage-demo-decoys-"));
  directories.push(directory);
  const marker = join(directory, "invocations");
  for (const name of ["codex", "claude"]) {
    await fs.writeFile(join(directory, name), `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${marker}'\nexit 99\n`, { mode: 0o755 });
  }
  const env = { ...environment(), PATH: `${directory}:${process.env.PATH ?? ""}`,
    AGENT_USAGE_CODEX_BIN: join(directory, "codex"), AGENT_USAGE_CLAUDE_BIN: join(directory, "claude") };
  const jsonGolden = `${JSON.stringify(createDemoReport({ now: new Date(fixedNow), providers: ["codex", "claude"], includeAnalytics: false, version }), null, 2)}\n`;
  for (const { argv, expected, stderr } of [
    { argv: ["--demo"], expected: golden, stderr: "" },
    { argv: ["--demo", "--json"], expected: jsonGolden, stderr: "" },
    { argv: ["--demo", "--no-color"], expected: golden, stderr: "" },
    { argv: ["--demo", "--analytics"], expected: analyticsGolden, stderr: "" },
    { argv: ["--demo", "codex", "--debug"], expected: debugGolden, stderr: debugLine },
    { argv: ["--demo", "claude"], expected: claudeGolden, stderr: "" },
  ]) {
    expect(await run(argv, env), argv.join(" ")).toEqual({ code: 0, signal: null, stdout: expected, stderr });
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
  }
  const control = await run(["--json", "--timeout", "5"], env);
  expect(control.code).toBe(4);
  expect(control.stderr).toBe("");
  expect(UsageReportSchema.safeParse(JSON.parse(control.stdout)).success).toBe(true);
  expect(await fs.readFile(marker, "utf8")).toMatch(/^(codex|claude)\n/);
});
