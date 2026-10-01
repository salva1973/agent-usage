import { z } from "zod";

export const InitializeResultSchema = z.object({ userAgent: z.string() }).passthrough()
  .transform(({ userAgent }) => ({ userAgent }));

const accountSchema = z.object({ type: z.string(), planType: z.string().nullish() }).passthrough()
  .transform(({ type, planType }) => ({ type, planType }));

// Accept extra protocol fields, but select only the fields needed by the
// provider at parse time so account PII and routing never reach the normalizer.
export const GetAccountResponseSchema = z.object({ account: accountSchema.nullable() }).passthrough()
  .transform(({ account }) => ({ account }));

const windowSchema = z.object({
  usedPercent: z.number(), windowDurationMins: z.number().nullish(), resetsAt: z.number().nullish(),
}).passthrough().transform(({ usedPercent, windowDurationMins, resetsAt }) => ({ usedPercent, windowDurationMins, resetsAt }));

const creditsSchema = z.object({
  hasCredits: z.boolean(), unlimited: z.boolean(), balance: z.string().nullish(),
}).passthrough().transform(({ hasCredits, unlimited, balance }) => ({ hasCredits, unlimited, balance }));

const snapshotSchema = z.object({
  limitId: z.string().nullish(), limitName: z.string().nullish(), normalModelSlug: z.string().nullish(),
  planType: z.string().nullish(), primary: windowSchema.nullish(), secondary: windowSchema.nullish(),
  credits: creditsSchema.nullish(),
}).passthrough().transform(({ limitId, limitName, normalModelSlug, planType, primary, secondary, credits }) => ({
  limitId, limitName, normalModelSlug, planType, primary, secondary, credits,
}));

const individualLimitSchema = z.object({
  remainingPercent: z.number(), resetsAt: z.number().nullish(),
}).passthrough().transform(({ remainingPercent, resetsAt }) => ({ remainingPercent, resetsAt }));

const resetCreditsSchema = z.object({ availableCount: z.int().nonnegative() }).passthrough()
  .transform(({ availableCount }) => ({ availableCount }));

export const GetAccountRateLimitsResponseSchema = z.object({
  rateLimits: snapshotSchema,
  rateLimitsByLimitId: z.record(z.string(), snapshotSchema).nullish(),
  rateLimitResetCredits: resetCreditsSchema.nullish(), individualLimit: individualLimitSchema.nullish(),
  ordinaryUsageAllowed: z.boolean().nullish(), spendControlReached: z.boolean().nullish(),
  rateLimitReachedType: z.string().nullish(),
}).passthrough().transform((value) => ({
  rateLimits: value.rateLimits, rateLimitsByLimitId: value.rateLimitsByLimitId,
  rateLimitResetCredits: value.rateLimitResetCredits, individualLimit: value.individualLimit,
  ordinaryUsageAllowed: value.ordinaryUsageAllowed, spendControlReached: value.spendControlReached,
  rateLimitReachedType: value.rateLimitReachedType,
}));

const summarySchema = z.object({
  lifetimeTokens: z.number().nullish(), peakDailyTokens: z.number().nullish(),
  longestRunningTurnSec: z.number().nullish(), currentStreakDays: z.number().nullish(), longestStreakDays: z.number().nullish(),
}).passthrough().transform(({ lifetimeTokens, peakDailyTokens, longestRunningTurnSec, currentStreakDays, longestStreakDays }) => ({
  lifetimeTokens, peakDailyTokens, longestRunningTurnSec, currentStreakDays, longestStreakDays,
}));

const dailyBucketSchema = z.object({ startDate: z.iso.date(), tokens: z.number() }).passthrough()
  .transform(({ startDate, tokens }) => ({ startDate, tokens }));

export const GetAccountTokenUsageResponseSchema = z.object({
  summary: summarySchema, dailyUsageBuckets: z.array(dailyBucketSchema).nullish(),
}).passthrough().transform(({ summary, dailyUsageBuckets }) => ({ summary, dailyUsageBuckets }));

export type CodexAccount = z.infer<typeof accountSchema>;
export type CodexWindow = z.infer<typeof windowSchema>;
export type CodexSnapshot = z.infer<typeof snapshotSchema>;
export type CodexRateLimitsResponse = z.infer<typeof GetAccountRateLimitsResponseSchema>;
export type CodexTokenUsageResponse = z.infer<typeof GetAccountTokenUsageResponseSchema>;
