import type { UsageReport } from "../index.js";

export const EXIT_CODES = Object.freeze({
  SUCCESS: 0, INTERNAL: 1, USAGE: 2, SOME_FAILED: 3, ALL_FAILED: 4, INTERRUPTED: 130,
} as const);

/** Map fetch status to an exit code; availability never affects success. */
export function exitCodeFor(report: UsageReport): 0 | 3 | 4 {
  const failed = report.providers.filter((provider) => provider.status === "error").length;
  return failed === 0 ? EXIT_CODES.SUCCESS : failed === report.providers.length ? EXIT_CODES.ALL_FAILED : EXIT_CODES.SOME_FAILED;
}
