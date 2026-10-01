#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "ok";
const fixtureDirectory = process.env.FAKE_FIXTURES_DIR;
const recordFile = process.env.FAKE_CLAUDE_RECORD_FILE;
const fixture = (name) => JSON.parse(readFileSync(join(fixtureDirectory, "claude", name), "utf8"));
const record = (value) => { if (recordFile) appendFileSync(recordFile, `${JSON.stringify(value)}\n`); };
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const argv = process.argv.slice(2);
record({ type: "spawn", pid: process.pid, argv, cwd: process.cwd() });

if (argv[0] === "--version") {
  if (scenario === "version-hang" || scenario === "slow-shutdown-version-hang") setInterval(() => {}, 1000);
  else if (scenario === "version-failed") process.exit(1);
  else if (scenario === "version-malformed") process.stdout.write("development build\n");
  else process.stdout.write("2.1.286 (Claude Code)\n");
} else if (argv[0] === "auth") {
  if (scenario === "auth-hang") setInterval(() => {}, 1000);
  else if (scenario === "auth-invalid") process.stdout.write("not JSON Bearer fake-secret\n");
  else if (scenario === "auth-schema-invalid") process.stdout.write('{"email":"leak@example.invalid"}\n');
  else if (scenario === "auth-failed") process.exit(2);
  else {
    const name = scenario === "unavailable-loggedout" ? "auth-status-loggedout.json"
      : scenario === "unavailable-apikey" ? "auth-status-apikey.json" : "auth-status-loggedin.json";
    const result = fixture(name);
    if (scenario === "unavailable-bedrock") result.apiProvider = "bedrock";
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(result.loggedIn ? 0 : 1));
  }
} else if (argv[0] === "-p") {
  let grandchild;
  let pendingUsage;
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  process.on("SIGTERM", () => {
    if (grandchild && grandchild.exitCode === null && grandchild.signalCode === null) grandchild.once("exit", () => process.exit(0));
    else process.exit(0);
  });
  const response = (id, value) => send({ type: "control_response", response: { subtype: "success", request_id: id, response: value } });
  input.on("line", (line) => {
    const message = JSON.parse(line);
    record({ type: "line", message });
    if (message.type === "control_response") {
      if (pendingUsage) { response(pendingUsage.id, pendingUsage.value); pendingUsage = undefined; }
      return;
    }
    if (message.type !== "control_request") throw new Error("Unexpected message type");
    const subtype = message.request.subtype;
    if (subtype === "initialize") {
      if (scenario === "init-error") send({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "initialize failed" } });
      else if (scenario !== "usage-before-init") response(message.request_id, fixture("initialize-with-pii.json"));
      return;
    }
    if (subtype !== "get_usage" || message.request.skip_behaviors !== true) throw new Error("Unexpected control subtype");
    if (scenario === "hang" || scenario === "hang-grandchild") {
      if (scenario === "hang-grandchild" && !grandchild) {
        grandchild = spawn("sleep", ["60"], { stdio: "ignore" });
        grandchild.once("spawn", () => record({ type: "child", pid: grandchild.pid }));
      }
      return;
    }
    if (scenario === "exit-early") {
      process.stderr.write("Bearer eyJhbGciOiJIUzI1NiJ9.FAKE.FAKE\n", () => process.exit(1));
      return;
    }
    if (scenario === "garbage-line") { process.stdout.write("not JSON Bearer fake-secret\n"); return; }
    if (scenario === "unsupported" || scenario === "upstream-error") {
      send({ type: "control_response", response: { subtype: "error", request_id: message.request_id,
        error: scenario === "unsupported" ? "get_usage is not supported in this context" : "usage failed Bearer fake-secret leak@example.invalid" } });
      return;
    }
    if (scenario === "malformed-envelope") {
      send({ type: "control_response", response: { subtype: "success", request_id: message.request_id } }); return;
    }
    const name = scenario.startsWith("unavailable-") || scenario.startsWith("auth-") ? "get-usage-unavailable.json"
      : scenario === "fetch-failed" ? "get-usage-fetch-failed.json"
      : scenario === "malformed" ? "get-usage-malformed.json"
      : scenario === "scoped" ? "get-usage-max-scoped.json"
      : scenario === "exhausted" ? "get-usage-exhausted.json"
      : scenario === "bad-extra" ? "get-usage-bad-extra.json" : "get-usage-pro.json";
    const value = fixture(name);
    if (scenario === "bad-rate-limits") value.rate_limits = [];
    if (scenario === "stderr-noise") process.stderr.write("x".repeat(12000) + " Bearer fake-secret\n");
    if (scenario === "ok-noise") {
      send({ type: "system", account: fixture("initialize-with-pii.json") });
      send({ type: "commands_changed", commands: [] });
      response("unrelated", { account: fixture("initialize-with-pii.json") });
      send({ type: "control_request", request_id: "server-request", request: { subtype: "can_use_tool", input: fixture("initialize-with-pii.json") } });
      pendingUsage = { id: message.request_id, value };
    } else response(message.request_id, value);
    if (scenario === "usage-before-init") response("agent-usage-init-unrelated", fixture("initialize-with-pii.json"));
  });
  input.on("close", () => {
    record({ type: "stdin-closed" });
    if (scenario === "slow-shutdown" || scenario === "slow-shutdown-version-hang") setInterval(() => {}, 1000);
    else process.exit(0);
  });
} else throw new Error("Unexpected argv");
