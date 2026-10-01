import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ClaudeControlClient, CLAUDE_CONTROL_SUBTYPES, CLAUDE_USAGE_ARGS } from "../../src/providers/claude/controlClient.js";
import { readClaudeAuthStatus, readClaudeVersion } from "../../src/providers/claude/authStatus.js";
import { claudeHarness, fakeClaude, fixture, type ClaudeHarness } from "../helpers/claude.js";

const sessions: { client: ClaudeControlClient; harness: ClaudeHarness }[] = [];
afterEach(async () => {
  for (const { client, harness } of sessions) { await client.close().catch(() => {}); await harness.dispose(); }
  sessions.length = 0;
});
async function start(scenario = "ok", timeoutMs = 5000) {
  const harness = await claudeHarness(scenario);
  const client = await ClaudeControlClient.create({ bin: fakeClaude, env: harness.env, signal: AbortSignal.timeout(timeoutMs),
    debug: (message) => { harness.debug.push(message); } });
  sessions.push({ client, harness });
  return { client, harness };
}

test("exact argv, two-message handshake, no user messages and clean cwd cleanup", async () => {
  const { client, harness } = await start();
  await expect(stat(client.cwd)).resolves.toBeDefined();
  expect(client.cwd.startsWith(join(tmpdir(), "agent-usage-claude-"))).toBe(true);
  const response = client.getUsage();
  expect(client.getUsage()).toBe(response);
  expect(await response).toEqual(fixture("get-usage-pro.json"));
  await client.close();
  expect(await client.exited).toEqual({ code: 0, signal: null });
  const records = await harness.records();
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--tools", ""];
  expect(records[0]).toMatchObject({ type: "spawn", argv: args, cwd: client.cwd });
  expect(CLAUDE_USAGE_ARGS).toEqual(args);
  expect(CLAUDE_CONTROL_SUBTYPES).toEqual(["initialize", "get_usage"]);
  expect(Object.isFrozen(CLAUDE_CONTROL_SUBTYPES)).toBe(true);
  expect(Object.isFrozen(CLAUDE_USAGE_ARGS)).toBe(true);
  expect(client).not.toHaveProperty("write");
  expect(client).not.toHaveProperty("request");
  const lines = records.filter((record) => record.type === "line").map((record) => record.message);
  expect(lines).toEqual([
    { type: "control_request", request_id: expect.stringMatching(/^agent-usage-init-[0-9a-f-]{36}$/), request: { subtype: "initialize" } },
    { type: "control_request", request_id: expect.stringMatching(/^agent-usage-usage-[0-9a-f-]{36}$/), request: { subtype: "get_usage", skip_behaviors: true } },
  ]);
  expect(JSON.stringify(lines)).not.toContain('"type":"user"');
  expect(records.at(-1)).toEqual({ type: "stdin-closed" });
  await expect(stat(client.cwd)).rejects.toMatchObject({ code: "ENOENT" });
});

test("noise and unrelated responses are ignored; server requests get only an error reply", async () => {
  const { client, harness } = await start("ok-noise");
  expect(await client.getUsage()).toEqual(fixture("get-usage-pro.json"));
  await client.close();
  const lines = (await harness.records()).filter((record) => record.type === "line").map((record) => record.message);
  expect(lines).toHaveLength(3);
  expect(lines[2]).toEqual({ type: "control_response", response: {
    subtype: "error", request_id: "server-request", error: "agent-usage does not handle requests",
  } });
  expect(harness.debug.join("\n")).not.toMatch(/example\.invalid|FAKE|FIXTURE|private|\/home\/user/);
});

test.each(["pii-initialize", "init-error", "usage-before-init"])("%s is discarded without disturbing usage", async (scenario) => {
  const { client, harness } = await start(scenario);
  const value = await client.getUsage();
  expect(value).toEqual(fixture("get-usage-pro.json"));
  expect(JSON.stringify(value) + harness.debug.join("\n")).not.toMatch(/leak|sk-ant|FAKE|FIXTURE|private|\/home\/user/);
  await client.close();
});

test.each([["unsupported", "incompatible_provider"], ["upstream-error", "upstream_error"]])("%s is classified and redacted", async (scenario, code) => {
  const { client } = await start(scenario);
  const operation = client.getUsage();
  await expect(operation).rejects.toMatchObject({ issue: { code } });
  try { await operation; } catch (error: unknown) { expect(String(error)).not.toMatch(/fake-secret|example\.invalid/); }
  await client.close();
});

test.each(["garbage-line", "malformed-envelope"])("%s produces protocol_error", async (scenario) => {
  const { client } = await start(scenario);
  await expect(client.getUsage()).rejects.toMatchObject({ code: "protocol_error" });
});

test("early exit includes the code and a redacted stderr tail", async () => {
  const { client } = await start("exit-early");
  const operation = client.getUsage();
  await expect(operation).rejects.toMatchObject({ code: "process_error" });
  await expect(operation).rejects.toThrow("exit code 1");
  try { await operation; } catch (error: unknown) {
    expect(String(error)).toContain("[REDACTED]");
    expect(String(error)).not.toMatch(/Bearer|eyJ|FAKE/);
  }
});

test("hang respects the deadline, exits, and removes the temporary directory", async () => {
  const { client } = await start("hang", 1000);
  const began = performance.now();
  await expect(client.getUsage()).rejects.toMatchObject({ code: "timeout" });
  await expect(client.close()).rejects.toMatchObject({ code: "timeout" });
  expect(performance.now() - began).toBeLessThan(2500);
  await expect(stat(client.cwd)).rejects.toMatchObject({ code: "ENOENT" });
});

test("shutdown escalates when stdin close does not exit the process", async () => {
  const { client } = await start("slow-shutdown");
  await client.getUsage();
  // Exit must complete without waiting for close(), since the provider can
  // still be awaiting helpers when the usage response arrives.
  expect(await client.exited).toEqual({ code: 0, signal: null });
  await expect(stat(client.cwd)).resolves.toBeDefined();
  await client.close();
});

test.each([
  ["unavailable-loggedin", { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "pro" }],
  ["unavailable-loggedout", { loggedIn: false, authMethod: "none", apiProvider: "firstParty", subscriptionType: null }],
  ["unavailable-apikey", { loggedIn: true, authMethod: "api_key", apiProvider: "firstParty", subscriptionType: null }],
])("auth status %s selects only classification fields, including exit 1", async (scenario, expected) => {
  const { client, harness } = await start(scenario);
  const value = await readClaudeAuthStatus({ bin: fakeClaude, cwd: client.cwd, env: harness.env, signal: AbortSignal.timeout(5000) });
  expect(value).toEqual(expected);
  expect(JSON.stringify(value) + harness.debug.join("\n")).not.toMatch(/email|orgId|orgName|FIXTURE|example\.invalid|\/home\/user/);
  expect((await harness.records()).find((record) => record.type === "spawn" && record.argv[0] === "auth"))
    .toMatchObject({ argv: ["auth", "status", "--json"], cwd: client.cwd });
});

test.each(["auth-invalid", "auth-schema-invalid", "auth-failed"])("%s yields unknown auth status", async (scenario) => {
  const { client, harness } = await start(scenario);
  expect(await readClaudeAuthStatus({ bin: fakeClaude, cwd: client.cwd, env: harness.env, signal: AbortSignal.timeout(5000) })).toBeNull();
});

test.each([["ok", "2.1.286"], ["version-failed", null], ["version-malformed", null]])("version discovery %s is informational", async (scenario, version) => {
  const { client, harness } = await start(scenario);
  expect(await readClaudeVersion({ bin: fakeClaude, cwd: client.cwd, env: harness.env, signal: AbortSignal.timeout(5000) })).toBe(version);
});
