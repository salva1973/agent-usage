import type { ProviderReport, RateLimit } from "./domain/model.js";

export { getUsage, getCodexUsage, getClaudeUsage } from "./core/getUsage.js";
export type { GetUsageOptions } from "./core/getUsage.js";
export { UsageReportSchema } from "./domain/reportSchema.js";
export type {
  AccountInfo, Availability, AvailabilityState, CreditBalance, CreditUnit, FetchStatus, IssueCode,
  LimitKind, LimitScope, ProviderId, ProviderIssue, ProviderReport, RateLimit, ResetCredits,
  SourceInfo, TokenAnalytics, UsageReport,
} from "./domain/model.js";

/** Version of the normalized usage-report contract. */
export const SCHEMA_VERSION = 1;

/** Find a normalized rate limit by its exact, stable id. */
export function findLimit(report: ProviderReport, id: string): RateLimit | undefined {
  return report.limits.find((limit) => limit.id === id);
}
