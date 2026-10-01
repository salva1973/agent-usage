import type { z } from "zod";
import type {
  AccountInfoSchema,
  AvailabilitySchema,
  AvailabilityStateSchema,
  CreditBalanceSchema,
  CreditUnitSchema,
  FetchStatusSchema,
  IssueCodeSchema,
  LimitKindSchema,
  LimitScopeSchema,
  ProviderIdSchema,
  ProviderIssueSchema,
  ProviderReportSchema,
  RateLimitSchema,
  ResetCreditsSchema,
  SourceInfoSchema,
  TokenAnalyticsSchema,
  UsageReportSchema,
} from "./reportSchema.js";

export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type UsageReport = z.infer<typeof UsageReportSchema>;
export type FetchStatus = z.infer<typeof FetchStatusSchema>;
export type ProviderReport = z.infer<typeof ProviderReportSchema>;
export type SourceInfo = z.infer<typeof SourceInfoSchema>;
export type AccountInfo = z.infer<typeof AccountInfoSchema>;
export type AvailabilityState = z.infer<typeof AvailabilityStateSchema>;
export type Availability = z.infer<typeof AvailabilitySchema>;
export type LimitKind = z.infer<typeof LimitKindSchema>;
export type LimitScope = z.infer<typeof LimitScopeSchema>;
export type RateLimit = z.infer<typeof RateLimitSchema>;
export type CreditUnit = z.infer<typeof CreditUnitSchema>;
export type CreditBalance = z.infer<typeof CreditBalanceSchema>;
export type ResetCredits = z.infer<typeof ResetCreditsSchema>;
export type TokenAnalytics = z.infer<typeof TokenAnalyticsSchema>;
export type IssueCode = z.infer<typeof IssueCodeSchema>;
export type ProviderIssue = z.infer<typeof ProviderIssueSchema>;
