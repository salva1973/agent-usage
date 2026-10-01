import { readFileSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "vitest";
import { z } from "zod";
import type { ProviderContext } from "../../src/providers/types.js";

const project = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
export const fakeClaude = fileURLToPath(new URL("../fakes/fake-claude.mjs", import.meta.url));
export const fixedNow = "2026-10-01T13:40:02.110Z";
const recordSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("spawn"), pid: z.number(), argv: z.array(z.string()), cwd: z.string() }),
  z.object({ type: z.literal("child"), pid: z.number() }),
  z.object({ type: z.literal("line"), message: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("stdin-closed") }),
]);
export type ClaudeFakeRecord = z.infer<typeof recordSchema>;

/** Load the PII-free capture or a sanitized scenario derived from it. */
export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, "claude", name), "utf8")) as unknown;
}

export interface ClaudeHarness {
  env: NodeJS.ProcessEnv;
  debug: string[];
  context(overrides?: Partial<ProviderContext>): ProviderContext;
  records(): Promise<ClaudeFakeRecord[]>;
  dispose(): Promise<void>;
}

/** Run only the fake binary and verify processes and ephemeral cwds are gone. */
export async function claudeHarness(scenario = "ok"): Promise<ClaudeHarness> {
  const directory = await fs.mkdtemp(join(project, ".claude-test-"));
  const recordFile = join(directory, "record.jsonl");
  const env = { ...process.env, FAKE_CLAUDE_SCENARIO: scenario, FAKE_FIXTURES_DIR: fixtures, FAKE_CLAUDE_RECORD_FILE: recordFile };
  const debug: string[] = [];
  async function records(): Promise<ClaudeFakeRecord[]> {
    try {
      return (await fs.readFile(recordFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => recordSchema.parse(JSON.parse(line)));
    } catch (error: unknown) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }
  return {
    env, debug, records,
    context(overrides = {}) {
      return { timeoutMs: 5000, signal: new AbortController().signal, includeAnalytics: false, env,
        bin: fakeClaude, now: () => new Date(fixedNow), debug: (message) => { debug.push(message); }, ...overrides };
    },
    async dispose() {
      try {
        for (const record of await records()) {
          if (record.type !== "spawn" && record.type !== "child") continue;
          const deadline = performance.now() + 1500;
          while (true) {
            try { process.kill(record.pid, 0); } catch (error: unknown) { expect(error).toMatchObject({ code: "ESRCH" }); break; }
            if (performance.now() >= deadline) throw new Error(`Fake process ${record.pid} survived cleanup`);
            await delay(10);
          }
          if (record.type === "spawn" && record.argv[0] === "-p") {
            await expect(fs.stat(record.cwd)).rejects.toMatchObject({ code: "ENOENT" });
          }
        }
      } finally { await fs.rm(directory, { recursive: true, force: true }); }
    },
  };
}
