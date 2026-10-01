import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  createJsonlProcess, processExitError, ProcessError,
  type JsonlProcess, type JsonlProcessOptions,
} from "../../src/process/jsonlProcess.js";
import { runCommand } from "../../src/process/runCommand.js";

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const project = fileURLToPath(new URL("../../", import.meta.url));
const fake = fileURLToPath(new URL("../fakes/echo-jsonl.mjs", import.meta.url));
const clients = new Set<JsonlProcess>();
const readySchema = z.object({ type: z.literal("ready"), pid: z.number(), grandchildPid: z.number().nullable() });
let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(project, ".m2-process-test-"));
});

afterEach(async () => {
  await Promise.all([...clients].map((client) => client.terminate()));
  clients.clear();
  await rm(directory, { recursive: true, force: true });
});

function start(script: unknown, overrides: Partial<JsonlProcessOptions> = {}) {
  const messages: unknown[] = [];
  const errors: Error[] = [];
  let resolveReady!: (value: z.infer<typeof readySchema>) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<z.infer<typeof readySchema>>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  const client = createJsonlProcess({
    bin: process.execPath, args: [fake, JSON.stringify(script)], cwd: project, env: process.env,
    signal: AbortSignal.timeout(5000),
    onLine(value) {
      messages.push(value);
      const parsed = readySchema.safeParse(value);
      if (parsed.success) resolveReady(parsed.data);
    },
    onProtocolError(error) { errors.push(error); },
    ...overrides,
  });
  clients.add(client);
  void client.exited.catch(rejectReady);
  return { client, messages, errors, ready };
}

async function dead(pid: number): Promise<void> {
  const deadline = performance.now() + 2000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error: unknown) {
      expect(error).toMatchObject({ code: "ESRCH" });
      return;
    }
    if (performance.now() >= deadline) throw new Error(`Process ${pid} survived cleanup`);
    await delay(10);
  }
}

async function recordedPids(path: string): Promise<number[]> {
  return (await readFile(path, "utf8")).trim().split("\n").map(Number);
}

describe("JSON-lines transport", () => {
  test("observes ENOENT through the spawn error event", async () => {
    const { client } = start({}, { bin: join(directory, "missing") });
    await expect(client.exited).rejects.toMatchObject({ code: "not_installed", issue: { retryable: false } });
  });

  test("maps EACCES to not_installed", async () => {
    const bin = join(directory, "not-executable");
    await writeFile(bin, "#!/usr/bin/env node\n", { mode: 0o600 });
    const { client } = start({}, { bin });
    await expect(client.exited).rejects.toMatchObject({ code: "not_installed" });
  });

  test("a missing cwd retains Node's ENOENT classification", async () => {
    const { client } = start({}, { cwd: join(directory, "missing") });
    // An absent cwd is reported as ENOENT by Node, just like an absent binary.
    await expect(client.exited).rejects.toMatchObject({ code: "not_installed" });
  });

  test("inherits the exact environment reference and uses detached pipes", async () => {
    const env = { PATH: "/usr/bin:/bin" };
    const { client } = start({}, { env });
    const call = vi.mocked(spawn).mock.calls.at(-1);
    expect(call?.[2]?.env).toBe(env);
    expect(call?.[2]).toMatchObject({ cwd: project, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    expect(call?.[2]?.shell).toBeUndefined();
    await expect(client.exited).resolves.toEqual({ code: 0, signal: null });
  });

  test("writes JSON requests and receives responses before clean stdin closure", async () => {
    const { client, messages } = start({ echo: true });
    client.write({ id: 1, message: "hello" });
    client.write({ id: 2, message: "world" });
    client.endInput();
    client.endInput();
    await expect(client.exited).resolves.toEqual({ code: 0, signal: null });
    expect(messages).toEqual([{ echo: { id: 1, message: "hello" } }, { echo: { id: 2, message: "world" } }]);
  });

  test("frames interleaved messages from partial writes, CRLF, empty lines and a final line without newline", async () => {
    const { client, messages, errors } = start({ actions: [{
      type: "write", delayMs: 2,
      chunks: ["\n\r", "\n{\"id\":", "1,\"result\":\"a\"}\r", "\n{\"method\":\"notice\"}\n{\"id\":2", ",\"result\":\"b\"}"],
    }] });
    await client.exited;
    expect(messages).toEqual([{ id: 1, result: "a" }, { method: "notice" }, { id: 2, result: "b" }]);
    expect(errors).toEqual([]);
  });

  test("a non-JSON line produces one protocol failure without leaking its contents", async () => {
    const { client, messages, errors } = start({ actions: [
      { type: "write", text: "bad Bearer secret user@example.invalid\n" }, { type: "hang" },
    ] });
    await expect(client.exited).rejects.toMatchObject({ code: "protocol_error" });
    expect(messages).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).not.toMatch(/secret|example\.invalid/);
  });

  test("an oversized unterminated line fails before readline can buffer it all", async () => {
    const { client, errors } = start({ actions: [
      { type: "write", chunks: ["a".repeat(40), "b".repeat(25)], delayMs: 5 }, { type: "hang" },
    ] }, { maxLineBytes: 64 });
    await expect(client.exited).rejects.toMatchObject({ code: "protocol_error" });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("64 bytes");
  });

  test("line limits count UTF-8 bytes rather than characters", async () => {
    const { client } = start({ actions: [{ type: "write", text: `${JSON.stringify("ééé")}\n` }] }, { maxLineBytes: 7 });
    await expect(client.exited).rejects.toMatchObject({ code: "protocol_error" });
  });

  test("a line exactly at the limit is valid and CRLF bytes do not count", async () => {
    const { client, messages } = start({ actions: [{ type: "write", text: '"éé"\r\n' }] }, { maxLineBytes: 6 });
    await client.exited;
    expect(messages).toEqual(["éé"]);
  });

  test("the default maximum line size is 16 MiB", async () => {
    const recordFile = join(directory, "pids");
    const { client } = start({ recordFile, actions: [
      { type: "write", text: "x", repeat: 16 * 1024 * 1024 + 1 }, { type: "hang" },
    ] });
    await expect(client.exited).rejects.toMatchObject({ code: "protocol_error" });
    for (const pid of await recordedPids(recordFile)) await dead(pid);
  });

  test("an early exit carries its code and produces a redacted process_error for an awaited response", async () => {
    const { client } = start({ actions: [
      { type: "write", stream: "stderr", text: "Bearer eyJhbGciOiJIUzI1NiJ9.FAKE.FAKE user@example.invalid\n" },
      { type: "exit", code: 7 },
    ] });
    const neverAnswered = new Promise<unknown>(() => {});
    await expect(Promise.race([
      neverAnswered,
      client.exited.then((exit) => { throw processExitError(exit, client.stderrTail()); }),
    ])).rejects.toMatchObject({ code: "process_error", issue: { retryable: true } });
    const error = processExitError(await client.exited, client.stderrTail());
    expect(error.message).toContain("exit code 7");
    expect(error.message).not.toMatch(/Bearer|eyJ|example\.invalid/);
    expect(error.message).toContain("[REDACTED]");
    expect(error.message.length).toBeLessThanOrEqual(300);
  });

  test("early exit code zero can also fail an awaited response", async () => {
    const { client } = start({});
    expect(processExitError(await client.exited, "").issue.code).toBe("process_error");
  });

  test("stderr keeps only its last 8 KiB", async () => {
    const { client } = start({ actions: [{ type: "write", stream: "stderr", text: "a".repeat(20000) + "TAIL" }] });
    await client.exited;
    expect(Buffer.byteLength(client.stderrTail())).toBe(8192);
    expect(client.stderrTail()).toBe("a".repeat(8188) + "TAIL");
  });

  test("custom stderr rings are byte bounded across multibyte chunks", async () => {
    const { client } = start({ actions: [{ type: "write", stream: "stderr", chunks: ["é".repeat(10), "é".repeat(10)] }] }, { stderrRingBytes: 7 });
    await client.exited;
    expect(client.stderrTail()).toBe("ééé");
    expect(Buffer.byteLength(client.stderrTail())).toBeLessThanOrEqual(7);
  });

  test("a zero-sized stderr ring discards diagnostics", async () => {
    const { client } = start({ actions: [{ type: "write", stream: "stderr", text: "discard" }] }, { stderrRingBytes: 0 });
    await client.exited;
    expect(client.stderrTail()).toBe("");
  });

  test("invalid outbound messages throw before writing and clean up the child", async () => {
    const { client } = start({ echo: true });
    expect(() => client.write(undefined)).toThrow(ProcessError);
    await expect(client.exited).rejects.toMatchObject({ code: "protocol_error" });
  });

  test("writing after endInput throws process_error", async () => {
    const { client } = start({ echo: true });
    client.endInput();
    expect(() => client.write({ id: 1 })).toThrow(expect.objectContaining({ code: "process_error" }));
    await expect(client.exited).rejects.toMatchObject({ code: "process_error" });
  });

  test("stdin EPIPE is observed without an uncaught stream error", async () => {
    const { client, ready } = start({ actions: [{ type: "close-stdin" }, { type: "ready" }, { type: "hang" }] });
    const info = await ready;
    client.write({ data: "a".repeat(1024 * 1024) });
    await expect(client.exited).rejects.toMatchObject({ code: "process_error" });
    await dead(info.pid);
  });
});

describe("process groups and cancellation", () => {
  test("caller abort kills a child and its sleep 60 grandchild before rejecting", async () => {
    const controller = new AbortController();
    const { client, ready } = start({ actions: [{ type: "grandchild" }, { type: "ready" }, { type: "hang" }] }, { signal: controller.signal });
    const info = await ready;
    controller.abort();
    await expect(client.exited).rejects.toMatchObject({ code: "aborted" });
    await dead(info.pid);
    await dead(info.grandchildPid!);
  });

  test("a deadline kills both child and grandchild and classifies timeout", async () => {
    const began = performance.now();
    const { client, ready } = start({ actions: [{ type: "grandchild" }, { type: "ready" }, { type: "hang" }] }, { signal: AbortSignal.timeout(500) });
    const info = await ready;
    await expect(client.exited).rejects.toMatchObject({ code: "timeout" });
    expect(performance.now() - began).toBeLessThan(2000);
    await dead(info.pid);
    await dead(info.grandchildPid!);
  });

  test("SIGKILL follows SIGTERM after one second when both processes ignore it", async () => {
    const { client, ready } = start({ ignoreTerm: true, actions: [
      { type: "grandchild", ignoreTerm: true }, { type: "ready", settleMs: 100 }, { type: "hang" },
    ] });
    const info = await ready;
    const began = performance.now();
    const first = client.terminate();
    expect(client.terminate()).toBe(first);
    await first;
    expect(performance.now() - began).toBeGreaterThanOrEqual(950);
    expect(performance.now() - began).toBeLessThan(1500);
    expect(await client.exited).toEqual({ code: null, signal: "SIGKILL" });
    await dead(info.pid);
    await dead(info.grandchildPid!);
  });

  test("parent exit cleans surviving descendants even when they hold its pipes open", async () => {
    const { client, ready } = start({ actions: [
      { type: "grandchild", keepPipes: true }, { type: "ready" }, { type: "exit", code: 6 },
    ] });
    const info = await ready;
    expect(await client.exited).toEqual({ code: 6, signal: null });
    await dead(info.pid);
    await dead(info.grandchildPid!);
  });

  test("a pre-aborted signal prevents spawning", () => {
    const count = vi.mocked(spawn).mock.calls.length;
    expect(() => start({}, { signal: AbortSignal.abort() })).toThrow(expect.objectContaining({ code: "aborted" }));
    expect(vi.mocked(spawn).mock.calls).toHaveLength(count);
  });

  test("the exit hook kills every registered child group", async () => {
    const registry = new URL("../../src/process/childRegistry.ts", import.meta.url).href;
    const script = `
      import { spawn } from "node:child_process";
      import { createInterface } from "node:readline";
      import { registerChildGroup } from ${JSON.stringify(registry)};
      const child = spawn(process.execPath, [${JSON.stringify(fake)}, ${JSON.stringify(JSON.stringify({ actions: [{ type: "grandchild" }, { type: "ready" }, { type: "hang" }] }))}], {
        cwd: ${JSON.stringify(project)}, env: process.env,
        detached: true, stdio: ["pipe", "pipe", "pipe"],
      });
      registerChildGroup(child);
      createInterface({ input: child.stdout }).once("line", (line) => {
        process.stdout.write(line + "\\n", () => process.exit(0));
      });
    `;
    const result = await runCommand(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { cwd: project, env: process.env, timeoutMs: 3000 });
    expect(result.code).toBe(0);
    const info = readySchema.parse(JSON.parse(result.stdout));
    await dead(info.pid);
    await dead(info.grandchildPid!);
  });
});

describe("runCommand", () => {
  function command(script: unknown, timeoutMs = 5000, signal?: AbortSignal) {
    return runCommand(process.execPath, [fake, JSON.stringify(script)], {
      cwd: project, env: process.env, timeoutMs, ...(signal === undefined ? {} : { signal }),
    });
  }

  test("nonzero exit preserves stdout and stderr", async () => {
    expect(await command({ actions: [
      { type: "write", text: '{"loggedIn":false}\n' },
      { type: "write", stream: "stderr", text: "diagnostic\n" }, { type: "exit", code: 1 },
    ] })).toEqual({ code: 1, stdout: '{"loggedIn":false}\n', stderr: "diagnostic\n" });
  });

  test("command output is capped while excess stdout is still drained", async () => {
    const result = await command({ actions: [
      { type: "write", text: "a", repeat: 1024 * 1024 + 20000 },
      { type: "write", stream: "stderr", text: "b".repeat(12000) },
    ] });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("a".repeat(1024 * 1024));
    expect(result.stderr).toBe("b".repeat(8192));
  });

  test("UTF-8 stdout is not split at the capture limit", async () => {
    const result = await command({ actions: [
      { type: "write", text: "a", repeat: 1024 * 1024 - 1 },
      { type: "write", text: "é" },
    ] });
    expect(result.stdout).toBe("a".repeat(1024 * 1024 - 1));
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1024 * 1024);
  });

  test("stdin is closed so a command waiting for EOF can exit", async () => {
    expect(await command({ echo: true })).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test("command timeout kills the child and its grandchild", async () => {
    const recordFile = join(directory, "pids");
    await expect(command({ recordFile, actions: [{ type: "grandchild" }, { type: "hang" }] }, 500)).rejects.toMatchObject({ code: "timeout" });
    const pids = await recordedPids(recordFile);
    expect(pids).toHaveLength(2);
    for (const pid of pids) await dead(pid);
  });

  test("commands also support caller cancellation", async () => {
    const controller = new AbortController();
    const recordFile = join(directory, "pids");
    const operation = command({ recordFile, actions: [{ type: "grandchild" }, { type: "hang" }] }, 5000, controller.signal);
    while (true) {
      try {
        if ((await recordedPids(recordFile)).length === 2) break;
      } catch { /* The child has not created the recording yet. */ }
      await delay(10);
    }
    controller.abort();
    await expect(operation).rejects.toMatchObject({ code: "aborted" });
    for (const pid of await recordedPids(recordFile)) await dead(pid);
  });

  test("a missing command maps to not_installed", async () => {
    await expect(runCommand(join(directory, "missing"), [], { cwd: project, env: process.env, timeoutMs: 1000 })).rejects.toMatchObject({ code: "not_installed" });
  });
});
