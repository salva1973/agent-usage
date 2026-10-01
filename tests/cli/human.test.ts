import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { UsageReportSchema, type ProviderReport, type UsageReport } from "../../src/index.js";
import { renderHuman } from "../../src/cli/render/human.js";
import { normalizeCodexUsage } from "../../src/providers/codex/normalize.js";
import { GetAccountRateLimitsResponseSchema, GetAccountTokenUsageResponseSchema } from "../../src/providers/codex/schema.js";
import { normalizeClaudeUsage } from "../../src/providers/claude/normalize.js";
import { GetUsageResponseSchema } from "../../src/providers/claude/schema.js";
import { fixture as codexFixture } from "../helpers/codex.js";
import { fixture as claudeFixture } from "../helpers/claude.js";

const now = new Date("2026-10-01T13:40:00Z");
const opts = { color: false, debug: false, now };
const codexPlain = `CODEX · plus · available
  5h            0% used   resets today 18:39          (in 4h 59m)
  Weekly       22% used   resets Sun 04 Oct 13:09     (in 2d 23h)
  Credits      452.04 credits
  Resets       2 reset credits available (never used by agent-usage)
`;
const claudePlain = `CLAUDE · pro · available (derived)
  5h            2% used   resets today 17:30          (in 3h 50m)
  Weekly       11% used   resets Tue 06 Oct 15:00     (in 5d 1h)
  Extra usage  off (out_of_credits) · 0.00 / 240.00 EUR
`;

beforeEach(() => vi.stubEnv("TZ", "UTC"));
afterEach(() => vi.unstubAllEnvs());

function codex(name = "ratelimits-plus.json"): ProviderReport {
  return { ...normalizeCodexUsage(GetAccountRateLimitsResponseSchema.parse(codexFixture(name)), {
    account: { type: "chatgpt", planType: "plus" }, providerVersion: "0.159.2",
  }), fetchedAt: now.toISOString(), durationMs: 0 };
}

function claude(name = "get-usage-pro.json"): ProviderReport {
  return { ...normalizeClaudeUsage(GetUsageResponseSchema.parse(claudeFixture(name)), {
    providerVersion: "2.1.286", includeAnalytics: false,
  }), fetchedAt: now.toISOString(), durationMs: 0 };
}

function report(...providers: ProviderReport[]): UsageReport {
  return UsageReportSchema.parse({ schemaVersion: 1, tool: { name: "agent-usage", version: "0.1.0" }, generatedAt: now.toISOString(), providers });
}

function failed(code = "not_authenticated", message = "Claude is not logged in.", hint: string | null = "Run `claude` and use /login."): ProviderReport {
  const base = claude();
  return { ...base, status: "error", account: null, limits: [], credits: [],
    availability: { state: "unknown", basis: "none", reason: null, exhaustedLimitIds: [] },
    errors: [{ code, message, retryable: false, hint }] };
}

test("fixture-derived golden example matches byte for byte", () => {
  expect(renderHuman(report(codex(), claude()), opts)).toBe(`${codexPlain}\n${claudePlain}`);
});

test("authentication error matches the exact block and hint indentation", () => {
  expect(renderHuman(report(failed()), opts)).toBe("CLAUDE · error\n  not_authenticated  Claude is not logged in.\n                     → Run `claude` and use /login.\n");
});

test("Codex limited fixture renders its explicit reason", () => {
  expect(renderHuman(report(codex("ratelimits-reached.json")), opts)).toBe(`CODEX · plus · LIMITED (rate_limit_reached)
  5h          100% used   resets today 18:39          (in 4h 59m)
  Weekly       22% used   resets Sun 04 Oct 13:09     (in 2d 23h)
  Credits      452.04 credits
  Resets       2 reset credits available (never used by agent-usage)
`);
});

test("Claude scoped fixture keeps scoped rows after the canonical windows", () => {
  const provider = claude("get-usage-max-scoped.json");
  const limitWidth = Math.max(12, ...provider.limits.map((limit) => limit.label.length + 1));
  const infoWidth = Math.max(13, limitWidth + 1, ...provider.credits.map((credit) => credit.label.length + 2));
  const literal = `CLAUDE · max · available (derived)
  5h                    2% used   resets today 17:30          (in 3h 50m)
  Weekly               11% used   resets Tue 06 Oct 15:00     (in 5d 1h)
  Weekly (Opus)       100% used   resets Tue 06 Oct 15:00     (in 5d 1h)
  Weekly (Sonnet)      20% used   resets Tue 06 Oct 15:00     (in 5d 1h)
  Weekly (OAuth apps)  12% used   resets Tue 06 Oct 15:00     (in 5d 1h)
  Weekly (Cowork)       9% used   resets Tue 06 Oct 15:00     (in 5d 1h)
  Weekly (Fable)       40% used   resets Tue 06 Oct 15:00     (in 5d 1h)
  nimbus_quill          5% used   resets Tue 06 Oct 15:00     (in 5d 1h)
  Extra usage          off (out_of_credits) · 0.00 / 240.00 EUR
`;
  // Verify the handoff's literal against its width rule before using it as the oracle.
  expect({ limitWidth, infoWidth }).toEqual({ limitWidth: 20, infoWidth: 21 });
  const lines = literal.split("\n");
  provider.limits.forEach((limit, index) => {
    expect(lines[index + 1]!.startsWith(`  ${limit.label.padEnd(limitWidth)}${String(limit.usedPercent).padStart(3)}% used   `)).toBe(true);
  });
  expect(lines.at(-2)).toBe(`  ${"Extra usage".padEnd(infoWidth)}off (out_of_credits) · 0.00 / 240.00 EUR`);
  expect(renderHuman(report(provider), opts)).toBe(literal);
});

test.each(["codex", "claude"])("%s short-label rows retain the 12/13 minimum widths", (id) => {
  const provider = id === "codex" ? codex() : claude();
  const output = renderHuman(report(provider), opts);
  expect(output).toBe(id === "codex" ? codexPlain : claudePlain);
  const limits = output.split("\n").filter((line) => line.includes("% used"));
  expect(limits.map((line) => line.indexOf("%"))).toEqual([17, 17]);
  const credit = provider.credits[0]!;
  const creditLine = output.split("\n").find((line) => line.startsWith(`  ${credit.label}`))!;
  expect(creditLine.slice(0, 15)).toBe(`  ${credit.label.padEnd(13)}`);
});

test("a single forty-character limit label always leaves a separating space", () => {
  const provider = codex();
  const label = "L".repeat(40);
  provider.limits = [{ ...provider.limits[0]!, label, usedPercent: 100, remainingPercent: 0, resetsAt: null }];
  const lines = renderHuman(report(provider), opts).split("\n");
  expect(lines[1]).toBe(`  ${label} 100% used`);
  expect(lines[1]!.indexOf("%")).toBe(46);
  expect(lines[2]).toBe(`  Credits${" ".repeat(35)}452.04 credits`);
  expect(lines[3]).toBe(`  Resets${" ".repeat(36)}2 reset credits available (never used by agent-usage)`);
});

test("long credit labels widen all info rows and leave limit columns at their minimum", () => {
  const provider = codex();
  const label = "C".repeat(40);
  provider.credits[0]!.label = label;
  provider.credits.push({ ...claude().credits[0]! });
  provider.analytics = { lifetimeTokens: 0, peakDailyTokens: null, longestRunningTurnSec: null,
    currentStreakDays: null, longestStreakDays: null, daily: [] };
  const lines = renderHuman(report(provider), opts).split("\n");
  expect(lines.slice(1, 3).map((line) => line.indexOf("%"))).toEqual([17, 17]);
  expect(lines.slice(3, 7)).toEqual([
    `  ${label}  452.04 credits`,
    `  Extra usage${" ".repeat(31)}off (out_of_credits) · 0.00 / 240.00 EUR`,
    `  Resets${" ".repeat(36)}2 reset credits available (never used by agent-usage)`,
    `  Tokens${" ".repeat(36)}lifetime 0 · peak day ? · last 7 days 0`,
  ]);
  expect(lines.slice(3, 7).map((line) => line.slice(44))).toEqual([
    "452.04 credits", "off (out_of_credits) · 0.00 / 240.00 EUR",
    "2 reset credits available (never used by agent-usage)", "lifetime 0 · peak day ? · last 7 days 0",
  ]);
});

test("scoped widths are local to their provider block", () => {
  const output = renderHuman(report(claude("get-usage-max-scoped.json"), codex()), opts);
  const [scoped, short] = output.trimEnd().split("\n\n");
  expect(scoped!.split("\n")[1]).toBe("  5h                    2% used   resets today 17:30          (in 3h 50m)");
  expect(`${short}\n`).toBe(codexPlain);
});

test.each([false, true])("all scoped percent columns align with color=%s", (color) => {
  const provider = claude("get-usage-max-scoped.json");
  const output = renderHuman(report(provider), { ...opts, color }).replace(/\u001b\[\d+m/g, "");
  const rows = output.split("\n").filter((line) => line.includes("% used"));
  expect(rows).toHaveLength(provider.limits.length);
  expect(rows.every((line) => line.indexOf("%") === 25)).toBe(true);
  for (const [index, limit] of provider.limits.entries()) expect(rows[index]!.slice(2 + limit.label.length)).toMatch(/^ +\d/);
});

test("info-only providers retain the minimum width", () => {
  const provider = codex();
  provider.limits = [];
  expect(renderHuman(report(provider), opts)).toBe(`CODEX · plus · available
  Credits      452.04 credits
  Resets       2 reset credits available (never used by agent-usage)
`);
});

test("widening a label leaves partial issues and debug warnings untouched", () => {
  const provider = codex();
  provider.limits[0]!.label = "L".repeat(40);
  provider.status = "partial";
  provider.errors = [{ code: "analytics_failed", message: "Analytics failed.", retryable: true, hint: null }];
  provider.warnings = [{ code: "precision_loss", message: "Count omitted.", retryable: false, hint: null }];
  const output = renderHuman(report(provider), { ...opts, debug: true });
  expect(output.split("\n").slice(-3)).toEqual([
    "  ! analytics_failed  Analytics failed.", "  · precision_loss  Count omitted.", "",
  ]);
});

test("partial analytics failure follows the ordinary observation rows", () => {
  const provider = codex();
  provider.status = "partial";
  provider.errors = [{ code: "analytics_failed", message: "Token analytics unavailable.", retryable: true, hint: null }];
  expect(renderHuman(report(provider), opts)).toBe(`${codexPlain}  ! analytics_failed  Token analytics unavailable.\n`);
});

test("analytics fixture renders compact counts and sums recent daily buckets", () => {
  const provider = codex();
  provider.analytics = normalizeCodexUsage(GetAccountRateLimitsResponseSchema.parse(codexFixture("ratelimits-plus.json")), {
    account: null, providerVersion: null, analytics: GetAccountTokenUsageResponseSchema.parse(codexFixture("usage.json")),
  }).analytics;
  expect(renderHuman(report(provider), opts)).toBe(`${codexPlain}  Tokens       lifetime 3.10B · peak day 108.43M · last 7 days 15.0k\n`);
});

test.each(["UTC", "Europe/Rome"])("analytics includes the local six-day cutoff in %s", (timezone) => {
  vi.stubEnv("TZ", timezone);
  const provider = codex();
  provider.analytics = { lifetimeTokens: 12400000, peakDailyTokens: null, longestRunningTurnSec: null,
    currentStreakDays: null, longestStreakDays: null, daily: [
      { date: "2026-09-24", tokens: 10000 }, { date: "2026-09-25", tokens: 2000 },
      { date: "2026-09-26", tokens: 3000 }, { date: "2026-10-01", tokens: 4000 },
    ] };
  const output = renderHuman(report(provider), { ...opts, now: new Date("2026-10-01T22:30:00Z") });
  expect(output.split("\n").at(-2)).toBe(`  Tokens       lifetime 12.40M · peak day ? · last 7 days ${timezone === "UTC" ? "9.0k" : "7.0k"}`);
});

test("analytics with no buckets displays zero rather than an unknown sum", () => {
  const provider = codex();
  provider.analytics = { lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null,
    currentStreakDays: null, longestStreakDays: null, daily: [] };
  expect(renderHuman(report(provider), opts)).toBe(`${codexPlain}  Tokens       lifetime ? · peak day ? · last 7 days 0\n`);
});

test.each([
  ["not_installed", "Claude binary was not found."], ["timeout", "Claude usage timed out."],
])("%s error renders without a plan or absent hint", (code, message) => {
  expect(renderHuman(report(failed(code, message, null)), opts)).toBe(`CLAUDE · error\n  ${code}  ${message}\n`);
});

test("each error gets a block, with the hint aligned independently", () => {
  const provider = failed("timeout", "Timed out.", null);
  provider.errors.push({ code: "internal", message: "Internal failure.", retryable: false, hint: "Check diagnostics." });
  expect(renderHuman(report(provider), opts)).toBe("CLAUDE · error\n  timeout  Timed out.\n  internal  Internal failure.\n            → Check diagnostics.\n");
});

test("unknown availability and plan remain visibly unknown", () => {
  const provider = codex();
  provider.account = null;
  provider.availability = { state: "unknown", basis: "none", reason: null, exhaustedLimitIds: [] };
  expect(renderHuman(report(provider), opts)).toBe(codexPlain.replace("plus · available", "unknown plan · status unknown"));
});

test("a null plan falls back to unknown plan", () => {
  const provider = codex();
  provider.account = { plan: null, authMode: "chatgpt" };
  expect(renderHuman(report(provider), opts)).toBe(codexPlain.replace("plus", "unknown plan"));
});

test("limited state without a reason has no parentheses", () => {
  const provider = codex("ratelimits-reached.json");
  provider.availability.reason = null;
  expect(renderHuman(report(provider), opts).split("\n")[0]).toBe("CODEX · plus · LIMITED");
});

test("derived limited state stays labelled as derived", () => {
  expect(renderHuman(report(claude("get-usage-exhausted.json")), opts).split("\n")[0]).toBe("CLAUDE · pro · LIMITED (limit_exhausted:session) (derived)");
});

test.each([false, true])("warnings appear only when debug=%s, after all other rows", (debug) => {
  const provider = codex();
  provider.status = "partial";
  provider.errors = [{ code: "analytics_failed", message: "Analytics failed.", retryable: true, hint: null }];
  provider.warnings = [{ code: "invalid_number", message: "Unknown percentage.", retryable: false, hint: null }];
  expect(renderHuman(report(provider), { ...opts, debug })).toBe(`${codexPlain}  ! analytics_failed  Analytics failed.\n${debug ? "  · invalid_number  Unknown percentage.\n" : ""}`);
});

test("warnings on an error report appear after the error blocks", () => {
  const provider = failed("timeout", "Timed out.", null);
  provider.warnings = [{ code: "auth_status_failed", message: "Auth helper failed.", retryable: false, hint: null }];
  expect(renderHuman(report(provider), { ...opts, debug: true })).toBe("CLAUDE · error\n  timeout  Timed out.\n  · auth_status_failed  Auth helper failed.\n");
});

test("null percentages and reset timestamps have no invented time or trailing padding", () => {
  const provider = codex();
  provider.limits = [{ ...provider.limits[0]!, usedPercent: null, remainingPercent: null, resetsAt: null }];
  provider.credits = [];
  provider.resetCredits = null;
  expect(renderHuman(report(provider), opts)).toBe("CODEX · plus · available\n  5h            ?% used\n");
});

test("canonical windows sort first and all other limits retain report order", () => {
  const provider = claude("get-usage-max-scoped.json");
  const [session, weekly, ...others] = provider.limits;
  provider.limits = [others[1]!, weekly!, others[0]!, session!, ...others.slice(2)];
  const output = renderHuman(report(provider), opts);
  expect(output.split("\n").slice(1, 5).map((line) => line.trimStart().split("% used")[0])).toEqual([
    "5h                    2", "Weekly               11", "Weekly (Sonnet)      20", "Weekly (Opus)       100",
  ]);
});

test("provider order, one separating blank line and one final newline are preserved", () => {
  expect(renderHuman(report(claude(), codex()), opts)).toBe(`${claudePlain}\n${codexPlain}`);
});

test("trailing newlines in provider error text do not add blank lines between providers or at the end", () => {
  const error = failed("process_error", "Process exited.\n", null);
  expect(renderHuman(report(error, codex()), opts)).toBe(`CLAUDE · error\n  process_error  Process exited.\n\n${codexPlain}`);
  expect(renderHuman(report(error), opts)).toBe("CLAUDE · error\n  process_error  Process exited.\n");
});

test.each([0, 1, 2])("reset-credit count %s uses the required visibility and plural", (availableCount) => {
  const provider = codex();
  provider.resetCredits = { availableCount };
  const prefix = codexPlain.slice(0, codexPlain.indexOf("  Resets"));
  const suffix = availableCount === 0 ? "" : `  Resets       ${availableCount} reset credit${availableCount === 1 ? "" : "s"} available (never used by agent-usage)\n`;
  expect(renderHuman(report(provider), opts)).toBe(prefix + suffix);
});

test.each([
  [{ unlimited: true, balance: null }, "unlimited"], [{ unlimited: false, balance: null }, "unknown"],
  [{ unlimited: false, balance: "1.2345" }, "1.23 credits"],
])("provider credits display %j without changing their exact balance", (patch, text) => {
  const provider = codex();
  Object.assign(provider.credits[0]!, patch);
  const input = report(provider);
  const original = JSON.stringify(input);
  expect(renderHuman(input, opts)).toContain(`  Credits      ${text}\n`);
  expect(JSON.stringify(input)).toBe(original);
});

test.each([
  [{ enabled: true, disabledReason: null }, "on · 0.00 / 240.00 EUR"],
  [{ enabled: null, disabledReason: null, used: null }, "?"],
  [{ enabled: false, disabledReason: "disabled", limit: null }, "off (disabled)"],
])("currency credits display %j with no unknown amounts invented", (patch, text) => {
  const provider = claude();
  Object.assign(provider.credits[0]!, patch);
  expect(renderHuman(report(provider), opts)).toContain(`  Extra usage  ${text}\n`);
});

test("multiple credits retain report order before reset credits and analytics", () => {
  const provider = codex();
  provider.credits.push({ ...claude().credits[0]!, label: "Extra usage" });
  expect(renderHuman(report(provider), opts).split("\n").slice(3, 6)).toEqual([
    "  Credits      452.04 credits", "  Extra usage  off (out_of_credits) · 0.00 / 240.00 EUR",
    "  Resets       2 reset credits available (never used by agent-usage)",
  ]);
});

test("rendering leaves the report and injected clock unchanged", () => {
  const input = report(claude("get-usage-max-scoped.json"), codex());
  const before = JSON.stringify(input);
  const clock = now.getTime();
  renderHuman(input, opts);
  expect(JSON.stringify(input)).toBe(before);
  expect(now.getTime()).toBe(clock);
});

test("color styles headers, presentation thresholds and derived annotations", () => {
  const provider = claude();
  provider.limits[0]!.usedPercent = 70;
  provider.limits[0]!.remainingPercent = 30;
  provider.limits[1]!.usedPercent = 90;
  provider.limits[1]!.remainingPercent = 10;
  const input = report(provider);
  const output = renderHuman(input, { ...opts, color: true });
  expect(output).toContain("\u001b[1mCLAUDE\u001b[0m");
  expect(output).toContain("\u001b[2m (derived)\u001b[0m");
  expect(output).toContain("\u001b[33m 70%\u001b[0m used");
  expect(output).toContain("\u001b[31m 90%\u001b[0m used");
  expect(output.replace(/\u001b\[\d+m/g, "")).toBe(renderHuman(input, opts));
  expect(renderHuman(input, opts)).not.toContain("\u001b");
});

test.each([69.99, 70, 89.99, 90])("color threshold uses the observed percentage %s before display rounding", (usedPercent) => {
  const provider = codex();
  provider.limits = [{ ...provider.limits[0]!, usedPercent, remainingPercent: 100 - usedPercent, resetsAt: null }];
  const line = renderHuman(report(provider), { ...opts, color: true }).split("\n")[1]!;
  expect(line.includes("\u001b[33m")).toBe(usedPercent >= 70 && usedPercent < 90);
  expect(line.includes("\u001b[31m")).toBe(usedPercent >= 90);
});

test("limited and unknown headers, partial issues, errors and warnings get their specified colors", () => {
  expect(renderHuman(report(codex("ratelimits-reached.json")), { ...opts, color: true })).toContain("\u001b[31m\u001b[1mLIMITED (rate_limit_reached)\u001b[0m");
  const unknown = codex();
  unknown.availability.state = "unknown";
  expect(renderHuman(report(unknown), { ...opts, color: true })).toContain("\u001b[33mstatus unknown\u001b[0m");
  const partial = codex();
  partial.status = "partial";
  partial.errors = [{ code: "analytics_failed", message: "Unavailable.", retryable: true, hint: null }];
  partial.warnings = [{ code: "precision_loss", message: "Count omitted.", retryable: false, hint: null }];
  const output = renderHuman(report(partial), { ...opts, color: true, debug: true });
  expect(output).toContain("\u001b[33m  ! analytics_failed  Unavailable.\u001b[0m");
  expect(output).toContain("\u001b[2m  · precision_loss  Count omitted.\u001b[0m");
  const error = renderHuman(report(failed()), { ...opts, color: true });
  expect(error).toContain("\u001b[31m\u001b[1mCLAUDE\u001b[0m\u001b[31m · error\u001b[0m");
  expect(error).toContain("  \u001b[31mnot_authenticated\u001b[0m  Claude is not logged in.");
});
