import { makeIssue } from "./issues.js";
import type { ProviderIssue } from "./model.js";

/** Convert positive epoch seconds; interpret values ≥ 1e11 as ms with a warning. */
export function epochToIso(value: unknown, warnings: ProviderIssue[] = []): string | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    warnings.push(makeIssue("invalid_timestamp", "Expected a positive finite epoch timestamp."));
    return null;
  }
  const milliseconds = value >= 1e11;
  if (milliseconds) {
    warnings.push(makeIssue("timestamp_unit_heuristic", "Epoch timestamp was interpreted as milliseconds."));
  }
  const date = new Date(milliseconds ? value : value * 1000);
  if (!Number.isFinite(date.getTime())) {
    warnings.push(makeIssue("invalid_timestamp", "Epoch timestamp is outside the supported date range."));
    return null;
  }
  return date.toISOString();
}

/** Normalize a parseable timestamp to UTC milliseconds; null stays unknown. */
export function isoOrNull(value: unknown, warnings: ProviderIssue[] = []): string | null {
  if (value == null) return null;
  const milliseconds = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(milliseconds)) {
    warnings.push(makeIssue("invalid_timestamp", "Timestamp could not be parsed."));
    return null;
  }
  return new Date(milliseconds).toISOString();
}

/** Format reported minutes using exact whole days or hours, otherwise minutes. */
export function formatDuration(minutes: number): string {
  if (minutes > 0 && minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes > 0 && minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}
