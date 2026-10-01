import { tmpdir } from "node:os";
import { z } from "zod";
import { makeIssue } from "../../domain/issues.js";
import type { ProviderIssue } from "../../domain/model.js";
import {
  createJsonlProcess, ProcessError, processExitError,
  type JsonlProcess, type ProcessExit,
} from "../../process/jsonlProcess.js";
import { redactText } from "../../redact.js";
import { version } from "../../version.js";

export const CODEX_ALLOWED_METHODS = Object.freeze([
  "initialize", "account/read", "account/rateLimits/read", "account/usage/read",
] as const);

const rpcErrorSchema = z.object({ code: z.number().int(), message: z.string() });
const envelopeSchema = z.object({
  id: z.union([z.number().int(), z.string()]).optional(),
  method: z.string().optional(),
}).passthrough();

/** A redacted app-server RPC error retaining only its numeric code and issue. */
export class CodexRpcError extends Error {
  readonly issue: ProviderIssue;

  /** Map method and parameter errors without retaining the raw error payload. */
  constructor(readonly rpcCode: number, message: string) {
    const issue = makeIssue(rpcCode === -32601 ? "incompatible_provider" : "upstream_error", message, {
      retryable: rpcCode !== -32601 && rpcCode !== -32600 && rpcCode !== -32602,
    });
    super(issue.message);
    this.name = "CodexRpcError";
    this.issue = issue;
  }
}

export interface AppServerClientOptions {
  bin?: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  debug?: (message: string) => void;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** Short-lived private Codex stdio client with a fixed read-only method set. */
export class AppServerClient {
  private readonly transport: JsonlProcess;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private failure: Error | undefined;
  private closing = false;
  private shutdown: Promise<void> | undefined;
  readonly exited: Promise<ProcessExit>;

  /** Spawn app-server with the unchanged caller environment and a neutral cwd. */
  constructor(private readonly options: AppServerClientOptions) {
    const bin = options.bin ?? options.env.AGENT_USAGE_CODEX_BIN ?? "codex";
    this.log(`spawn ${bin} app-server`);
    this.transport = createJsonlProcess({
      bin, args: ["app-server"], cwd: tmpdir(), env: options.env, signal: options.signal,
      onLine: (value) => this.receive(value),
      onProtocolError: (error) => this.fail(error),
    });
    this.exited = this.transport.exited;
    void this.exited.then(
      (exit) => {
        this.log(`exit code ${exit.code}, signal ${exit.signal}`);
        this.fail(processExitError(exit, this.transport.stderrTail()));
      },
      (error: unknown) => this.fail(error instanceof Error ? error : new ProcessError("internal", "Unknown transport failure.")),
    );
  }

  private log(message: string): void {
    try { this.options.debug?.(redactText(message)); } catch { /* Diagnostics cannot break a fetch. */ }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
  }

  private protocolFailure(): void {
    this.fail(new ProcessError("protocol_error", "Unexpected Codex app-server envelope."));
    void this.transport.terminate().catch(() => {});
  }

  private receive(value: unknown): void {
    if (this.failure !== undefined) return;
    const parsed = envelopeSchema.safeParse(value);
    if (!parsed.success) { this.protocolFailure(); return; }
    const message = parsed.data;
    if (message.method !== undefined) {
      if (message.id === undefined) this.log(`notification ${message.method}`);
      else {
        this.log(`server request ${message.method}`);
        this.transport.write({ id: message.id, error: {
          code: -32601, message: "agent-usage: client does not handle server requests",
        } });
      }
      return;
    }
    if (message.id === undefined || (Object.hasOwn(message, "result") === Object.hasOwn(message, "error"))) {
      this.protocolFailure(); return;
    }
    const request = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (request === undefined) { this.log("response with unknown id ignored"); return; }
    if (Object.hasOwn(message, "error")) {
      const error = rpcErrorSchema.safeParse(message.error);
      if (!error.success) { this.protocolFailure(); return; }
      this.pending.delete(message.id as number);
      request.reject(new CodexRpcError(error.data.code, error.data.message));
    } else {
      this.pending.delete(message.id as number);
      request.resolve(message.result);
    }
    this.log(`response id ${message.id}`);
  }

  /** Send an allowed request; disallowed methods throw synchronously before writing. */
  request(method: string, params: unknown): Promise<unknown> {
    if (!CODEX_ALLOWED_METHODS.some((allowed) => allowed === method)) throw new Error("method not allowed");
    if (this.failure !== undefined || this.closing) {
      return Promise.reject(this.failure ?? new ProcessError("process_error", "Codex app-server is closing."));
    }
    const id = this.nextId++;
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.transport.write({ method, id, params });
        this.log(`request ${method} id ${id}`);
      } catch (error: unknown) {
        this.fail(error instanceof Error ? error : new ProcessError("internal", "Could not write Codex request."));
      }
    });
    void response.catch(() => {});
    return response;
  }

  /** Perform the required handshake without parsing provider-specific result data. */
  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", {
      clientInfo: { name: "agent-usage", title: "agent-usage", version }, capabilities: null,
    });
    this.transport.write({ method: "initialized" });
    this.log("notification initialized sent");
    return result;
  }

  /** End stdin, allow two seconds to exit, then terminate the whole process group. */
  close(): Promise<void> {
    this.shutdown ??= (async () => {
      this.closing = true;
      this.transport.endInput();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const completed = await Promise.race([
          this.exited.then(() => true),
          new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 2000); }),
        ]);
        if (!completed) await this.transport.terminate();
        await this.exited;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    })();
    return this.shutdown;
  }

  /** Terminate the private process group immediately, including any descendants. */
  terminate(): Promise<void> { return this.transport.terminate(); }
}
