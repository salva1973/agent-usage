#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, closeSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

// The script is passed as an argv element; this fake never uses a shell.
const script = JSON.parse(process.argv[2] ?? "{}");
let grandchild;
let keepAlive;

function record(pid) {
  if (script.recordFile) appendFileSync(script.recordFile, `${pid}\n`);
}
record(process.pid);

if (script.ignoreTerm) process.on("SIGTERM", () => {});
else {
  process.on("SIGTERM", () => {
    if (grandchild && grandchild.exitCode === null && grandchild.signalCode === null) {
      grandchild.once("exit", () => process.exit(0));
    } else process.exit(0);
  });
}

if (script.echo) {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const message = JSON.parse(line);
    process.stdout.write(`${JSON.stringify({ echo: message })}\n`);
  });
  lines.once("close", () => process.exit(script.exitCode ?? 0));
}

for (const action of script.actions ?? []) {
  if (action.type === "write") {
    const stream = action.stream === "stderr" ? process.stderr : process.stdout;
    for (const chunk of action.chunks ?? [action.text.repeat(action.repeat ?? 1)]) {
      await new Promise((resolve, reject) => stream.write(chunk, (error) => error ? reject(error) : resolve()));
      if (action.delayMs) await delay(action.delayMs);
    }
  } else if (action.type === "sleep") await delay(action.ms);
  else if (action.type === "grandchild") {
    const stdio = action.keepPipes ? ["ignore", "inherit", "inherit"] : "ignore";
    grandchild = action.ignoreTerm
      ? spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio })
      : spawn("sleep", ["60"], { stdio });
    await new Promise((resolve, reject) => {
      grandchild.once("spawn", resolve);
      grandchild.once("error", reject);
    });
    record(grandchild.pid);
  } else if (action.type === "ready") {
    if (grandchild && action.settleMs) await delay(action.settleMs);
    process.stdout.write(`${JSON.stringify({ type: "ready", pid: process.pid, grandchildPid: grandchild?.pid ?? null })}\n`);
  } else if (action.type === "close-stdin") {
    process.stdin.destroy();
    closeSync(0);
  }
  else if (action.type === "exit") process.exit(action.code ?? 0);
  else if (action.type === "hang") keepAlive = setInterval(() => {}, 1000);
}

if (!script.echo && !keepAlive) process.exit(script.exitCode ?? 0);
