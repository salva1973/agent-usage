import type { UsageReport } from "../../index.js";

/** Render one complete report with two-space indentation and a trailing newline. */
export function renderJson(report: UsageReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
