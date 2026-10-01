import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { makeIssue } from "../../domain/issues.js";
import { createJsonlProcess, ProcessError, processExitError, type JsonlProcess, type ProcessExit } from "../../process/jsonlProcess.js";
import { redactText } from "../../redact.js";

export const CLAUDE_CONTROL_SUBTYPES = Object.freeze(["initialize", "get_usage"] as const);
export const CLAUDE_USAGE_ARGS = Object.freeze([
  "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
  "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--tools", "",
]);

export interface ControlClientOptions {
  bin?: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  debug?: (message: string) => void;
}

/** A bounded, redacted failure returned by the experimental usage control API. */
export class ClaudeUsageError extends Error {
  readonly issue;
  /** Classify unsupported subtypes without retaining the raw error text. */
  constructor(message: string) {
    const unsupported = /not supported|unknown subtype|unsupported/i.test(message);
    const issue = makeIssue(unsupported ? "incompatible_provider" : "upstream_error", message,
      unsupported ? { hint: "Claude Code version may have changed the experimental get_usage API" } : {});
    super(issue.message);
    this.name = "ClaudeUsageError";
    this.issue = issue;
  }
}

const objectSchema = z.object({}).passthrough();

/** Private, single-fetch Claude transport; it has no arbitrary message writer. */
export class ClaudeControlClient {
  private readonly transport: JsonlProcess;
  private readonly usageId = `agent-usage-usage-${randomUUID()}`;
  private readonly initId = `agent-usage-init-${randomUUID()}`;
  private readonly response: Promise<unknown>;
  private resolve!: (value: unknown) => void;
  private reject!: (error: Error) => void;
  private started = false;
  private received = false;
  private failure: Error | undefined;
  private processShutdown: Promise<void> | undefined;
  private shutdown: Promise<void> | undefined;
  readonly exited: Promise<ProcessExit>;

  private constructor(readonly cwd: string, private readonly options: ControlClientOptions) {
    this.response = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    void this.response.catch(() => {});
    this.transport = createJsonlProcess({
      bin: options.bin ?? options.env.AGENT_USAGE_CLAUDE_BIN ?? "claude", args: [...CLAUDE_USAGE_ARGS],
      cwd, env: options.env, signal: options.signal,
      onLine: (message) => this.receive(message), onProtocolError: (error) => this.fail(error),
    });
    this.exited = this.transport.exited;
    void this.exited.then((exit) => {
      this.log(`exit code ${exit.code}, signal ${exit.signal}`);
      if (!this.received) this.fail(processExitError(exit, this.transport.stderrTail()));
    }, (error: unknown) => this.fail(error instanceof Error ? error : new ProcessError("internal", "Claude transport failed.")));
    this.log("Claude usage process spawned");
  }

  /** Create an isolated cwd, removing it if transport creation fails. */
  static async create(options: ControlClientOptions): Promise<ClaudeControlClient> {
    const cwd = await mkdtemp(join(tmpdir(), "agent-usage-claude-"));
    try { return new ClaudeControlClient(cwd, options); }
    catch (error: unknown) { await rm(cwd, { recursive: true, force: true }); throw error; }
  }

  private log(message: string): void {
    try { this.options.debug?.(redactText(message)); } catch { /* Diagnostics cannot break a fetch. */ }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.reject(this.failure);
  }

  private protocolFailure(): void {
    this.fail(new ProcessError("protocol_error", "Unexpected Claude usage control response."));
    void this.transport.terminate().catch(() => {});
  }

  private receive(value: unknown): void {
    if (this.failure !== undefined || this.received) return;
    const parsed = objectSchema.safeParse(value);
    if (!parsed.success) return;
    const message = parsed.data;
    if (message.type === "control_request") {
      if (typeof message.request_id !== "string") { this.protocolFailure(); return; }
      this.transport.write({ type: "control_response", response: {
        subtype: "error", request_id: message.request_id, error: "agent-usage does not handle requests",
      } });
      this.log("server control request refused");
      return;
    }
    if (message.type !== "control_response") return;
    // Read only the correlation id first. Initialize and unrelated responses
    // are discarded without validating or retaining their PII-bearing payloads.
    const envelope = objectSchema.safeParse(message.response);
    if (!envelope.success || envelope.data.request_id !== this.usageId) return;
    const response = envelope.data;
    if (response.subtype === "error" && typeof response.error === "string") {
      this.received = true;
      this.reject(new ClaudeUsageError(response.error));
    } else if (response.subtype === "success" && Object.hasOwn(response, "response")) {
      this.received = true;
      this.resolve(response.response);
    } else { this.protocolFailure(); return; }
    this.log("usage control response received");
    // Start the two-second exit grace period immediately, even while version
    // or auth helpers are still running in the same cwd.
    void this.stopProcess().catch(() => {});
  }

  /** Send the fixed handshake once, with no prompt or user message. */
  getUsage(): Promise<unknown> {
    if (this.started) return this.response;
    this.started = true;
    if (this.failure !== undefined) return Promise.reject(this.failure);
    try {
      this.transport.write({ type: "control_request", request_id: this.initId, request: { subtype: CLAUDE_CONTROL_SUBTYPES[0] } });
      this.transport.write({ type: "control_request", request_id: this.usageId, request: { subtype: CLAUDE_CONTROL_SUBTYPES[1], skip_behaviors: true } });
      this.log("initialize and get_usage sent");
    } catch (error: unknown) {
      this.fail(error instanceof Error ? error : new ProcessError("internal", "Could not send Claude handshake."));
    }
    return this.response;
  }

  private stopProcess(): Promise<void> {
    this.processShutdown ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        this.transport.endInput();
        const exited = await Promise.race([
          this.exited.then(() => true), new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 2000); }),
        ]);
        if (!exited) await this.transport.terminate();
        await this.exited;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    return this.processShutdown;
  }

  /** Await shutdown and remove the cwd after the caller has awaited its helpers. */
  close(): Promise<void> {
    this.shutdown ??= (async () => {
      try { await this.stopProcess(); }
      finally { await rm(this.cwd, { recursive: true, force: true }); }
    })();
    return this.shutdown;
  }
}
