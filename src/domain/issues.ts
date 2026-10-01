import { redactText } from "../redact.js";
import type { IssueCode, ProviderIssue } from "./model.js";
import { IssueCodeSchema } from "./reportSchema.js";

export type { IssueCode } from "./model.js";
export const ISSUE_CODES = Object.freeze([...IssueCodeSchema.options]);

const retryableDefaults: Record<IssueCode, boolean> = {
  not_installed: false,
  not_authenticated: false,
  unsupported_auth: false,
  rate_limits_unavailable: false,
  upstream_unavailable: true,
  upstream_error: true,
  timeout: true,
  process_error: true,
  protocol_error: false,
  incompatible_provider: false,
  aborted: false,
  internal: false,
};

/** Create a redacted, bounded issue with a retry default for known codes. */
export function makeIssue(
  code: string,
  message: string,
  options: { retryable?: boolean; hint?: string | null } = {},
): ProviderIssue {
  const known = IssueCodeSchema.safeParse(code);
  return {
    code,
    message: redactText(message).slice(0, 300),
    retryable: options.retryable ?? (known.success ? retryableDefaults[known.data] : false),
    hint: options.hint == null ? null : redactText(options.hint),
  };
}
