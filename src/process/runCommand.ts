import { boundedUtf8, spawnManagedProcess } from "./jsonlProcess.js";

export interface RunCommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Capture at most 1 MiB stdout and an 8 KiB stderr tail, including nonzero exits. */
export async function runCommand(bin: string, args: string[], options: RunCommandOptions): Promise<CommandResult> {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 2 ** 31 - 1) {
    throw new TypeError("timeoutMs must be an integer from 0 to 2147483647");
  }
  const deadline = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal === undefined ? deadline : AbortSignal.any([deadline, options.signal]);
  const managed = spawnManagedProcess({ bin, args, cwd: options.cwd, env: options.env, signal });
  const chunks: Buffer[] = [];
  const maxBytes = 1024 * 1024;
  let bytes = 0;
  managed.child.stdout.on("data", (chunk: Buffer) => {
    if (bytes >= maxBytes) return;
    const kept = Buffer.from(chunk.subarray(0, maxBytes - bytes));
    chunks.push(kept);
    bytes += kept.length;
  });
  managed.child.stdin.end();
  const exit = await managed.exited;
  return { code: exit.code, stdout: boundedUtf8(Buffer.concat(chunks), maxBytes), stderr: managed.stderrTail() };
}
