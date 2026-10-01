import { expect, test } from "vitest";
import { ISSUE_CODES, makeIssue } from "../../../src/domain/issues.js";

test("IssueCode matches the complete Section 6.2 list", () => {
  expect(ISSUE_CODES).toEqual([
    "not_installed", "not_authenticated", "unsupported_auth", "rate_limits_unavailable",
    "upstream_unavailable", "upstream_error", "timeout", "process_error", "protocol_error",
    "incompatible_provider", "aborted", "internal",
  ]);
  expect(Object.isFrozen(ISSUE_CODES)).toBe(true);
});

test("applies retry defaults and allows explicit overrides", () => {
  expect(makeIssue("upstream_unavailable", "Network failed.").retryable).toBe(true);
  expect(makeIssue("not_authenticated", "Login required.").retryable).toBe(false);
  expect(makeIssue("upstream_error", "Invalid params.", { retryable: false }).retryable).toBe(false);
  expect(makeIssue("future_code", "Future issue.", { retryable: true }).retryable).toBe(true);
  expect(makeIssue("invalid_number", "Warning.").retryable).toBe(false);
});

test("redacts before truncating messages and also redacts hints", () => {
  const prefix = "Normal text. ".repeat(24);
  const issue = makeIssue("upstream_error", `${prefix}Bearer secret${"z".repeat(100)}`, {
    hint: "Ask user@example.invalid.",
  });
  expect(issue.message.length).toBeLessThanOrEqual(300);
  expect(issue.message).not.toContain("secret");
  expect(issue.hint).toBe("Ask [REDACTED]");
  expect(makeIssue("internal", "Failure.").hint).toBeNull();
});

test("warning and future codes retain the common issue shape", () => {
  expect(makeIssue("future_warning", "Observation.")).toEqual({
    code: "future_warning", message: "Observation.", retryable: false, hint: null,
  });
});
