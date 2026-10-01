import { z } from "zod";
import { makeIssue } from "../../domain/issues.js";
import type { ProviderIssue, ProviderReport } from "../../domain/model.js";
import { ProcessError } from "../../process/jsonlProcess.js";
import type { ProviderContext, UntimedProviderReport, UsageProvider } from "../types.js";
import { AppServerClient, CodexRpcError } from "./appServerClient.js";
import { normalizeCodexUsage } from "./normalize.js";
import {
  GetAccountRateLimitsResponseSchema, GetAccountResponseSchema, GetAccountTokenUsageResponseSchema, InitializeResultSchema,
  type CodexAccount, type CodexTokenUsageResponse,
} from "./schema.js";

function validate<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const paths = parsed.error.issues.slice(0, 3).map((issue) => issue.path.map(String).join(".") || "<root>");
  throw new ProcessError("protocol_error", `Invalid Codex ${label} response at ${paths.join(", ")}.`);
}

function issueFrom(error: unknown): ProviderIssue {
  if (error instanceof CodexRpcError || error instanceof ProcessError) return error.issue;
  return makeIssue("internal", error instanceof Error ? error.message : "Unknown Codex provider failure.");
}

function failed(issue: ProviderIssue, providerVersion: string | null): Extract<UntimedProviderReport, { status: "error" }> {
  return {
    provider: "codex", status: "error",
    source: { method: "codex-app-server", stability: "supported", providerVersion }, account: null,
    availability: { state: "unknown", basis: "none", reason: null, exhaustedLimitIds: [] },
    limits: [], credits: [], resetCredits: null, analytics: null, errors: [issue], warnings: [],
  };
}

function rateLimitsIssue(error: unknown, account: CodexAccount | null | undefined): ProviderIssue {
  if (account === null || (error instanceof CodexRpcError && /auth(entication)? required/i.test(error.message))) {
    return makeIssue("not_authenticated", "Codex is not logged in.", { hint: "Run `codex login`." });
  }
  if (error instanceof CodexRpcError && account !== undefined && account.type !== "chatgpt") {
    return makeIssue("unsupported_auth", `Codex authentication mode ${account.type} does not provide plan rate limits.`);
  }
  return issueFrom(error);
}

/** Fetch Codex observations with one private app-server and a single deadline. */
export async function fetchCodexUsage(ctx: ProviderContext): Promise<ProviderReport> {
  const began = performance.now();
  let providerVersion: string | null = null;
  let fetchedAt = ctx.now().toISOString();
  let result: UntimedProviderReport = failed(makeIssue("internal", "Codex fetch did not complete."), null);
  let client: AppServerClient | undefined;

  try {
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]);
    client = new AppServerClient({ ...(ctx.bin === undefined ? {} : { bin: ctx.bin }), env: ctx.env, signal, debug: ctx.debug });
    const init = validate(InitializeResultSchema, await client.initialize(), "initialize");
    providerVersion = init.userAgent.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
    const [accountRead, limitsRead, usageRead] = await Promise.allSettled([
      client.request("account/read", { refreshToken: false }),
      client.request("account/rateLimits/read", { excludeResetCreditDetails: true }),
      ctx.includeAnalytics ? client.request("account/usage/read", null) : Promise.resolve(undefined),
    ]);
    fetchedAt = ctx.now().toISOString();
    let account: CodexAccount | null | undefined;
    if (accountRead.status === "fulfilled") {
      const parsed = GetAccountResponseSchema.safeParse(accountRead.value);
      if (parsed.success) account = parsed.data.account;
    }
    if (limitsRead.status === "rejected") result = failed(rateLimitsIssue(limitsRead.reason, account), providerVersion);
    else if (account === null) result = failed(rateLimitsIssue(undefined, null), providerVersion);
    else {
      const limits = validate(GetAccountRateLimitsResponseSchema, limitsRead.value, "rate limits");
      let usage: CodexTokenUsageResponse | null = null;
      const errors: ProviderIssue[] = [];
      if (ctx.includeAnalytics) {
        try {
          if (usageRead.status === "rejected") throw usageRead.reason;
          usage = validate(GetAccountTokenUsageResponseSchema, usageRead.value, "analytics");
        } catch (error: unknown) {
          const underlying = issueFrom(error);
          errors.push(makeIssue("analytics_failed", `Codex analytics failed (${underlying.code}): ${underlying.message}`, { retryable: underlying.retryable }));
        }
      }
      result = normalizeCodexUsage(limits, { account: account ?? null, providerVersion, analytics: usage, errors });
    }
  } catch (error: unknown) {
    fetchedAt = ctx.now().toISOString();
    result = failed(issueFrom(error), providerVersion);
  } finally {
    if (client !== undefined) {
      try { await client.close(); } catch (error: unknown) {
        // Cancellation or transport failure during cleanup is still under the
        // provider deadline and must not produce a successful observation.
        fetchedAt = ctx.now().toISOString();
        result = failed(issueFrom(error), providerVersion);
      }
    }
  }
  return { ...result, fetchedAt, durationMs: Math.round(performance.now() - began) };
}

export const codexProvider: UsageProvider = { id: "codex", fetch: fetchCodexUsage };
