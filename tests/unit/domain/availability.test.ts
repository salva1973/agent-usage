import { expect, test } from "vitest";
import { deriveAvailability } from "../../../src/domain/availability.js";
import type { LimitScope, RateLimit } from "../../../src/domain/model.js";

function limit(id: string, usedPercent: number | null, scope: LimitScope = { type: "account" }): RateLimit {
  return {
    id, kind: "weekly", scope, label: "Weekly", usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    windowMinutes: 10080, windowSource: "inferred", resetsAt: null,
    providerKey: "test.weekly",
  };
}

test("empty limits mean unknown; the caller can preserve a derived basis", () => {
  expect(deriveAvailability([])).toEqual({ state: "unknown", basis: "none", reason: null, exhaustedLimitIds: [] });
  expect(deriveAvailability([], "derived_from_limits")).toEqual({
    state: "unknown", basis: "derived_from_limits", reason: null, exhaustedLimitIds: [],
  });
});

test("existing limits imply available unless an account limit is exhausted", () => {
  expect(deriveAvailability([limit("weekly", 99.99), limit("session", null)])).toEqual({
    state: "available", basis: "derived_from_limits", reason: null, exhaustedLimitIds: [],
  });
  expect(deriveAvailability([limit("weekly", null)]).state).toBe("available");
});

test("account exhaustion determines the reason, while every scope is recorded", () => {
  const limits = [
    limit("weekly:model:opus", 100, { type: "model", model: "opus" }),
    limit("weekly", 101), limit("session", 100),
    limit("weekly:product:cowork", 100, { type: "product", product: "cowork" }),
    limit("weekly:bucket:extra", 100, { type: "bucket", bucket: "extra", name: null, model: null }),
  ];
  const before = structuredClone(limits);
  expect(deriveAvailability(limits)).toEqual({
    state: "limited", basis: "derived_from_limits", reason: "limit_exhausted:weekly",
    exhaustedLimitIds: limits.map((entry) => entry.id),
  });
  expect(limits).toEqual(before);
});

test.each<LimitScope>([
  { type: "model", model: "opus" }, { type: "product", product: "cowork" },
  { type: "bucket", bucket: "extra", name: null, model: null },
])("scoped exhaustion alone leaves the provider available: %j", (scope) => {
  expect(deriveAvailability([limit("scoped", 100, scope)])).toEqual({
    state: "available", basis: "derived_from_limits", reason: null, exhaustedLimitIds: ["scoped"],
  });
});
