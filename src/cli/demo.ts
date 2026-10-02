import type { ProviderId, ProviderReport, UsageReport } from "../index.js";

/** Build application-owned synthetic observations using only the supplied clock. */
export function createDemoReport(options: {
  now: Date; providers: ProviderId[]; includeAnalytics: boolean; version: string;
}): UsageReport {
  const { now, providers, includeAnalytics, version } = options;
  const iso = now.toISOString();
  const at = (minutes: number): string => new Date(now.getTime() + minutes * 60000).toISOString();
  const reports = providers.map((provider): ProviderReport => {
    const common = {
      provider, status: "ok" as const, fetchedAt: iso, durationMs: 0, errors: [],
      warnings: [{ code: "demo_data", message: "Synthetic demo data; no provider was contacted.", retryable: false, hint: null }],
    };
    if (provider === "codex") return {
      ...common,
      source: { method: "codex-app-server", stability: "supported", providerVersion: null },
      account: { plan: "plus", authMode: "chatgpt" },
      availability: { state: "available", basis: "provider_flag", reason: null, exhaustedLimitIds: [] },
      limits: [
        { id: "session", kind: "session", scope: { type: "account" }, label: "5h", usedPercent: 37,
          remainingPercent: 63, windowMinutes: 300, windowSource: "reported", resetsAt: at(167), providerKey: "rateLimits.primary" },
        { id: "weekly", kind: "weekly", scope: { type: "account" }, label: "Weekly", usedPercent: 58,
          remainingPercent: 42, windowMinutes: 10080, windowSource: "reported", resetsAt: at(3 * 1440 + 5 * 60 + 20), providerKey: "rateLimits.secondary" },
      ],
      credits: [{ id: "codex_credits", label: "Credits", unit: { type: "provider_credits" }, balance: "125.5000000000",
        used: null, limit: null, usedPercent: null, unlimited: false, hasCredits: true, enabled: null,
        disabledReason: null, providerKey: "rateLimits.credits" }],
      resetCredits: { availableCount: 1 },
      analytics: includeAnalytics ? {
        lifetimeTokens: 742318905, peakDailyTokens: 38120447, longestRunningTurnSec: 5400,
        currentStreakDays: 4, longestStreakDays: 9,
        daily: [5210000, 8432000, 3120500, 12045000, 6730000, 9981200, 4400300].map((tokens, index) => ({
          date: new Date(now.getTime() + (index - 6) * 86400000).toISOString().slice(0, 10), tokens,
        })),
      } : null,
    };
    return {
      ...common,
      source: { method: "claude-control-get-usage", stability: "experimental", providerVersion: null },
      account: { plan: "max", authMode: "claude.ai" },
      availability: { state: "available", basis: "derived_from_limits", reason: null, exhaustedLimitIds: [] },
      limits: [
        { id: "session", kind: "session", scope: { type: "account" }, label: "5h", usedPercent: 64,
          remainingPercent: 36, windowMinutes: 300, windowSource: "inferred", resetsAt: at(85), providerKey: "rate_limits.five_hour" },
        { id: "weekly", kind: "weekly", scope: { type: "account" }, label: "Weekly", usedPercent: 82,
          remainingPercent: 18, windowMinutes: 10080, windowSource: "inferred", resetsAt: at(4 * 1440 + 18 * 60), providerKey: "rate_limits.seven_day" },
        { id: "weekly:model:opus", kind: "weekly", scope: { type: "model", model: "opus" }, label: "Weekly (Opus)", usedPercent: 91,
          remainingPercent: 9, windowMinutes: 10080, windowSource: "inferred", resetsAt: at(4 * 1440 + 18 * 60), providerKey: "rate_limits.seven_day_opus" },
      ],
      credits: [{ id: "claude_extra_usage", label: "Extra usage", unit: { type: "currency", currency: "USD" }, balance: null,
        used: "4.20", limit: "20.00", usedPercent: 21, unlimited: null, hasCredits: null, enabled: true,
        disabledReason: null, providerKey: "rate_limits.extra_usage" }],
      resetCredits: null, analytics: null,
      warnings: includeAnalytics ? [
        { code: "analytics_not_supported", message: "Claude token analytics are not supported.", retryable: false, hint: null },
        ...common.warnings,
      ] : common.warnings,
    };
  });
  return { schemaVersion: 1, tool: { name: "agent-usage", version }, generatedAt: iso, providers: reports };
}
