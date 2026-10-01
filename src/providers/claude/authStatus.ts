import { z } from "zod";
import { runCommand } from "../../process/runCommand.js";

export const ClaudeAuthStatusSchema = z.object({
  loggedIn: z.boolean(), authMethod: z.string(), apiProvider: z.string().nullish(), subscriptionType: z.string().nullish(),
}).passthrough().transform(({ loggedIn, authMethod, apiProvider, subscriptionType }) => ({
  loggedIn, authMethod, apiProvider, subscriptionType,
}));
export type ClaudeAuthStatus = z.infer<typeof ClaudeAuthStatusSchema>;

export interface ClaudeHelperOptions {
  bin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}

/** Parse only auth classification fields, including a logged-out exit code 1. */
export async function readClaudeAuthStatus(options: ClaudeHelperOptions): Promise<ClaudeAuthStatus | null> {
  try {
    const result = await runCommand(options.bin, ["auth", "status", "--json"], { ...options, timeoutMs: 10000 });
    const parsed = ClaudeAuthStatusSchema.safeParse(JSON.parse(result.stdout) as unknown);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/** Discover the installed version; failures are informational and yield null. */
export async function readClaudeVersion(options: ClaudeHelperOptions): Promise<string | null> {
  try {
    const result = await runCommand(options.bin, ["--version"], { ...options, timeoutMs: 5000 });
    return result.code === 0 ? result.stdout.match(/^(\d+\.\d+\.\d+)/)?.[1] ?? null : null;
  } catch { return null; }
}
