import type { ProviderId } from "../domain/model.js";
import { claudeProvider } from "../providers/claude/index.js";
import { codexProvider } from "../providers/codex/index.js";
import type { UsageProvider } from "../providers/types.js";

export const DEFAULT_PROVIDERS: readonly ProviderId[] = Object.freeze(["codex", "claude"]);
export const providerRegistry: Readonly<Record<ProviderId, UsageProvider>> = Object.freeze({
  codex: codexProvider, claude: claudeProvider,
});
