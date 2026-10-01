import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { AppServerClient, CODEX_ALLOWED_METHODS } from "../../src/providers/codex/appServerClient.js";
import { version } from "../../src/version.js";
import { codexHarness, fakeCodex, fixture, type CodexHarness } from "../helpers/codex.js";

const sessions: { client: AppServerClient; harness: CodexHarness }[] = [];
afterEach(async () => {
  for (const session of sessions) {
    await session.client.terminate();
    await session.harness.dispose();
  }
  sessions.length = 0;
});

async function start(scenario = "ok", timeoutMs = 5000) {
  const harness = await codexHarness(scenario);
  const client = new AppServerClient({ bin: fakeCodex, env: harness.env, signal: AbortSignal.timeout(timeoutMs), debug: (message) => { harness.debug.push(message); } });
  sessions.push({ client, harness });
  return { client, harness };
}

async function reads(client: AppServerClient): Promise<unknown[]> {
  return Promise.all([
    client.request("account/read", { refreshToken: false }),
    client.request("account/rateLimits/read", { excludeResetCreditDetails: true }),
    client.request("account/usage/read", null),
  ]);
}

test("handshake, incrementing ids, exact argv/params and clean shutdown", async () => {
  const { client, harness } = await start();
  expect(await client.initialize()).toEqual(fixture("initialize.json"));
  expect(await reads(client)).toEqual([fixture("account-chatgpt.json"), fixture("ratelimits-plus.json"), fixture("usage.json")]);
  await client.close();
  expect(await client.exited).toEqual({ code: 0, signal: null });
  const records = await harness.records();
  expect(records[0]).toMatchObject({ type: "spawn", argv: ["app-server"], cwd: tmpdir() });
  expect(records.filter((record) => record.type === "line").map((record) => record.message)).toEqual([
    { method: "initialize", id: 1, params: { clientInfo: { name: "agent-usage", title: "agent-usage", version }, capabilities: null } },
    { method: "initialized" },
    { method: "account/read", id: 2, params: { refreshToken: false } },
    { method: "account/rateLimits/read", id: 3, params: { excludeResetCreditDetails: true } },
    { method: "account/usage/read", id: 4, params: null },
  ]);
  expect(records.at(-1)).toEqual({ type: "stdin-closed" });
});

test("correlates out-of-order results instead of closing after the highest request id", async () => {
  const { client } = await start("ok-out-of-order");
  await client.initialize();
  const order: string[] = [];
  const account = client.request("account/read", { refreshToken: false }).then((value) => { order.push("account"); return value; });
  const limits = client.request("account/rateLimits/read", { excludeResetCreditDetails: true }).then((value) => { order.push("limits"); return value; });
  const usage = client.request("account/usage/read", null).then((value) => { order.push("usage"); return value; });
  expect(await Promise.all([account, limits, usage])).toEqual([fixture("account-chatgpt.json"), fixture("ratelimits-plus.json"), fixture("usage.json")]);
  expect(order).toEqual(["account", "usage", "limits"]);
  await client.close();
});

test("ignores notifications and unknown ids, and refuses server requests without disturbing pending reads", async () => {
  const { client, harness } = await start("notifications-noise");
  await client.initialize();
  expect(await reads(client)).toEqual([fixture("account-chatgpt.json"), fixture("ratelimits-plus.json"), fixture("usage.json")]);
  await client.close();
  const lines = (await harness.records()).filter((record) => record.type === "line").map((record) => record.message);
  expect(lines).toContainEqual({ id: "server-request", error: { code: -32601, message: "agent-usage: client does not handle server requests" } });
  expect(harness.debug.join("\n")).toContain("unknown id ignored");
  expect(harness.debug.join("\n")).toContain("notification account/updated");
  expect(harness.debug.join("\n")).not.toMatch(/example\.invalid|FIXTURE|sk-FAKE|secret/);
});

test("the immutable method allowlist refuses mutations synchronously before writing", async () => {
  const { client, harness } = await start();
  await client.initialize();
  await client.request("account/read", { refreshToken: false });
  const before = (await harness.records()).filter((record) => record.type === "line").length;
  expect(CODEX_ALLOWED_METHODS).toEqual(["initialize", "account/read", "account/rateLimits/read", "account/usage/read"]);
  expect(Object.isFrozen(CODEX_ALLOWED_METHODS)).toBe(true);
  for (const method of ["account/rateLimitResetCredit/consume", "account/logout", "account/login/start", "unknown"]) {
    expect(() => client.request(method, {})).toThrow("method not allowed");
  }
  await client.close();
  const lines = (await harness.records()).filter((record) => record.type === "line");
  expect(lines).toHaveLength(before);
  expect(JSON.stringify(lines)).not.toContain("rateLimitResetCredit");
});

test.each(["garbage-line", "malformed-envelope"])("%s fails every pending read with protocol_error", async (scenario) => {
  const { client } = await start(scenario);
  await client.initialize();
  const results = await Promise.allSettled([
    client.request("account/read", { refreshToken: false }),
    client.request("account/rateLimits/read", { excludeResetCreditDetails: true }),
    client.request("account/usage/read", null),
  ]);
  for (const result of results) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "protocol_error" });
  }
  await client.close().catch(() => {});
});

test("hang-after-init times out and does not leave a process alive", async () => {
  const began = performance.now();
  const { client } = await start("hang-after-init", 1000);
  await client.initialize();
  await expect(reads(client)).rejects.toMatchObject({ code: "timeout" });
  await expect(client.close()).rejects.toMatchObject({ code: "timeout" });
  expect(performance.now() - began).toBeLessThan(2500);
});

test("crash-after-init fails pending reads with a redacted stderr tail and exit code", async () => {
  const { client } = await start("crash-after-init");
  await client.initialize();
  const operation = reads(client);
  await expect(operation).rejects.toMatchObject({ code: "process_error" });
  await expect(operation).rejects.toThrow("exit code 1");
  try { await operation; } catch (error: unknown) {
    expect(String(error)).not.toMatch(/eyJ|Bearer|FAKE/);
    expect(String(error)).toContain("[REDACTED]");
  }
  await client.close();
});

test("shutdown terminates a process which stays alive after stdin closes", async () => {
  const { client } = await start("slow-shutdown");
  await client.initialize();
  await reads(client);
  const began = performance.now();
  await client.close();
  expect(performance.now() - began).toBeGreaterThanOrEqual(1950);
  expect(performance.now() - began).toBeLessThan(3500);
  expect(await client.exited).toEqual({ code: 0, signal: null });
});
