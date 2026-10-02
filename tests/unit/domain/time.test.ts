import { describe, expect, test } from "vitest";
import type { ProviderIssue } from "../../../src/domain/model.js";
import { epochToIso, formatDuration, isoOrNull } from "../../../src/domain/time.js";

describe("epochToIso", () => {
  test("uses seconds by default", () => {
    const warnings: ProviderIssue[] = [];
    expect(epochToIso(1790881920, warnings)).toBe("2026-10-01T19:12:00.000Z");
    expect(warnings).toEqual([]);
  });
  test("detects milliseconds and warns", () => {
    const warnings: ProviderIssue[] = [];
    expect(epochToIso(1790881920000, warnings)).toBe("2026-10-01T19:12:00.000Z");
    expect(warnings.map((issue) => issue.code)).toEqual(["timestamp_unit_heuristic"]);
  });
  test.each([0, -1, NaN, Infinity, -Infinity, "1790881920"])("rejects invalid timestamp %s", (input) => {
    const warnings: ProviderIssue[] = [];
    expect(epochToIso(input, warnings)).toBeNull();
    expect(warnings.map((issue) => issue.code)).toEqual(["invalid_timestamp"]);
  });
  test("detects the millisecond boundary at exactly 1e11", () => {
    const warnings: ProviderIssue[] = [];
    expect(epochToIso(1e11, warnings)).toBe("1973-03-03T09:46:40.000Z");
    expect(warnings[0]?.code).toBe("timestamp_unit_heuristic");
    expect(epochToIso(1e11 - 1)).toBe(new Date((1e11 - 1) * 1000).toISOString());
  });
  test("rejects dates outside Date's range without throwing", () => {
    const warnings: ProviderIssue[] = [];
    expect(epochToIso(Number.MAX_VALUE, warnings)).toBeNull();
    expect(warnings.map((issue) => issue.code)).toEqual(["timestamp_unit_heuristic", "invalid_timestamp"]);
  });
  test("keeps null and undefined unknown", () => {
    const warnings: ProviderIssue[] = [];
    expect(epochToIso(null, warnings)).toBeNull();
    expect(epochToIso(undefined, warnings)).toBeNull();
    expect(warnings).toEqual([]);
  });
});

describe("isoOrNull", () => {
  test("normalizes microseconds and timezone offsets to UTC milliseconds", () => {
    expect(isoOrNull("2026-10-01T18:00:00.214031+00:00")).toBe("2026-10-01T18:00:00.214Z");
    expect(isoOrNull("2026-10-01T20:00:00.214+02:00")).toBe("2026-10-01T18:00:00.214Z");
  });
  test.each(["not a date", "", NaN, 123])("rejects invalid input %s", (input) => {
    const warnings: ProviderIssue[] = [];
    expect(isoOrNull(input, warnings)).toBeNull();
    expect(warnings[0]?.code).toBe("invalid_timestamp");
  });
  test("null and undefined do not warn", () => {
    const warnings: ProviderIssue[] = [];
    expect(isoOrNull(null, warnings)).toBeNull();
    expect(isoOrNull(undefined, warnings)).toBeNull();
    expect(warnings).toEqual([]);
  });
});

test.each([[90, "90m"], [480, "8h"], [4320, "3d"], [300, "5h"], [10080, "7d"], [0, "0m"], [61, "61m"], [1.5, "1.5m"]])(
  "formatDuration(%s) = %s", (input, expected) => expect(formatDuration(input)).toBe(expected),
);
