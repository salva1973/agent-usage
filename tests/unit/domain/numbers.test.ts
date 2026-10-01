import { describe, expect, test } from "vitest";
import type { ProviderIssue } from "../../../src/domain/model.js";
import { clamp, isDecimalString, round2, safeInt, toDecimal } from "../../../src/domain/numbers.js";

describe("round2 and clamp", () => {
  test.each([[0, 0], [12.345, 12.35], [1.005, 1.01], [-12.346, -12.35], [1e-7, 0], [105.678, 105.68], [Number.MAX_VALUE, Number.MAX_VALUE]])(
    "round2(%s) = %s", (input, expected) => expect(round2(input)).toBe(expected),
  );
  test.each([[-10, 0], [0, 0], [45.5, 45.5], [100, 100], [110, 100]])(
    "clamp(%s, 0, 100) = %s", (input, expected) => expect(clamp(input, 0, 100)).toBe(expected),
  );
  test("rounding removes negative zero", () => expect(Object.is(round2(-0.001), -0)).toBe(false));
});

describe("toDecimal", () => {
  test.each([
    [0, 0, "0"], [0, 2, "0.00"], [24000, 2, "240.00"], [5, 2, "0.05"],
    [123, 0, "123"], [1, 6, "0.000001"], [Number.MAX_SAFE_INTEGER, 2, "90071992547409.91"],
  ])("converts %s at %s dp exactly", (input, dp, expected) => expect(toDecimal(input, dp)).toBe(expected));
  test.each([-1, 0.5, NaN, Infinity, "24000"])("rejects invalid minor units %s", (input) => {
    const warnings: ProviderIssue[] = [];
    expect(toDecimal(input, 2, warnings)).toBeNull();
    expect(warnings.map((issue) => issue.code)).toEqual(["invalid_number"]);
  });
  test("rejects unsafe integers rather than silently losing precision", () => {
    const warnings: ProviderIssue[] = [];
    expect(toDecimal(Number.MAX_SAFE_INTEGER + 1, 2, warnings)).toBeNull();
    expect(warnings.map((issue) => issue.code)).toEqual(["precision_loss"]);
  });
  test.each([-1, 7, 1.5, NaN, Infinity])("rejects ambiguous decimal places %s", (dp) => {
    const warnings: ProviderIssue[] = [];
    expect(toDecimal(0, dp, warnings)).toBeNull();
    expect(warnings.map((issue) => issue.code)).toEqual(["ambiguous_units"]);
  });
  test("unknown amounts remain null without a warning", () => {
    const warnings: ProviderIssue[] = [];
    expect(toDecimal(null, 2, warnings)).toBeNull();
    expect(warnings).toEqual([]);
  });
});

describe("safeInt and isDecimalString", () => {
  test.each([0, -1, 3103172254, Number.MAX_SAFE_INTEGER])("retains safe integer %s", (input) => expect(safeInt(input)).toBe(input));
  test.each([null, undefined])("retains unknown %s", (input) => {
    const warnings: ProviderIssue[] = [];
    expect(safeInt(input, warnings)).toBeNull();
    expect(warnings).toEqual([]);
  });
  test.each([NaN, Infinity, -Infinity, 1.5, "10"])("rejects invalid integer %s", (input) => {
    const warnings: ProviderIssue[] = [];
    expect(safeInt(input, warnings)).toBeNull();
    expect(warnings[0]?.code).toBe("invalid_number");
  });
  test.each(["0", "452.0439000000", "-12.00", "001.20"])("recognizes decimal string %s", (input) => expect(isDecimalString(input)).toBe(true));
  test.each([null, 1, "1e3", ".5", "1.", "+1", "NaN", " 1", "1,000"])("rejects non-decimal %s", (input) => expect(isDecimalString(input)).toBe(false));
});
