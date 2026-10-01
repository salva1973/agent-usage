import type { FetchStatus, ProviderId, ProviderReport } from "../domain/model.js";

export interface ProviderContext {
  timeoutMs: number;
  signal: AbortSignal;
  includeAnalytics: boolean;
  env: NodeJS.ProcessEnv;
  bin: string | undefined;
  now: () => Date;
  debug: (msg: string) => void;
}

export interface UsageProvider {
  readonly id: ProviderId;
  /** Return an error report instead of rejecting for provider failures. */
  fetch(ctx: ProviderContext): Promise<ProviderReport>;
}

export type UntimedProviderReport = {
  [Status in FetchStatus]: Omit<Extract<ProviderReport, { status: Status }>, "fetchedAt" | "durationMs">;
}[FetchStatus];
