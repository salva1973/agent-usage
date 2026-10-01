import { makeIssue } from "./issues.js";
import type { ProviderIssue } from "./model.js";

/** Round to two decimal places without overflowing for large finite values. */
export function round2(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e15) return value;
  const [coefficient, exponent = "0"] = value.toString().split("e");
  const result = Math.round(Number(`${coefficient}e${Number(exponent) + 2}`)) / 100;
  return result === 0 ? 0 : result;
}

/** Bound a number to the inclusive interval [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Check the provider decimal-string format, preserving trailing zeros. */
export function isDecimalString(value: unknown): value is string {
  return typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value);
}

/** Return a safe integer or null, recording invalid numbers or precision loss. */
export function safeInt(value: unknown, warnings: ProviderIssue[] = []): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    warnings.push(makeIssue("invalid_number", "Expected a finite integer."));
    return null;
  }
  if (!Number.isSafeInteger(value)) {
    warnings.push(makeIssue("precision_loss", "Integer exceeds JavaScript's safe precision."));
    return null;
  }
  return value;
}

/** Convert nonnegative safe integer minor units using string math (0–6 dp). */
export function toDecimal(
  value: unknown,
  decimalPlaces: number,
  warnings: ProviderIssue[] = [],
): string | null {
  if (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 6) {
    warnings.push(makeIssue("ambiguous_units", "Decimal places must be an integer from 0 to 6."));
    return null;
  }
  const integer = safeInt(value, warnings);
  if (integer === null) return null;
  if (integer < 0) {
    warnings.push(makeIssue("invalid_number", "Minor units must be nonnegative."));
    return null;
  }
  const digits = integer.toString();
  if (decimalPlaces === 0) return digits;
  const padded = digits.padStart(decimalPlaces + 1, "0");
  return `${padded.slice(0, -decimalPlaces)}.${padded.slice(-decimalPlaces)}`;
}
