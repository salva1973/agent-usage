import { expect, test } from "vitest";
import { LimitIdAllocator, slug } from "../../../src/domain/ids.js";
import type { ProviderIssue } from "../../../src/domain/model.js";

test.each([
  ["Opus", "opus"], ["GPT-5.x-Codex-Spark", "gpt_5_x_codex_spark"],
  ["  OAuth... Apps!!", "oauth_apps"], ["___Fable___", "fable"],
  ["À B", "b"], ["!!!", ""], ["", ""],
])("slug(%s) = %s", (input, expected) => expect(slug(input)).toBe(expected));

test("suffixes repeated ids in order and warns once for each collision", () => {
  const allocator = new LimitIdAllocator();
  const warnings: ProviderIssue[] = [];
  expect(allocator.allocate("weekly", warnings)).toBe("weekly");
  expect(allocator.allocate("session", warnings)).toBe("session");
  expect(warnings).toEqual([]);
  expect(allocator.allocate("weekly", warnings)).toBe("weekly#2");
  expect(allocator.allocate("weekly", warnings)).toBe("weekly#3");
  expect(allocator.allocate("session", warnings)).toBe("session#2");
  expect(warnings.map((issue) => issue.code)).toEqual(Array(3).fill("duplicate_limit_id"));
});

test("does not collide with ids which already contain a suffix", () => {
  const allocator = new LimitIdAllocator();
  expect(allocator.allocate("weekly#2")).toBe("weekly#2");
  expect(allocator.allocate("weekly")).toBe("weekly");
  expect(allocator.allocate("weekly")).toBe("weekly#3");
});

test("allocators are isolated to a single report", () => {
  expect(new LimitIdAllocator().allocate("session")).toBe("session");
  expect(new LimitIdAllocator().allocate("session")).toBe("session");
});
