import { makeIssue } from "../../domain/issues.js";
import type { ProviderIssue, ProviderReport } from "../../domain/model.js";
import { ProcessError } from "../../process/jsonlProcess.js";
import type { ProviderContext, UntimedProviderReport, UsageProvider } from "../types.js";
import { readClaudeAuthStatus, readClaudeVersion, type ClaudeAuthStatus } from "./authStatus.js";
import { ClaudeControlClient, ClaudeUsageError } from "./controlClient.js";
import { normalizeClaudeUsage } from "./normalize.js";
import { GetUsageResponseSchema } from "./schema.js";

function failed(issue: ProviderIssue, providerVersion: string | null, warnings: ProviderIssue[] = []): Extract<UntimedProviderReport, { status: "error" }> {
  return { provider: "claude", status: "error",
    source: { method: "claude-control-get-usage", stability: "experimental", providerVersion }, account: null,
    availability: { state: "unknown", basis: "none", reason: null, exhaustedLimitIds: [] },
    limits: [], credits: [], resetCredits: null, analytics: null, errors: [issue], warnings };
}

/** Apply the ordered classification matrix before pure usage normalization. */
export function interpretClaudeUsage(value: unknown, options: {
  providerVersion: string | null; includeAnalytics: boolean; authStatus: ClaudeAuthStatus | null;
}): UntimedProviderReport {
  const parsed = GetUsageResponseSchema.safeParse(value);
  const warnings = options.includeAnalytics ? [makeIssue("analytics_not_supported", "Claude token analytics are not supported.")] : [];
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 3).map((issue) => issue.path.map(String).join(".") || "<root>");
    return failed(makeIssue("protocol_error", `Invalid Claude usage response at ${paths.join(", ")}.`), options.providerVersion, warnings);
  }
  const data = parsed.data;
  if (!data.rate_limits_available) {
    const auth = options.authStatus;
    let issue: ProviderIssue;
    if (auth === null) {
      warnings.push(makeIssue("auth_status_failed", "Claude auth status failed or could not be parsed."));
      issue = makeIssue("rate_limits_unavailable", "Claude plan rate limits are unavailable.");
    } else if (!auth.loggedIn) issue = makeIssue("not_authenticated", "Claude is not logged in.", { hint: "Run `claude` and use /login." });
    else if (auth.authMethod !== "claude.ai" || auth.apiProvider !== "firstParty") {
      issue = makeIssue("unsupported_auth", `Claude authMethod ${auth.authMethod}, apiProvider ${auth.apiProvider ?? "unknown"} does not provide plan rate limits.`);
    } else issue = makeIssue("rate_limits_unavailable", "Claude plan rate limits are unavailable.", {
      hint: "Token may lack the profile scope (e.g. created with setup-token); log in interactively.",
    });
    const report = failed(issue, options.providerVersion, warnings);
    if (auth?.loggedIn) report.account = { plan: data.subscription_type?.toLowerCase() ?? null, authMode: auth.authMethod };
    return report;
  }
  if (data.rate_limits == null) return failed(makeIssue("upstream_unavailable", "Claude Code could not fetch usage.", {
    retryable: true, hint: "Claude Code could not fetch usage (network, rate limiting, or token refresh failure). If this persists run `claude` and /login.",
  }), options.providerVersion, warnings);
  return normalizeClaudeUsage(data, options);
}

function issueFrom(error: unknown): ProviderIssue {
  if (error instanceof ProcessError || error instanceof ClaudeUsageError) return error.issue;
  return makeIssue("internal", error instanceof Error ? error.message : "Unknown Claude provider failure.");
}

/** Fetch usage and optional auth classification under one provider deadline. */
export async function fetchClaudeUsage(ctx: ProviderContext): Promise<ProviderReport> {
  const began = performance.now();
  let fetchedAt = ctx.now().toISOString();
  let providerVersion: string | null = null;
  let client: ClaudeControlClient | undefined;
  let versionRead: Promise<string | null> | undefined;
  let coreResponseReceived = false;
  let result: UntimedProviderReport = failed(makeIssue("internal", "Claude fetch did not complete."), null);
  try {
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]);
    const bin = ctx.bin ?? ctx.env.AGENT_USAGE_CLAUDE_BIN ?? "claude";
    client = await ClaudeControlClient.create({ bin, env: ctx.env, signal, debug: ctx.debug });
    const helpers = { bin, cwd: client.cwd, env: ctx.env, signal };
    versionRead = readClaudeVersion(helpers);
    const value = await client.getUsage();
    coreResponseReceived = true;
    fetchedAt = ctx.now().toISOString();
    const parsed = GetUsageResponseSchema.safeParse(value);
    const authStatus = parsed.success && !parsed.data.rate_limits_available ? await readClaudeAuthStatus(helpers) : null;
    providerVersion = await versionRead;
    // Helpers return null when the shared signal cuts them off. Once usage
    // arrives, those informational failures cannot replace the core outcome.
    result = interpretClaudeUsage(value, { providerVersion, includeAnalytics: ctx.includeAnalytics, authStatus });
  } catch (error: unknown) {
    if (error instanceof ClaudeUsageError) coreResponseReceived = true;
    fetchedAt = ctx.now().toISOString();
    if (versionRead !== undefined) providerVersion = await versionRead;
    result = failed(issueFrom(error), providerVersion);
  } finally {
    if (client !== undefined) {
      try { await client.close(); } catch (error: unknown) {
        const issue = issueFrom(error);
        // The same signal can also terminate a still-exiting control child
        // after its response. Cleanup completes, but the core result stands.
        if (!coreResponseReceived || (issue.code !== "timeout" && issue.code !== "aborted")) {
          fetchedAt = ctx.now().toISOString();
          result = failed(issue, providerVersion);
        }
      }
    }
  }
  if (ctx.includeAnalytics && !result.warnings.some((issue) => issue.code === "analytics_not_supported")) {
    result.warnings.push(makeIssue("analytics_not_supported", "Claude token analytics are not supported."));
  }
  return { ...result, fetchedAt, durationMs: Math.round(performance.now() - began) };
}

export const claudeProvider: UsageProvider = { id: "claude", fetch: fetchClaudeUsage };
