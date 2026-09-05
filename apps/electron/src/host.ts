/* DesktopHost — the PluginHost implementation for the standalone shell.

   Mirror of the member wiring ClaudeChatPlugin holds in src/main.ts: the same
   singletons, constructed in the same order, with the same caching and
   coalescing semantics. Shared code (TabController and the shared modals) sees
   only the PluginHost surface, so anything that behaves differently here is a
   behavior difference in the chat itself — keep the two in sync.

   The stores that used to take an obsidian `App` now take an AppHandle they
   ignore (they reach platform.storage instead), so `null` is the honest
   argument to pass. */

import { SubprocessManager } from "../../../src/claude/SubprocessManager";
import { SpeechController } from "../../../src/voice/SpeechController";
import { PermissionsConfigStore } from "../../../src/permissions/PermissionsConfig";
import { Persistence } from "../../../src/storage/Persistence";
import { MCPConfigStore } from "../../../src/mcp/MCPConfig";
import { listMcpServersViaCli, type ParsedMcpServer } from "../../../src/mcp/McpServerList";
import { discoverSkillsAndCommands, type DiscoveryResult } from "../../../src/claude/SkillDiscovery";
import { discoverSubagents, type SubagentCatalog } from "../../../src/claude/SubagentDiscovery";
import { StateEmitter } from "../../../src/claude/StateEmitter";
import type { ClaudeChatSettings } from "../../../src/settings-data";
import { autodetectClaudePath } from "../../../src/settings-autodetect";
import type {
  ActiveFileIndicatorHandle,
  ActiveSelection,
  PluginHost,
  SelectionTrackerHandle,
} from "../../../src/platform/host";
import {
  createJsonlTailer as createJsonlTailerImpl,
  createRemoteControlSession as createRemoteControlSessionImpl,
  createSubagentTracker as createSubagentTrackerImpl,
  openPathExternally as openPathExternallyImpl,
  removeSessionFiles as removeSessionFilesImpl,
  writeSubagentFile as writeSubagentFileImpl,
} from "../../../src/platform/node-capabilities";
import { generateTitle as generateTitleImpl } from "../../../src/claude/TitleGenerator";
import { suggestReply as suggestReplyImpl } from "../../../src/claude/ReplySuggester";
import type {
  SubagentFileResult,
  SubagentTrackerHandle,
  SubagentTrackerRequest,
} from "../../../src/platform/host";
import { saveDesktopSettings } from "./config";

/* Inert ActiveFileIndicator. The real widget tracks Obsidian's active note and
   lets the user pin vault files into the turn; outside a vault there is no
   active note to track, so every accessor returns the empty answer and the
   root is a detached-then-mounted empty div (TabController passes it to
   InputBox.mountTopBar unconditionally). Pins still work through the input
   box's own @-mention path, which writes paths, not indicator state. */
class InertActiveFileIndicator implements ActiveFileIndicatorHandle {
  readonly root: HTMLElement;

  constructor() {
    this.root = document.createElement("div");
    this.root.addClass("claudian-active-file-indicator", "claudesk-inert");
  }

  addPinnedPath(_path: string): void { /* no vault index to pin against */ }
  getPinnedPaths(): string[] { return []; }
  getStickyPaths(): string[] { return []; }
  setPinnedPaths(_nextPinned: string[]): void { /* nothing to store */ }
  destroy(): void { this.root.remove(); }
}

/* Inert SelectionTracker. The real tracker mirrors the editor selection in the
   active Obsidian leaf; there is no editor here, so the onChange callback
   never fires and the chip never appears. */
class InertSelectionTracker implements SelectionTrackerHandle {
  clear(): void { /* nothing selected, ever */ }
  destroy(): void { /* no listeners registered */ }
}

export class DesktopHost implements PluginHost {
  settings: ClaudeChatSettings;
  subprocessManager = new SubprocessManager();
  speech: SpeechController;
  permissionsStore: PermissionsConfigStore;
  persistence: Persistence;
  /* Disk-scanned catalogs, populated at construction so the `/`-suggestion
     popup and the agents pill are non-empty before the first CLI spawn. */
  skillCatalog: DiscoveryResult = { skills: [], commands: [] };
  subagentCatalog: SubagentCatalog = { agents: [] };
  /* `mcp__<server>` deny rules for servers disabled for this working dir,
     cached in memory because the spawn path (ensureSession) reads them
     synchronously. Primed by refreshMcpDenyPatterns() before any tab mounts. */
  mcpDenyPatterns: string[] = [];

  /* Cached `claude mcp list` result — the authoritative set of servers the
     spawned chat loads. Populated lazily; the MCP manager forces a refresh on
     open. The in-flight promise coalesces concurrent non-forced callers onto a
     single child process. */
  private mcpServerListCache: ParsedMcpServer[] | null = null;
  private mcpServerListInflight: Promise<ParsedMcpServer[]> | null = null;

  /* Absolute working directory. Stands in for the vault root everywhere the
     shared code asks for one (spawn cwd, skill/subagent discovery roots,
     storage base). */
  private readonly baseDir: string;

  constructor(baseDir: string, settings: ClaudeChatSettings) {
    this.baseDir = baseDir;
    this.settings = settings;
    this.speech = new SpeechController(() => this.settings);
    this.permissionsStore = new PermissionsConfigStore(null);
    /* Namespaced store: the app owns .claude-cli-chat/desktop/ while the
       Obsidian plugin keeps .claude-cli-chat/ itself. Disjoint files are what
       let both UIs run at the same time. Must match shell.ts's
       DESKTOP_STORE_DIR (its window.lock lives in the same directory). */
    this.persistence = new Persistence(null, ".claude-cli-chat/desktop");
    /* Catalog discovery is NOT run here. main.ts orders it after the deny-
       pattern prime, and both are synchronous disk scans the boot sequence in
       renderer.ts owns; running them in the constructor would silently reorder
       the boot relative to the plugin's. */
  }

  getVaultPath(): string {
    return this.baseDir;
  }

  async saveSettings(): Promise<void> {
    await saveDesktopSettings(this.settings);
  }

  /* Recompute the cached deny patterns from the on-disk disable list. A
     transient read failure keeps the PREVIOUS patterns rather than clobbering
     to [] — the spawn path reads this cache synchronously and nothing else
     re-primes it, so a clobber would silently re-enable every disabled MCP
     server for the rest of the session. */
  async refreshMcpDenyPatterns(): Promise<void> {
    try {
      this.mcpDenyPatterns = await new MCPConfigStore(null).getDenyPatterns();
    } catch (err) {
      console.warn("[claude-quick-chat] MCP deny pattern refresh failed; keeping previous patterns:", err);
    }
  }

  /* Returns the cache unless `force`. A forced caller (the MCP manager
     opening, which wants a fresh list) must not be handed a stale in-flight
     non-forced result, so it starts its own fetch. Throws are left to the
     caller — UI surfaces treat a failure as "no list available". */
  async getMcpServers(force = false): Promise<ParsedMcpServer[]> {
    if (!force && this.mcpServerListCache) return this.mcpServerListCache;
    if (!force && this.mcpServerListInflight) return this.mcpServerListInflight;
    const claudePath = this.settings.claudePath || autodetectClaudePath() || "claude";
    const job = listMcpServersViaCli(claudePath)
      .then(list => { this.mcpServerListCache = list; return list; })
      .finally(() => { if (this.mcpServerListInflight === job) this.mcpServerListInflight = null; });
    this.mcpServerListInflight = job;
    return job;
  }

  refreshSkillCatalog(): void {
    try {
      this.skillCatalog = discoverSkillsAndCommands(this.getVaultPath());
    } catch (err) {
      console.warn("[claude-quick-chat] skill discovery failed:", err);
      this.skillCatalog = { skills: [], commands: [] };
    }
  }

  refreshSubagentCatalog(): void {
    try {
      this.subagentCatalog = discoverSubagents(this.getVaultPath());
    } catch (err) {
      console.warn("[claude-quick-chat] subagent discovery failed:", err);
      this.subagentCatalog = { agents: [] };
    }
  }

  /* Merge (never replace) a fresh init event's per-server tool lists into the
     persisted cache: an init only reports servers enabled for THAT tab, and
     replacing would drop entries for servers disabled there but enabled
     elsewhere. Saves only on an actual change to avoid disk churn per spawn. */
  async updateMcpToolCache(grouped: Record<string, string[]>): Promise<void> {
    let changed = false;
    for (const [server, tools] of Object.entries(grouped)) {
      const prev = this.settings.mcpToolCache[server];
      if (!prev || prev.length !== tools.length || prev.some((t, i) => t !== tools[i])) {
        this.settings.mcpToolCache[server] = tools;
        changed = true;
      }
    }
    if (changed) await this.saveSettings();
  }

  /* Drop cache entries absent from an AUTHORITATIVE, successful `claude mcp
     list`. Gated on positive confirmation the server is gone so a transient
     list failure (which callers treat as "no list yet" and fall back to this
     same cache for) can never be mistaken for removal. */
  async pruneMcpToolCache(validSids: ReadonlySet<string>): Promise<void> {
    let changed = false;
    for (const sid of Object.keys(this.settings.mcpToolCache)) {
      if (!validSids.has(sid)) {
        delete this.settings.mcpToolCache[sid];
        changed = true;
      }
    }
    if (changed) await this.saveSettings();
  }

  createActiveFileIndicator(
    _parent: HTMLElement,
    _initialPinned: string[],
    _initialSticky: string[],
    _callbacks: { onPinChange: (pinnedPaths: string[], stickyPaths: string[]) => void },
  ): ActiveFileIndicatorHandle {
    return new InertActiveFileIndicator();
  }

  createSelectionTracker(
    _onChange: (sel: ActiveSelection | null) => void,
  ): SelectionTrackerHandle {
    return new InertSelectionTracker();
  }

  /* PluginHost node-backed capabilities (src/platform/host.ts). Shared code
     reaches every one of these through `?.` so the same view layer can run in
     a browser; here they are the real thing, so behavior is unchanged.
     Implementations live in src/platform/node-capabilities.ts and are shared
     verbatim with the other host — keep the two wirings identical. */
  stateEmitter = StateEmitter;
  removeSessionFiles = removeSessionFilesImpl;
  createJsonlTailer = createJsonlTailerImpl;
  createRemoteControlSession = createRemoteControlSessionImpl;
  generateTitle = generateTitleImpl;
  suggestReply = suggestReplyImpl;
  openPathExternally = openPathExternallyImpl;

  createSubagentTracker(opts: SubagentTrackerRequest): SubagentTrackerHandle {
    return createSubagentTrackerImpl(this.subprocessManager, opts);
  }

  createSubagentFile(opts: { scope: "user" | "project"; name: string; contents: string }): SubagentFileResult {
    return writeSubagentFileImpl(this.getVaultPath(), opts);
  }

  /* Teardown mirroring ClaudeChatPlugin.onunload. Reached from the quit
     handshake (main holds the quit open while the renderer awaits this); the
     renderer also calls disposeSync() from beforeunload, where nothing async
     survives. */
  async dispose(): Promise<void> {
    this.speech.destroy();
    StateEmitter.dispose();
    this.persistence.flushSync();
    await this.persistence.flush();
    await this.subprocessManager.killAll();
    /* DELIBERATELY no killAllRemoteAndOrphans() here, unlike the plugin's
       onunload. This shell never starts Remote Control (toggleRemoteControl
       refers the user to the plugin), so it tracks zero remote sessions —
       every pid that sweep found would belong to the OBSIDIAN plugin's live
       session, and quitting the menu-bar app would kill it. */
  }

  /* The part of dispose() that can actually complete inside a beforeunload
     handler: no awaits, no promises. Everything else is best-effort and may be
     cut off when the renderer goes away. */
  disposeSync(): void {
    try { this.speech.destroy(); } catch { /* best-effort */ }
    try { StateEmitter.dispose(); } catch { /* best-effort */ }
    try { this.persistence.flushSync(); } catch { /* best-effort */ }
    void this.subprocessManager.killAll().catch(() => { /* process is going away */ });
  }
}
