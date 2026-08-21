/* Pure settings -> SpawnOptions mapping, split out of ./SubprocessManager.ts.

   The shared view layer builds spawn options and hands them to whatever
   engine the host supplies (a local SubprocessManager on the desktop, a
   WebSocket to the gateway daemon on iOS), so this mapping has to be
   importable without node. Nothing here touches the machine.
   ./SubprocessManager.ts re-exports it, so existing import sites are
   unchanged. */

import { resolveModelId, type ClaudeChatSettings } from "../settings-data";
import type { SpawnOptions } from "./SubprocessManager";

/* Convenience helper to translate plugin settings into SpawnOptions. */
export function spawnOptionsFromSettings(
  settings: ClaudeChatSettings,
  cwd: string,
  sessionId?: string,
  overrides?: {
    model?: string;
    effort?: string;
    permissionMode?: ClaudeChatSettings["permissionMode"];
    appendSystemPrompt?: string;
    noSessionPersistence?: boolean;
    mcpDenyPatterns?: string[];
  }
): SpawnOptions {
  return {
    cwd,
    sessionId,
    model: overrides?.model ?? resolveModelId(settings.defaultModel),
    effort: overrides?.effort ?? settings.defaultEffort,
    claudePath: settings.claudePath,
    permissionMode: overrides?.permissionMode ?? settings.permissionMode,
    includePartialMessages: settings.includePartialMessages,
    appendSystemPrompt: overrides?.appendSystemPrompt,
    noSessionPersistence: overrides?.noSessionPersistence,
    mcpDenyPatterns: overrides?.mcpDenyPatterns,
  };
}
