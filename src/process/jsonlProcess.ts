import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { makeIssue } from "../domain/issues.js";
import type { IssueCode, ProviderIssue } from "../domain/model.js";
import { redactText } from "../redact.js";
import { registerChildGroup, type ProcessExit } from "./childRegistry.js";

export type { ProcessExit } from "./childRegistry.js";

/** A process-layer failure with a redacted, bounded domain issue. */
export class ProcessError extends Error {
  readonly issue: ProviderIssue;
  readonly code: IssueCode;

  /** Construct a failure without retaining raw provider or system error text. */
  constructor(code: IssueCode, message: string) {
    const issue = makeIssue(code, message);
    super(issue.message);
    this.name = "ProcessError";
    this.code = code;
    this.issue = issue;
  }
}

export interface JsonlProcessOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  maxLineBytes?: number;
  stderrRingBytes?: number;
  onLine(obj: unknown): void;
  onProtocolError(err: Error): void;
}

export interface JsonlProcess {
  write(obj: unknown): void;
  endInput(): void;
  exited: Promise<ProcessExit>;
  terminate(): Promise<void>;
  stderrTail(): string;
}

interface ManagedProcessOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  stderrRingBytes?: number;
}

export interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  exited: Promise<ProcessExit>;
  fail(error: ProcessError): void;
  failure(): ProcessError | undefined;
  terminate(): Promise<void>;
  stderrTail(): string;
}

/** Decode a bounded UTF-8 buffer, omitting incomplete edge characters. */
export function boundedUtf8(buffer: Buffer, maxBytes: number, tail = false): string {
  if (maxBytes === 0) return "";
  let start = 0;
  if (tail) {
    while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  }
  const text = new StringDecoder("utf8").write(buffer.subarray(start));
  const encoded = Buffer.from(text);
  if (encoded.length <= maxBytes) return text;
  const bounded = tail ? encoded.subarray(-maxBytes) : encoded.subarray(0, maxBytes);
  return boundedUtf8(bounded, maxBytes, tail);
}

function abortFailure(signal: AbortSignal): ProcessError {
  const reason: unknown = signal.reason;
  const timeout = reason !== null && typeof reason === "object" && "name" in reason && reason.name === "TimeoutError";
  return new ProcessError(timeout ? "timeout" : "aborted", timeout ? "Process deadline exceeded." : "Process operation was aborted.");
}

function systemFailure(error: unknown): ProcessError {
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  const message = error instanceof Error ? error.message : "Unknown process failure.";
  return new ProcessError(code === "ENOENT" || code === "EACCES" ? "not_installed" : "process_error", message);
}

/** Describe an exit that occurred before a caller received its awaited response. */
export function processExitError(exit: ProcessExit, stderr: string): ProcessError {
  const tail = redactText(stderr).slice(-200);
  return new ProcessError("process_error", `Process exited before responding (exit code ${exit.code}, signal ${exit.signal}).${tail ? ` stderr: ${tail}` : ""}`);
}

/** Spawn the common transport used by JSONL and bounded command capture. */
export function spawnManagedProcess(options: ManagedProcessOptions): ManagedProcess {
  const ringBytes = options.stderrRingBytes ?? 8 * 1024;
  if (!Number.isSafeInteger(ringBytes) || ringBytes < 0) throw new TypeError("stderrRingBytes must be a nonnegative safe integer");
  if (options.signal.aborted) throw abortFailure(options.signal);

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.bin, options.args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error: unknown) {
    throw systemFailure(error);
  }
  const group = registerChildGroup(child);
  let stderr = Buffer.alloc(0);
  let failure: ProcessError | undefined;
  let settled = false;
  const stderrTail = (): string => boundedUtf8(stderr, ringBytes, true);

  function fail(error: ProcessError): void {
    if (settled || failure !== undefined) return;
    failure = error;
    // The exit promise waits for cleanup, so a rejected operation leaves no child.
    void group.terminate().catch(() => {
      // The group remains registered for the exit hook if termination fails.
    });
  }

  child.stderr.on("data", (chunk: Buffer) => {
    if (ringBytes === 0) return;
    stderr = chunk.length >= ringBytes
      ? Buffer.from(chunk.subarray(chunk.length - ringBytes))
      : Buffer.concat([stderr.subarray(Math.max(0, stderr.length + chunk.length - ringBytes)), chunk]);
  });
  child.once("error", (error: Error) => fail(systemFailure(error)));
  child.stdin.on("error", (error: Error) => fail(systemFailure(error)));
  child.stdout.on("error", (error: Error) => fail(systemFailure(error)));
  child.stderr.on("error", (error: Error) => fail(systemFailure(error)));
  const onAbort = (): void => fail(abortFailure(options.signal));
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();

  const exited = (async (): Promise<ProcessExit> => {
    const exit = await group.closed;
    try {
      try {
        await group.release();
      } catch (error: unknown) {
        throw systemFailure(error);
      }
      if (failure !== undefined) throw failure;
      return exit;
    } finally {
      settled = true;
      options.signal.removeEventListener("abort", onAbort);
    }
  })();
  // Callers may wait for a response before observing exit; do not emit an
  // unhandled rejection in the interval. The original promise still rejects.
  void exited.catch(() => {});
  return { child, exited, fail, failure: () => failure, terminate: group.terminate, stderrTail };
}

/** Spawn a bounded JSON-lines transport with process-group cancellation. */
export function createJsonlProcess(options: JsonlProcessOptions): JsonlProcess {
  const maxLineBytes = options.maxLineBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) throw new TypeError("maxLineBytes must be a positive safe integer");
  const managed = spawnManagedProcess(options);
  let lineBytes = 0;
  let protocolFailed = false;
  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      for (const byte of chunk) {
        if (byte === 10 || byte === 13) lineBytes = 0;
        else if (++lineBytes > maxLineBytes) {
          callback(new ProcessError("protocol_error", `Stdout line exceeded ${maxLineBytes} bytes.`));
          return;
        }
      }
      callback(null, chunk);
    },
  });
  const lines = createInterface({ input: guard, crlfDelay: Infinity, terminal: false });

  function protocolError(error: ProcessError): void {
    if (protocolFailed || managed.failure() !== undefined) return;
    protocolFailed = true;
    managed.fail(error);
    try {
      options.onProtocolError(error);
    } catch {
      // Transport cleanup is already in flight; a callback must not prevent it.
    }
  }

  guard.on("error", (error: Error) => protocolError(error instanceof ProcessError ? error : systemFailure(error)));
  lines.on("error", (error: Error) => protocolError(error instanceof ProcessError ? error : systemFailure(error)));
  lines.on("line", (line: string) => {
    if (line.length === 0 || managed.failure() !== undefined) return;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      protocolError(new ProcessError("protocol_error", "Received a non-JSON stdout line."));
      return;
    }
    try {
      options.onLine(value);
    } catch {
      managed.fail(new ProcessError("internal", "The stdout message callback failed."));
    }
  });
  managed.child.stdout.pipe(guard);
  void managed.exited.finally(() => {
    managed.child.stdout.unpipe(guard);
    lines.close();
    guard.destroy();
  }).catch(() => {});

  return {
    exited: managed.exited,
    terminate: managed.terminate,
    stderrTail: managed.stderrTail,
    write(obj: unknown): void {
      const failure = managed.failure();
      if (failure !== undefined) throw failure;
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(obj);
      } catch {
        serialized = undefined;
      }
      if (serialized === undefined) {
        const error = new ProcessError("protocol_error", "Outgoing message is not JSON serializable.");
        managed.fail(error);
        throw error;
      }
      if (managed.child.stdin.destroyed || managed.child.stdin.writableEnded) {
        const error = new ProcessError("process_error", "Cannot write to closed process stdin.");
        managed.fail(error);
        throw error;
      }
      try {
        managed.child.stdin.write(`${serialized}\n`, (error) => {
          if (error) managed.fail(systemFailure(error));
        });
      } catch (error: unknown) {
        const failure = systemFailure(error);
        managed.fail(failure);
        throw failure;
      }
    },
    endInput(): void {
      if (!managed.child.stdin.destroyed && !managed.child.stdin.writableEnded) managed.child.stdin.end();
    },
  };
}
