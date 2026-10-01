import { readFileSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "vitest";
import { z } from "zod";
import type { ProviderContext } from "../../src/providers/types.js";

const project = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = fileURLToPath(new URL("../fixtures/", import.meta.url));
export const fakeCodex = fileURLToPath(new URL("../fakes/fake-codex.mjs", import.meta.url));
export const fixedNow = "2026-10-01T13:40:01.050Z";

const recordSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("spawn"), pid: z.number(), argv: z.array(z.string()), cwd: z.string() }),
  z.object({ type: z.literal("child"), pid: z.number() }),
  z.object({ type: z.literal("line"), message: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("stdin-closed") }),
]);
export type FakeRecord = z.infer<typeof recordSchema>;

/** Read a reconstructed, sanitized protocol fixture from this project. */
export function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, "codex", name), "utf8")) as unknown;
}

export interface CodexHarness {
  env: NodeJS.ProcessEnv;
  debug: string[];
  context(overrides?: Partial<ProviderContext>): ProviderContext;
  records(): Promise<FakeRecord[]>;
  dispose(): Promise<void>;
}

/** Create fake-only context and recording files under the project directory. */
export async function codexHarness(scenario = "ok"): Promise<CodexHarness> {
  const directory = await fs.mkdtemp(join(project, ".codex-test-"));
  const recordFile = join(directory, "record.jsonl");
  const env = {
    ...process.env, FAKE_CODEX_SCENARIO: scenario, FAKE_FIXTURES_DIR: fixtures,
    FAKE_CODEX_RECORD_FILE: recordFile,
  };
  const debug: string[] = [];
  async function records(): Promise<FakeRecord[]> {
    let text: string;
    try { text = await fs.readFile(recordFile, "utf8"); } catch (error: unknown) {
      if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
    return text.trim().split("\n").filter(Boolean).map((line) => recordSchema.parse(JSON.parse(line)));
  }
  return {
    env, debug, records,
    context(overrides = {}) {
      return {
        timeoutMs: 5000, signal: new AbortController().signal, includeAnalytics: false,
        env, bin: fakeCodex, now: () => new Date(fixedNow), debug: (message) => { debug.push(message); }, ...overrides,
      };
    },
    async dispose() {
      try {
        for (const record of await records()) {
          if (record.type !== "spawn" && record.type !== "child") continue;
          const deadline = performance.now() + 1500;
          while (true) {
            try { process.kill(record.pid, 0); } catch (error: unknown) {
              expect(error).toMatchObject({ code: "ESRCH" });
              break;
            }
            if (performance.now() >= deadline) throw new Error(`Fake process ${record.pid} survived cleanup`);
            await delay(10);
          }
        }
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
  };
}
