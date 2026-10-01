import { expect, test } from "vitest";
import { findLimit, type ProviderReport } from "../../src/index.js";
import { normalizeClaudeUsage } from "../../src/providers/claude/normalize.js";
import { GetUsageResponseSchema } from "../../src/providers/claude/schema.js";
import { fixture, fixedNow } from "../helpers/claude.js";

function report(name = "get-usage-pro.json"): ProviderReport {
  return { ...normalizeClaudeUsage(GetUsageResponseSchema.parse(fixture(name)), { providerVersion: "2.1.286", includeAnalytics: false }),
    fetchedAt: fixedNow, durationMs: 0 };
}
test.each(["session", "weekly"])("findLimit finds %s by exact id on a normalized report", (id) => {
  const data = report();
  expect(findLimit(data, id)).toBe(data.limits.find((limit) => limit.id === id));
  expect(findLimit(data, id)?.id).toBe(id);
});
test.each(["missing", "SESSION", "week", "Weekly", ""])("findLimit returns undefined for unmatched id %s", (id) => {
  expect(findLimit(report(), id)).toBeUndefined();
});
test("findLimit does not confuse scoped limits with the account-wide weekly limit", () => {
  const data = report("get-usage-max-scoped.json");
  expect(findLimit(data, "weekly")?.scope).toEqual({ type: "account" });
  expect(findLimit(data, "weekly:model:opus")?.scope).toEqual({ type: "model", model: "opus" });
});
