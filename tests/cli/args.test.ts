import { describe, expect, test } from "vitest";
import { UsageReportSchema, type FetchStatus, type UsageReport } from "../../src/index.js";
import { parseCliArgs } from "../../src/cli/args.js";
import { EXIT_CODES, exitCodeFor } from "../../src/cli/exitCodes.js";
import { renderJson } from "../../src/cli/render/json.js";

test("defaults select both providers with a twenty-second timeout", () => {
  expect(parseCliArgs([])).toEqual({ ok: true, options: {
    action: "fetch", providers: ["codex", "claude"], json: false, includeAnalytics: false,
    timeoutMs: 20000, noColor: false, debug: false,
  } });
});

test.each([
  [["codex"], ["codex"]], [["claude"], ["claude"]],
  [["claude", "codex", "claude"], ["claude", "codex"]],
  [["codex", "claude", "codex"], ["codex", "claude"]],
])("provider arguments %j retain first-occurrence order", (argv, providers) => {
  expect(parseCliArgs(argv)).toMatchObject({ ok: true, options: { providers } });
});

test.each([
  [["--json"], { json: true }], [["--analytics"], { includeAnalytics: true }],
  [["--timeout", "1"], { timeoutMs: 1000 }], [["--timeout=2147483"], { timeoutMs: 2147483000 }],
  [["--timeout", "0002"], { timeoutMs: 2000 }], [["--no-color"], { noColor: true }],
  [["--debug"], { debug: true }], [["--help"], { action: "help" }], [["-h"], { action: "help" }],
  [["--version"], { action: "version" }], [["-V"], { action: "version" }],
])("parses options %j", (argv, options) => {
  expect(parseCliArgs(argv)).toMatchObject({ ok: true, options });
});

test("options may surround providers without mutating argv", () => {
  const argv = ["--debug", "claude", "--json", "codex", "--analytics", "--no-color", "--timeout", "30"];
  const original = [...argv];
  expect(parseCliArgs(argv)).toEqual({ ok: true, options: { action: "fetch", providers: ["claude", "codex"],
    json: true, includeAnalytics: true, timeoutMs: 30000, noColor: true, debug: true } });
  expect(argv).toEqual(original);
});

describe("usage errors", () => {
  test.each([
    ["--raw"], ["--watch"], ["--watch", "60"], ["--bogus"], ["bogus"],
    ["--timeout", "0"], ["--timeout", "-1"], ["--timeout=-1"], ["--timeout", "1.5"],
    ["--timeout", "abc"], ["--timeout", "2147484"], ["--timeout"], ["--timeout="],
    ["--timeout", "1e3"], ["--timeout", "+1"], ["--timeout", " 1"], ["--json=true"],
  ])("rejects %j", (...argv) => {
    expect(parseCliArgs(argv)).toEqual({ ok: false, message: expect.any(String) });
  });
});

function report(statuses: FetchStatus[], limited = false): UsageReport {
  return UsageReportSchema.parse({ schemaVersion: 1, tool: { name: "agent-usage", version: "0.1.0" },
    generatedAt: "2026-10-01T13:40:00.000Z", providers: statuses.map((status, index) => ({
      provider: index === 0 ? "codex" : "claude", status, fetchedAt: "2026-10-01T13:40:00.000Z", durationMs: 0,
      source: { method: index === 0 ? "codex-app-server" : "claude-control-get-usage",
        stability: index === 0 ? "supported" : "experimental", providerVersion: null },
      account: null, availability: { state: status === "error" ? "unknown" : limited ? "limited" : "available",
        basis: status === "error" ? "none" : "provider_flag", reason: null, exhaustedLimitIds: [] },
      limits: [], credits: [], resetCredits: null, analytics: null, warnings: [],
      errors: status === "ok" ? [] : [{ code: "timeout", message: "Timed out.", retryable: true, hint: null }],
    })) });
}

test.each<[FetchStatus[], number]>([
  [["ok", "ok"], 0], [["ok", "partial"], 0], [["partial", "partial"], 0],
  [["ok", "error"], 3], [["partial", "error"], 3], [["error", "ok"], 3],
  [["error", "error"], 4], [["ok"], 0], [["partial"], 0], [["error"], 4],
])("exit statuses %j map to %s", (statuses, expected) => {
  expect(exitCodeFor(report(statuses))).toBe(expected);
});

test("limited availability does not change a successful exit code", () => {
  expect(exitCodeFor(report(["ok"], true))).toBe(0);
});

test("exit constants include usage, internal and interruption failures", () => {
  expect(EXIT_CODES).toEqual({ SUCCESS: 0, INTERNAL: 1, USAGE: 2, SOME_FAILED: 3, ALL_FAILED: 4, INTERRUPTED: 130 });
});

test("JSON rendering uses two-space indentation and exactly one trailing newline", () => {
  const input = report(["ok"]);
  expect(renderJson(input)).toBe(`${JSON.stringify(input, null, 2)}\n`);
  expect(JSON.parse(renderJson(input))).toEqual(input);
});
