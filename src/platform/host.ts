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
import type { SubprocessManagerLike, RemoteControlSessionLike } from "./engine";
import type { PermissionsConfigStore } from "../permissions/PermissionsConfig";
import type { DiscoveryResult } from "../claude/SkillDiscovery";
import type { SubagentCatalog } from "../claude/SubagentDiscovery";
import type { ParsedMcpServer } from "../mcp/McpServerList";
import type { StreamEvent } from "../claude/Events";
import type { DisplayState } from "../claude/StateEmitter";
import type { SubagentTrackerUpdate } from "../claude/SubagentSessionTracker";
import type { TitleGenOptions } from "../claude/TitleGenerator";
import type { ReplySuggestOptions } from "../claude/ReplySuggester";

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

/* ---------------------------------------------------------------------------
   Node-backed capabilities.

   Everything below is OPTIONAL. Shared code calls each through `?.` and has a
   defined no-op / neutral fallback, because the browser build (iOS client)
   has no node: the on-disk session transcript, the auto-title subprocess, the
   TC001 state file and the Remote Control PTY all live on the machine the
   gateway daemon runs on, not in the WKWebView. Under Obsidian and the
   Electron shell every one of these is supplied by the real implementation in
   ./node-capabilities.ts, so behavior there is unchanged.
   ------------------------------------------------------------------------ */

/* StateEmitter's write surface (the TC001 status display). */
export interface StateEmitterLike {
  setState(state: DisplayState): void;
}

/* The member surface of JsonlTailer that TabController uses. */
export interface JsonlTailerHandle {
  onEvent(cb: (e: StreamEvent) => void): void;
  onError(cb: (err: Error) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/* The member surface of SubagentSessionTracker that TabController uses. */
export interface SubagentTrackerHandle {
  start(): void;
  stop(): void;
}

/* SubagentSessionTrackerOpts minus `subprocessManager` — the host owns the
   engine handle and injects its own. */
export type SubagentTrackerRequest = {
  cwd: string;
  parentSessionId: string;
  parentToolUseId: string;
  parentPrompt: string;
  onUpdate: (update: SubagentTrackerUpdate) => void;
};

/* RemoteControlOptions minus the session-file claim adapter (the host wires
   that to its own manager). */
export type RemoteControlRequest = {
  cwd: string;
  sessionName?: string;
  claudePath?: string;
};

/* Outcome of writing a subagent definition file. The caller owns every
   user-facing message, so this only reports which case was hit. */
export type SubagentFileResult =
  | { ok: true }
  | { ok: false; kind: "no_vault" | "exists" | "write_failed"; message?: string };

export interface PluginHost {
  settings: ClaudeChatSettings;
  speech: SpeechController;
  subprocessManager: SubprocessManagerLike;
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

  /* --- optional node-backed capabilities (see the block above) --- */

  /* TC001 status display. Absent => the UI simply emits no display states. */
  stateEmitter?: StateEmitterLike;

  /* Incognito teardown: delete `<projectDir>/<id>.jsonl` and `<projectDir>/<id>/`
     for every id, best-effort and idempotent. Absent => nothing to delete
     (a remote engine cleans up its own disk). */
  removeSessionFiles?(cwd: string, sessionIds: string[]): Promise<void>;

  /* Remote Control mode: tails the session JSONL the interactive CLI writes.
     Absent => Remote Control surfaces no conversation events. */
  createJsonlTailer?(path: string): JsonlTailerHandle;

  /* Nested subagent (Task tool) transcript tracking. Absent => tool rows show
     no nested events, which is the same degradation as a match failure. */
  createSubagentTracker?(opts: SubagentTrackerRequest): SubagentTrackerHandle;

  /* One-shot `claude --print` auto-title pass. Absent => the tab keeps its
     placeholder title. */
  generateTitle?(opts: TitleGenOptions): Promise<string | null>;

  /* One-shot `claude --print` pass proposing the user's next message after a
     turn. Absent => the composer shows no reply suggestion. */
  suggestReply?(opts: ReplySuggestOptions): Promise<string | null>;

  /* `claude remote-control` in a PTY. Absent => the mode toggle has nothing
     to start. */
  createRemoteControlSession?(opts: RemoteControlRequest): RemoteControlSessionLike;

  /* Writes a subagent definition to the user-global or project agents dir.
     Absent => the create-subagent form cannot save. */
  createSubagentFile?(opts: { scope: "user" | "project"; name: string; contents: string }): SubagentFileResult;

  /* macOS `open <path>` / `open -R <path>`. Throws on failure so the caller
     can surface its own message. Absent => the open/reveal buttons no-op. */
  openPathExternally?(path: string, mode: "open" | "reveal"): void;
}
