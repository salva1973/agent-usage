import { z } from "zod";

export const ProviderIdSchema = z.enum(["codex", "claude"]);
export const FetchStatusSchema = z.enum(["ok", "partial", "error"]);
export const AvailabilityStateSchema = z.enum(["available", "limited", "unknown"]);
export const LimitKindSchema = z.enum(["session", "weekly", "spend_control", "other"]);
export const IssueCodeSchema = z.enum([
  "not_installed",
  "not_authenticated",
  "unsupported_auth",
  "rate_limits_unavailable",
  "upstream_unavailable",
  "upstream_error",
  "timeout",
  "process_error",
  "protocol_error",
  "incompatible_provider",
  "aborted",
  "internal",
]);

const timestamp = z.iso.datetime({ precision: 3 });
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);
const percent = z.number().nullable();
const safeInteger = z.int();

export const ProviderIssueSchema = z.object({
  // Issue codes are open so consumers can validate reports from newer versions.
  code: z.string(),
  message: z.string().max(300),
  retryable: z.boolean(),
  hint: z.string().nullable(),
});

export const SourceInfoSchema = z.object({
  method: z.enum(["codex-app-server", "claude-control-get-usage"]),
  stability: z.enum(["supported", "experimental"]),
  providerVersion: z.string().nullable(),
});

export const AccountInfoSchema = z.object({
  plan: z.string().nullable(),
  authMode: z.string().nullable(),
});

export const AvailabilitySchema = z.object({
  state: AvailabilityStateSchema,
  basis: z.enum(["provider_flag", "derived_from_limits", "none"]),
  reason: z.string().nullable(),
  exhaustedLimitIds: z.array(z.string()),
});

export const LimitScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("account") }),
  z.object({ type: z.literal("model"), model: z.string() }),
  z.object({ type: z.literal("product"), product: z.string() }),
  z.object({
    type: z.literal("bucket"),
    bucket: z.string(),
    name: z.string().nullable(),
    model: z.string().nullable(),
  }),
]);

export const RateLimitSchema = z.object({
  id: z.string(),
  kind: LimitKindSchema,
  scope: LimitScopeSchema,
  label: z.string(),
  usedPercent: percent,
  remainingPercent: z.number().min(0).max(100).nullable(),
  windowMinutes: z.number().nullable(),
  windowSource: z.enum(["reported", "inferred", "unknown"]),
  resetsAt: timestamp.nullable(),
  providerKey: z.string(),
});

export const CreditUnitSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("provider_credits") }),
  z.object({ type: z.literal("currency"), currency: z.string().regex(/^[A-Z]{3}$/) }),
]);

export const CreditBalanceSchema = z.object({
  id: z.string(),
  label: z.string(),
  unit: CreditUnitSchema,
  balance: decimal.nullable(),
  used: decimal.nullable(),
  limit: decimal.nullable(),
  usedPercent: percent,
  unlimited: z.boolean().nullable(),
  hasCredits: z.boolean().nullable(),
  enabled: z.boolean().nullable(),
  disabledReason: z.string().nullable(),
  providerKey: z.string(),
});

export const ResetCreditsSchema = z.object({ availableCount: safeInteger.nonnegative() });
export const TokenAnalyticsSchema = z.object({
  lifetimeTokens: safeInteger.nullable(),
  peakDailyTokens: safeInteger.nullable(),
  longestRunningTurnSec: safeInteger.nullable(),
  currentStreakDays: safeInteger.nullable(),
  longestStreakDays: safeInteger.nullable(),
  daily: z.array(z.object({ date: z.iso.date(), tokens: safeInteger })),
});

const providerFields = {
  provider: ProviderIdSchema,
  fetchedAt: timestamp,
  durationMs: safeInteger.nonnegative(),
  source: SourceInfoSchema,
  account: AccountInfoSchema.nullable(),
  availability: AvailabilitySchema,
  limits: z.array(RateLimitSchema),
  credits: z.array(CreditBalanceSchema),
  resetCredits: ResetCreditsSchema.nullable(),
  analytics: TokenAnalyticsSchema.nullable(),
  warnings: z.array(ProviderIssueSchema),
};

export const ProviderReportSchema = z.discriminatedUnion("status", [
  z.object({ ...providerFields, status: z.literal("ok"), errors: z.array(ProviderIssueSchema).max(0) }),
  z.object({ ...providerFields, status: z.literal("partial"), errors: z.array(ProviderIssueSchema).min(1) }),
  z.object({
    ...providerFields,
    status: z.literal("error"),
    errors: z.array(ProviderIssueSchema).min(1),
    limits: z.array(RateLimitSchema).max(0),
    availability: AvailabilitySchema.extend({ state: z.literal("unknown") }),
  }),
]);

/** The v1 normalized report contract; unknown object fields are ignored. */
export const UsageReportSchema = z.object({
  schemaVersion: z.literal(1),
  tool: z.object({ name: z.literal("agent-usage"), version: z.string() }),
  generatedAt: timestamp,
  providers: z.array(ProviderReportSchema),
});
