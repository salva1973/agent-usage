import { z } from "zod";

export const ClaudeWindowSchema = z.object({ utilization: z.number().nullish(), resets_at: z.string().nullish() })
  .passthrough().transform(({ utilization, resets_at }) => ({ utilization, resets_at }));
export const ClaudeModelWindowSchema = z.object({
  display_name: z.string(), utilization: z.number().nullish(), resets_at: z.string().nullish(),
}).passthrough().transform(({ display_name, utilization, resets_at }) => ({ display_name, utilization, resets_at }));
export const ClaudeExtraUsageSchema = z.object({
  is_enabled: z.boolean(), monthly_limit: z.number().nullish(), used_credits: z.number().nullish(),
  utilization: z.number().nullish(), currency: z.string().nullish(), decimal_places: z.number().optional(), disabled_reason: z.string().nullish(),
}).passthrough().transform(({ is_enabled, monthly_limit, used_credits, utilization, currency, decimal_places, disabled_reason }) => ({
  is_enabled, monthly_limit, used_credits, utilization, currency, decimal_places, disabled_reason,
}));

// Parse individual windows independently during normalization: a malformed
// optional window must not reject otherwise usable core observations.
export const GetUsageResponseSchema = z.object({
  subscription_type: z.string().nullish(), rate_limits_available: z.boolean(),
  rate_limits: z.object({}).passthrough().nullish(),
}).passthrough().transform(({ subscription_type, rate_limits_available, rate_limits }) => ({
  subscription_type, rate_limits_available, rate_limits,
}));
export type ClaudeUsageResponse = z.infer<typeof GetUsageResponseSchema>;
export type ClaudeWindow = z.infer<typeof ClaudeWindowSchema>;
