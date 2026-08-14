/* Host-app surface shared code is allowed to see.

   Several shared files (`TabController`, `MCPManagerModal`,
   `SubagentManagerModal`, `CreateSubagentModal`) currently do
   `import type ClaudeChatPlugin from "../main"` — a shared -> Obsidian-only
   seam, since main.ts imports obsidian and always will. `PluginHost` is the
   replacement: the exact member set those files actually use, so migrating
   is a one-line retype (`plugin: ClaudeChatPlugin` -> `plugin: PluginHost`)
   and the real ClaudeChatPlugin satisfies it structurally — every existing
   `new TabController(this.plugin, ...)` call site keeps compiling unchanged.

   IMPORT DISCIPLINE: everything here is `import type`. Type-only imports
   are erased at emit, so this file creates no runtime edges (no cycles when
   the imported modules themselves start importing ./registry) and, once the
   settings-tab UI is split out of ../settings, no compile-time path from
   the platform module to the obsidian package. Do not add value imports.

   The two `create*` factories cover TabController's other seam: it
   constructs ActiveFileIndicator and SelectionTracker (both Obsidian-only,
   both needing the real App) inline today. Routed through the host, the
   Obsidian-only classes stay imported by main.ts alone, and a desktop shell
   supplies its own implementations of the narrow handle interfaces below. */

import type { ClaudeChatSettings } from "../settings-data";
import type { SpeechController } from "../voice/SpeechController";
import type { SubprocessManager } from "../claude/SubprocessManager";
import type { PermissionsConfigStore } from "../permissions/PermissionsConfig";
import type { DiscoveryResult } from "../claude/SkillDiscovery";
import type { SubagentCatalog } from "../claude/SubagentDiscovery";
import type { ParsedMcpServer } from "../mcp/McpServerList";

/* Mirror of SelectionTracker's ActiveSelection. Canonical shared shape —
   after migration, SelectionTracker and InputBox both reference this type
   (SelectionTracker may keep a re-export alias for compatibility). */
export type ActiveSelection = {
  filePath: string;
  text: string;
  /* 1-indexed for display in chips and prompts (Obsidian editors are
     0-indexed internally — the tracker converts). */
  startLine: number;
  endLine: number;
};

/* The member surface of ActiveFileIndicator that TabController uses. */
export interface ActiveFileIndicatorHandle {
  readonly root: HTMLElement;
  addPinnedPath(path: string): void;
  getPinnedPaths(): string[];
  getStickyPaths(): string[];
  setPinnedPaths(nextPinned: string[]): void;
  destroy(): void;
}

/* The member surface of SelectionTracker that TabController uses. */
export interface SelectionTrackerHandle {
  clear(): void;
  destroy(): void;
}

export interface PluginHost {
  settings: ClaudeChatSettings;
  speech: SpeechController;
  subprocessManager: SubprocessManager;
  permissionsStore: PermissionsConfigStore;
  skillCatalog: DiscoveryResult;
  subagentCatalog: SubagentCatalog;
  mcpDenyPatterns: string[];
  getVaultPath(): string;
  saveSettings(): Promise<void>;
  getMcpServers(force?: boolean): Promise<ParsedMcpServer[]>;
  refreshMcpDenyPatterns(): Promise<void>;
  refreshSkillCatalog(): void;
  refreshSubagentCatalog(): void;
  updateMcpToolCache(grouped: Record<string, string[]>): Promise<void>;
  pruneMcpToolCache(validSids: ReadonlySet<string>): Promise<void>;
  /* UI-component factories for the Obsidian-only widgets TabController
     mounts. Under Obsidian these return the real ActiveFileIndicator /
     SelectionTracker; a desktop shell substitutes its own (or inert stubs
     when the capability is absent). Signatures mirror the current
     constructors minus the `app` parameter. */
  createActiveFileIndicator(
    parent: HTMLElement,
    initialPinned: string[],
    initialSticky: string[],
    callbacks: { onPinChange: (pinnedPaths: string[], stickyPaths: string[]) => void },
  ): ActiveFileIndicatorHandle;
  createSelectionTracker(
    onChange: (sel: ActiveSelection | null) => void,
  ): SelectionTrackerHandle;
}
