import type { Availability, RateLimit } from "./model.js";

/** Derive availability from account limits; record exhaustion at every scope. */
export function deriveAvailability(
  limits: readonly RateLimit[],
  emptyBasis: "none" | "derived_from_limits" = "none",
): Availability {
  const exhausted = limits.filter((limit) => limit.usedPercent !== null && limit.usedPercent >= 100);
  const accountLimit = exhausted.find((limit) => limit.scope.type === "account");
  return {
    state: accountLimit ? "limited" : limits.length > 0 ? "available" : "unknown",
    basis: limits.length > 0 ? "derived_from_limits" : emptyBasis,
    reason: accountLimit ? `limit_exhausted:${accountLimit.id}` : null,
    exhaustedLimitIds: exhausted.map((limit) => limit.id),
  };
}
