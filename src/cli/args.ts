import { parseArgs } from "node:util";
import type { ProviderId } from "../index.js";

export interface CliOptions {
  action: "fetch" | "help" | "version";
  providers: ProviderId[];
  json: boolean;
  includeAnalytics: boolean;
  timeoutMs: number;
  noColor: boolean;
  debug: boolean;
}

export type CliArgsResult = { ok: true; options: CliOptions } | { ok: false; message: string };

export const HELP_TEXT = `agent-usage [codex|claude ...] [options]

Options:
  --json              Print the UsageReport as JSON (schema v1) to stdout
  --analytics         Include token analytics (Codex account/usage/read)
  --timeout <sec>     Per-provider timeout in seconds (default 20, min 1)
  --no-color          Disable ANSI colors (also: NO_COLOR env, non-TTY stdout)
  --debug             Diagnostic log lines to stderr (redacted; never payload values)
  -h, --help
  -V, --version
`;

/** Parse CLI arguments without I/O, rejecting unknown flags and invalid values. */
export function parseCliArgs(argv: string[]): CliArgsResult {
  try {
    const { values, positionals } = parseArgs({ args: argv, strict: true, allowPositionals: true, options: {
      json: { type: "boolean" }, analytics: { type: "boolean" }, timeout: { type: "string" },
      "no-color": { type: "boolean" }, debug: { type: "boolean" },
      help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "V" },
    } });
    const providers: ProviderId[] = [];
    for (const positional of positionals) {
      if (positional !== "codex" && positional !== "claude") return { ok: false, message: `Unknown provider '${positional}'.` };
      if (!providers.includes(positional)) providers.push(positional);
    }
    const secondsText = values.timeout ?? "20";
    const seconds = Number(secondsText);
    if (!/^\d+$/.test(secondsText) || !Number.isInteger(seconds) || seconds < 1 || seconds > 2147483) {
      return { ok: false, message: "--timeout must be an integer number of seconds from 1 to 2147483." };
    }
    return { ok: true, options: {
      action: values.help ? "help" : values.version ? "version" : "fetch",
      providers: providers.length === 0 ? ["codex", "claude"] : providers,
      json: values.json ?? false, includeAnalytics: values.analytics ?? false, timeoutMs: seconds * 1000,
      noColor: values["no-color"] ?? false, debug: values.debug ?? false,
    } };
  } catch (error: unknown) {
    return { ok: false, message: error instanceof Error ? error.message : "Invalid arguments." };
  }
}
