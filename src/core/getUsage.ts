import { makeIssue } from "../domain/issues.js";
import type { ProviderId, ProviderReport, UsageReport } from "../domain/model.js";
import { ProviderIdSchema } from "../domain/reportSchema.js";
import type { UsageProvider } from "../providers/types.js";
import { redactText } from "../redact.js";
import { version } from "../version.js";
import { DEFAULT_PROVIDERS, providerRegistry } from "./registry.js";

export interface GetUsageOptions {
  providers?: ProviderId[];
  timeoutMs?: number;
  includeAnalytics?: boolean;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  binaries?: Partial<Record<ProviderId, string>>;
  now?: () => Date;
  debug?: (message: string) => void;
}

interface RunOptions {
  timeoutMs: number;
  includeAnalytics: boolean;
  signal: AbortSignal | undefined;
  env: NodeJS.ProcessEnv;
  binaries: Partial<Record<ProviderId, string>> | undefined;
  now: () => Date;
  debug: (message: string) => void;
}

function assertOptionsObject(options: GetUsageOptions): void {
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Options must be an object.");
}

function resolveOptions(options: GetUsageOptions): RunOptions & { providers: ProviderId[] } {
  assertOptionsObject(options);
  const ids = options.providers === undefined ? DEFAULT_PROVIDERS : options.providers;
  if (!Array.isArray(ids) || ids.length === 0) throw new TypeError("providers must be a nonempty array of known provider ids.");
  for (const id of ids) if (!ProviderIdSchema.safeParse(id).success) throw new TypeError("Unknown provider id.");
  const timeoutMs = options.timeoutMs === undefined ? 20000 : options.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 2147483647) {
    throw new TypeError("timeoutMs must be an integer from 1000 to 2147483647.");
  }
  if (options.binaries !== undefined) {
    if (options.binaries === null || typeof options.binaries !== "object" || Array.isArray(options.binaries)) {
      throw new TypeError("binaries must be an object of provider binary paths.");
    }
    for (const [id, binary] of Object.entries(options.binaries)) {
      if (!ProviderIdSchema.safeParse(id).success || typeof binary !== "string" || binary.length === 0) {
        throw new TypeError("binaries must contain known provider ids with nonempty string values.");
      }
    }
  }
  if (options.includeAnalytics !== undefined && typeof options.includeAnalytics !== "boolean") throw new TypeError("includeAnalytics must be a boolean.");
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal.");
  if (options.now !== undefined && typeof options.now !== "function") throw new TypeError("now must be a function.");
  if (options.debug !== undefined && typeof options.debug !== "function") throw new TypeError("debug must be a function.");
  if (options.env !== undefined && (options.env === null || typeof options.env !== "object" || Array.isArray(options.env))) {
    throw new TypeError("env must be an environment object.");
  }
  const debug = options.debug;
  return {
    providers: [...new Set(ids)], timeoutMs, includeAnalytics: options.includeAnalytics ?? false,
    signal: options.signal, env: options.env ?? process.env, binaries: options.binaries, now: options.now ?? (() => new Date()),
    debug: (message) => { try { debug?.(redactText(message)); } catch { /* Diagnostics cannot fail a fetch. */ } },
  };
}

/** Internal execution seam for testing provider failure isolation; not a public export. */
export async function runProviders(providers: readonly UsageProvider[], options: RunOptions): Promise<ProviderReport[]> {
  return Promise.all(providers.map(async (provider): Promise<ProviderReport> => {
    const began = performance.now();
    const deadline = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal === undefined ? deadline : AbortSignal.any([deadline, options.signal]);
    try {
      return await provider.fetch({ timeoutMs: options.timeoutMs, signal, includeAnalytics: options.includeAnalytics,
        env: options.env, bin: options.binaries?.[provider.id], now: options.now, debug: options.debug });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown provider failure.";
      return {
        provider: provider.id, status: "error", fetchedAt: options.now().toISOString(), durationMs: Math.round(performance.now() - began),
        source: { method: provider.id === "codex" ? "codex-app-server" : "claude-control-get-usage",
          stability: provider.id === "codex" ? "supported" : "experimental", providerVersion: null },
        account: null, availability: { state: "unknown", basis: "none", reason: null, exhaustedLimitIds: [] },
        limits: [], credits: [], resetCredits: null, analytics: null,
        errors: [makeIssue("internal", message, { retryable: false })], warnings: [],
      };
    }
  }));
}

/** Fetch requested providers concurrently, isolating failures and preserving request order. */
export async function getUsage(options: GetUsageOptions = {}): Promise<UsageReport> {
  const resolved = resolveOptions(options);
  const providers = await runProviders(resolved.providers.map((id) => providerRegistry[id]), resolved);
  return { schemaVersion: 1, tool: { name: "agent-usage", version }, generatedAt: resolved.now().toISOString(), providers };
}

/** Fetch only Codex through the same validation and orchestration path. */
export async function getCodexUsage(options: Omit<GetUsageOptions, "providers"> = {}): Promise<ProviderReport> {
  assertOptionsObject(options);
  const report = await getUsage({ ...options, providers: ["codex"] });
  return report.providers[0]!;
}

/** Fetch only Claude through the same validation and orchestration path. */
export async function getClaudeUsage(options: Omit<GetUsageOptions, "providers"> = {}): Promise<ProviderReport> {
  assertOptionsObject(options);
  const report = await getUsage({ ...options, providers: ["claude"] });
  return report.providers[0]!;
}
