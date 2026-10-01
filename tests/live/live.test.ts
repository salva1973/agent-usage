import { spawn } from "node:child_process";
import { readFileSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { afterEach, describe, expect, test } from "vitest";
import { findLimit, getUsage, UsageReportSchema, type UsageReport } from "../../src/index.js";

const project = fileURLToPath(new URL("../../", import.meta.url));
const cli = fileURLToPath(new URL("../../dist/cli/main.js", import.meta.url));
const ajv = new Ajv2020({ allErrors: true });
const addFormats = createRequire(import.meta.url)("ajv-formats") as FormatsPlugin;
addFormats(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(new URL("../../schema/usage-report.v1.schema.json", import.meta.url), "utf8")));

function checkProviders(report: UsageReport): void {
  expect(report.providers.map((provider) => provider.provider)).toEqual(["codex", "claude"]);
  for (const provider of report.providers) {
    expect(provider.status).toBe("ok");
    console.log(`${provider.provider} ${provider.status}`);
    for (const id of ["session", "weekly"]) {
      const limit = findLimit(provider, id);
      expect(limit !== undefined).toBe(true);
      const percentage = limit?.usedPercent;
      expect(typeof percentage).toBe("number");
      expect(percentage).toBeGreaterThanOrEqual(0);
      expect(percentage).toBeLessThanOrEqual(100);
      console.log(`${provider.provider} ${id} ${percentage}%`);
    }
  }
}

// Capture output privately: failures must never dump account data or provider text.
function runCli(argv: string[]): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...argv], {
      cwd: project, env: process.env, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let timedOut = false;
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.resume();
    // The first signal lets the CLI clean up; the second invokes its exit hook.
    const first = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 25000);
    const second = setTimeout(() => child.kill("SIGTERM"), 30000);
    function clearTimers(): void { clearTimeout(first); clearTimeout(second); }
    child.once("error", () => { clearTimers(); reject(new Error("Live CLI failed to start.")); });
    child.once("close", (code) => {
      clearTimers();
      if (timedOut) reject(new Error("Live CLI exceeded its smoke-test deadline."));
      else resolve({ code, stdout });
    });
  });
}

describe.skipIf(process.env.AGENT_USAGE_LIVE !== "1")("opt-in live providers", () => {
  afterEach(async () => {
    const leftovers = (await fs.readdir(tmpdir())).filter((name) => name.startsWith("agent-usage-claude-"));
    expect(leftovers.length).toBe(0);
  });

  test("library returns valid core limits and Codex analytics", async () => {
    const report = await getUsage({ includeAnalytics: true, timeoutMs: 30000 });
    expect(UsageReportSchema.safeParse(report).success).toBe(true);
    checkProviders(report);
    expect(report.providers.find((provider) => provider.provider === "codex")?.analytics != null).toBe(true);
  }, 60000);

  test("built CLI returns schema-valid JSON and plain human output", async () => {
    const json = await runCli(["--json"]);
    expect(json.code).toBe(0);
    let value: unknown;
    try { value = JSON.parse(json.stdout); } catch { throw new Error("Live CLI stdout was not JSON."); }
    expect(validate(value)).toBe(true);
    const parsed = UsageReportSchema.safeParse(value);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("Live CLI report failed domain validation.");
    checkProviders(parsed.data);

    const human = await runCli([]);
    expect(human.code).toBe(0);
    expect(human.stdout.includes("CODEX · ")).toBe(true);
    expect(human.stdout.includes("CLAUDE · ")).toBe(true);
    expect(human.stdout.includes("\u001b")).toBe(false);
  }, 60000);
});
