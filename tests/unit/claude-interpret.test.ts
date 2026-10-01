import { expect, test } from "vitest";
import { ClaudeAuthStatusSchema } from "../../src/providers/claude/authStatus.js";
import { ClaudeUsageError } from "../../src/providers/claude/controlClient.js";
import { interpretClaudeUsage } from "../../src/providers/claude/index.js";
import { ProviderReportSchema } from "../../src/domain/reportSchema.js";
import { fixedNow, fixture } from "../helpers/claude.js";

const options = { providerVersion: "2.1.286", includeAnalytics: false, authStatus: null };
const auth = (name: string) => ClaudeAuthStatusSchema.parse(fixture(name));

test.each([
  ["get-usage-pro.json", null], ["get-usage-max-scoped.json", null], ["get-usage-exhausted.json", null], ["get-usage-bad-extra.json", null],
  ["get-usage-malformed.json", "protocol_error"], ["get-usage-fetch-failed.json", "upstream_unavailable"],
  ["get-usage-unavailable.json", "rate_limits_unavailable"],
])("every usage fixture %s produces a schema-valid report", (name, code) => {
  const result = interpretClaudeUsage(fixture(name), options);
  expect(ProviderReportSchema.safeParse({ ...result, fetchedAt: fixedNow, durationMs: 0 }).success).toBe(true);
  expect(result.status).toBe(code === null ? "ok" : "error");
  expect(result.errors.map((issue) => issue.code)).toEqual(code === null ? [] : [code]);
});

test.each([
  ["auth-status-loggedout.json", "not_authenticated", "none"],
  ["auth-status-apikey.json", "unsupported_auth", "api_key"],
  ["auth-status-loggedin.json", "rate_limits_unavailable", "claude.ai"],
])("unavailable usage and %s classify as %s", (name, code, authMode) => {
  const result = interpretClaudeUsage(fixture("get-usage-unavailable.json"), { ...options, authStatus: auth(name) });
  expect(result.status).toBe("error");
  expect(result.errors[0]?.code).toBe(code);
  expect(result.account).toEqual(code === "not_authenticated" ? null : { plan: null, authMode });
  expect(result.warnings).toEqual([]);
  if (code === "not_authenticated") expect(result.errors[0]?.hint).toBe("Run `claude` and use /login.");
  if (code === "rate_limits_unavailable") expect(result.errors[0]?.hint).toContain("profile scope");
  if (code === "unsupported_auth") expect(result.errors[0]?.message).toContain("api_key, apiProvider firstParty");
});

test.each(["bedrock", "vertex", null])("claude.ai with apiProvider %s is unsupported", (apiProvider) => {
  const result = interpretClaudeUsage(fixture("get-usage-unavailable.json"), { ...options,
    authStatus: { ...auth("auth-status-loggedin.json"), apiProvider } });
  expect(result.errors[0]?.code).toBe("unsupported_auth");
});

test("logged-out classification wins over unsupported auth fields", () => {
  const result = interpretClaudeUsage(fixture("get-usage-unavailable.json"), { ...options,
    authStatus: { loggedIn: false, authMethod: "api_key", apiProvider: "bedrock", subscriptionType: null } });
  expect(result.errors[0]?.code).toBe("not_authenticated");
  expect(result.account).toBeNull();
});

test("failed auth status adds an auth_status_failed warning", () => {
  const result = interpretClaudeUsage(fixture("get-usage-unavailable.json"), options);
  expect(result.errors[0]?.code).toBe("rate_limits_unavailable");
  expect(result.warnings.map((issue) => issue.code)).toEqual(["auth_status_failed"]);
});

test("available with null or missing rate_limits is upstream_unavailable and retryable", () => {
  for (const value of [fixture("get-usage-fetch-failed.json"), { rate_limits_available: true }]) {
    const result = interpretClaudeUsage(value, options);
    expect(result.errors[0]).toMatchObject({ code: "upstream_unavailable", retryable: true });
    expect(result.errors[0]?.hint).toContain("network, rate limiting, or token refresh failure");
  }
});

test.each([[], "wrong", 4, true])("non-object rate_limits %j is protocol_error even if unavailable", (rate_limits) => {
  const result = interpretClaudeUsage({ rate_limits_available: false, rate_limits }, { ...options, authStatus: auth("auth-status-loggedout.json") });
  expect(result.errors[0]?.code).toBe("protocol_error");
  expect(result.errors[0]?.message).toContain("rate_limits");
});

test.each([{}, { rate_limits_available: "true" }, null])("invalid required flag %j is protocol_error", (value) => {
  expect(interpretClaudeUsage(value, options).errors[0]?.code).toBe("protocol_error");
});

test.each(["get_usage is not supported", "Unknown subtype get_usage", "Unsupported operation"])("unsupported control error %s", (message) => {
  expect(new ClaudeUsageError(message).issue).toMatchObject({ code: "incompatible_provider", retryable: false,
    hint: "Claude Code version may have changed the experimental get_usage API" });
});

test("other control errors are upstream_error and redacted", () => {
  const error = new ClaudeUsageError("fetch failed Bearer fake-secret leak@example.invalid");
  expect(error.issue).toMatchObject({ code: "upstream_error", retryable: true });
  expect(error.message).not.toMatch(/fake-secret|example\.invalid/);
});
