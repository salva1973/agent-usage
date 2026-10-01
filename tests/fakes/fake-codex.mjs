#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const scenario = process.env.FAKE_CODEX_SCENARIO ?? "ok";
const fixtureDirectory = process.env.FAKE_FIXTURES_DIR;
const recordFile = process.env.FAKE_CODEX_RECORD_FILE;
const fixture = (name) => JSON.parse(readFileSync(join(fixtureDirectory, "codex", name), "utf8"));
const record = (value) => { if (recordFile) appendFileSync(recordFile, `${JSON.stringify(value)}\n`); };
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
record({ type: "spawn", pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd() });
let initialized = false;
let grandchild;

process.on("SIGTERM", () => {
  if (grandchild && grandchild.exitCode === null && grandchild.signalCode === null) grandchild.once("exit", () => process.exit(0));
  else process.exit(0);
});

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const message = JSON.parse(line);
  record({ type: "line", message });
  if (message.method === "initialized") {
    initialized = true;
    if (scenario === "crash-after-init") {
      process.stderr.write("Bearer eyJhbGciOiJIUzI1NiJ9.FAKE.FAKE\n", () => process.exit(1));
    }
    if (scenario === "garbage-line") process.stdout.write("not JSON Bearer fake-secret\n");
    if (scenario === "malformed-envelope") send({ id: 999 });
    if (scenario === "notifications-noise") {
      send({ method: "configWarning", params: { email: "noise@example.invalid", secret: "sk-FAKEFAKEFAKEFAKEFAKE" } });
      send({ method: "remoteControl/status/changed", params: {} });
      send({ method: "account/updated", params: { accountId: "FIXTURE" } });
      send({ method: "approval/request", id: "server-request", params: { email: "noise@example.invalid" } });
      send({ id: 999, result: { unrelated: true } });
    }
    return;
  }
  if (message.method === undefined) return;
  if (message.method === "initialize") {
    const result = fixture("initialize.json");
    if (scenario === "unversioned") result.userAgent = "codex dev build";
    send({ id: message.id, result });
    return;
  }
  if (!initialized) throw new Error("Request before initialized notification");
  if (scenario === "hang-after-init" || scenario === "crash-after-init") return;
  if (scenario === "hang-grandchild") {
    if (!grandchild) {
      grandchild = spawn("sleep", ["60"], { stdio: "ignore" });
      grandchild.once("spawn", () => record({ type: "child", pid: grandchild.pid }));
    }
    return;
  }
  if (message.method === "account/read") {
    if (scenario === "account-error") send({ id: message.id, error: { code: -32000, message: "account read failed" } });
    else send({ id: message.id, result: fixture(scenario === "unauth" ? "account-none.json"
      : scenario === "apikey" || scenario === "apikey-supported" ? "account-apikey.json" : "account-chatgpt.json") });
    return;
  }
  if (message.method === "account/rateLimits/read") {
    const errors = {
      unauth: fixture("error-unauth.json"),
      "auth-error": { code: -32600, message: "authentication required" },
      apikey: { code: -32600, message: "plan rate limits unavailable" },
      "method-not-found": { code: -32601, message: "method not found" },
      "invalid-params": { code: -32602, message: "invalid params" },
      "upstream-error": { code: -32000, message: "upstream unavailable Bearer fake-secret" },
    };
    if (errors[scenario]) { send({ id: message.id, error: errors[scenario] }); return; }
    const result = fixture(scenario === "malformed" ? "ratelimits-malformed.json"
      : scenario === "missing-ratelimits" ? "ratelimits-missing.json" : "ratelimits-plus.json");
    if (scenario === "stderr-noise") process.stderr.write("x".repeat(12000) + " Bearer fake-secret\n");
    if (scenario === "ok-out-of-order") setTimeout(() => send({ id: message.id, result }), 200);
    else send({ id: message.id, result });
    return;
  }
  if (message.method === "account/usage/read") {
    if (scenario === "analytics-error") send({ id: message.id, error: { code: -32000, message: "analytics unavailable" } });
    else if (scenario === "analytics-malformed") send({ id: message.id, result: { summary: { lifetimeTokens: "high" } } });
    else send({ id: message.id, result: fixture("usage.json") });
    return;
  }
  throw new Error("Unexpected client method");
});
input.on("close", () => {
  record({ type: "stdin-closed" });
  if (scenario === "slow-shutdown") setInterval(() => {}, 1000);
  else process.exit(0);
});
