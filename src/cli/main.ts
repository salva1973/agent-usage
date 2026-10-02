#!/usr/bin/env node
import type { UsageReport } from "../index.js";
import { getUsage } from "../index.js";
import { redactText } from "../redact.js";
import { version } from "../version.js";
import { HELP_TEXT, parseCliArgs } from "./args.js";
import { createDemoReport } from "./demo.js";
import { EXIT_CODES, exitCodeFor } from "./exitCodes.js";
import { renderJson } from "./render/json.js";
import { renderHuman } from "./render/human.js";

function usageError(message: string): void {
  process.stderr.write(`agent-usage: ${redactText(message)}\nTry 'agent-usage --help'.\n`);
  process.exitCode = EXIT_CODES.USAGE;
}

/** Run the CLI through the public library, allowing provider cleanup before exit. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let debug = false;
  let interrupted = false;
  let reportWritten = false;
  try {
    const parsed = parseCliArgs(argv);
    if (!parsed.ok) { usageError(parsed.message); return; }
    const options = parsed.options;
    debug = options.debug;
    const clockText = process.env.AGENT_USAGE_NOW;
    if (clockText !== undefined && !Number.isFinite(new Date(clockText).getTime())) {
      usageError("AGENT_USAGE_NOW must contain a valid date.");
      return;
    }
    if (options.action === "help") { process.stdout.write(HELP_TEXT); process.exitCode = EXIT_CODES.SUCCESS; return; }
    if (options.action === "version") { process.stdout.write(`${version}\n`); process.exitCode = EXIT_CODES.SUCCESS; return; }

    function writeReport(report: UsageReport): void {
      const color = process.stdout.isTTY === true && !options.noColor && !process.env.NO_COLOR;
      const output = options.json ? renderJson(report) : renderHuman(report, {
        color, debug, now: clockText === undefined ? new Date() : new Date(clockText),
      });
      process.exitCode = exitCodeFor(report);
      process.stdout.write(output);
    }

    if (options.demo) {
      const now = clockText === undefined ? new Date() : new Date(clockText);
      const report = createDemoReport({ now, providers: options.providers, includeAnalytics: options.includeAnalytics, version });
      if (debug) process.stderr.write("[agent-usage] demo mode: synthetic data; no provider contacted\n");
      writeReport(report);
      return;
    }

    const controller = new AbortController();
    const onSignal = (): void => {
      if (reportWritten) return;
      if (interrupted) process.exit(EXIT_CODES.INTERRUPTED);
      interrupted = true;
      controller.abort();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    const report = await getUsage({
      providers: options.providers, timeoutMs: options.timeoutMs, includeAnalytics: options.includeAnalytics, signal: controller.signal,
      ...(clockText === undefined ? {} : { now: () => new Date(clockText) }),
      ...(debug ? { debug: (message: string) => { process.stderr.write(`[agent-usage] ${message}\n`); } } : {}),
    });
    if (interrupted) { process.exitCode = EXIT_CODES.INTERRUPTED; return; }
    writeReport(report);
    reportWritten = true;
  } catch (error: unknown) {
    if (interrupted) { process.exitCode = EXIT_CODES.INTERRUPTED; return; }
    const message = error instanceof Error ? error.message : "Unknown CLI failure.";
    process.stderr.write(`agent-usage: internal error: ${redactText(message)}\n`);
    if (debug && error instanceof Error && error.stack !== undefined) process.stderr.write(`${redactText(error.stack)}\n`);
    process.exitCode = EXIT_CODES.INTERNAL;
  }
}

await main();
