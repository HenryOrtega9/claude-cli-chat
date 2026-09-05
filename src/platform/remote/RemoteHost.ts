/* RemoteHost — the `PluginHost` implementation for the gateway client.

   Third of three (ClaudeChatPlugin in src/main.ts, DesktopHost in
   app/src/host.ts, this). Same contract, wildly different machine: nothing
   here can scan a disk, spawn a process or write a file, because the process
   that can is the gateway daemon on the other end of the tailnet.

   Capability-by-capability, what the phone gets and why:

     subprocessManager  RemoteSubprocessManager (the whole point)
     permissionsStore   the shared store, pointed at RemoteFileStorage's
                        `.claude/settings.json` -> /permissions mapping
     skillCatalog       GET /catalog (the daemon runs SkillDiscovery for us)
     subagentCatalog    GET /catalog
     getMcpServers      GET /catalog's mcpServers, reshaped to ParsedMcpServer
     mcpDenyPatterns    derived from the same list; informational only here,
                        since the daemon builds the real `--settings` deny
                        rules itself at spawn time
     generateTitle      POST /tabs/:id/title (the daemon runs the Haiku pass)
     suggestReply       POST /tabs/:id/suggest (same, for composer ghost text)
     speech             AVSpeechSynthesizer through the native `speak` bridge
     stateEmitter       ABSENT — the daemon already mirrors TC001 state to
                        /tmp/claude_state.ios; a second writer from the phone
                        would fight it
     removeSessionFiles ABSENT — incognito teardown deletes files on the Mac,
                        which is the daemon's disk and its job
     createJsonlTailer  ABSENT — Remote Control is not offered here
     createSubagentTracker ABSENT — it tails a transcript on the Mac's disk;
                        nested subagent rows degrade to "no nested events",
                        the same degradation a match failure already produces
     createRemoteControlSession ABSENT — the PTY flow is macOS-only
     createSubagentFile ABSENT — writing to ~/.claude/agents needs the Mac
     openPathExternally ABSENT — `open(1)` would run on the wrong machine

   Settings are per-device and live in localStorage, not in the vault: the
   phone's default model, effort and voice preference have no business
   rewriting the Mac's `data.json`. */

import { DEFAULT_SETTINGS, clampTypewriterSpeed, type ClaudeChatSettings, type EffortLevel, type ModelKey, type PermissionMode } from "../../settings-data";
import { PermissionsConfigStore } from "../../permissions/PermissionsConfig";
import type { DiscoveredEntry, DiscoveryResult } from "../../claude/SkillDiscovery";
import type { SubagentCatalog, SubagentEntry } from "../../claude/SubagentDiscovery";
import type { ParsedMcpServer } from "../../mcp/McpServerList";
import type { SpeechController } from "../../voice/SpeechController";
import type { TitleGenOptions } from "../../claude/TitleGenerator";
import type { ReplySuggestOptions } from "../../claude/ReplySuggester";
import type {
  ActiveFileIndicatorHandle,
  ActiveSelection,
  PluginHost,
  SelectionTrackerHandle,
} from "../host";
import type { GatewayTransport } from "./transport";
import type { GatewayConnection } from "./GatewayConnection";
import { RemoteSubprocessManager } from "./RemoteSubprocessManager";
import type { RemoteFileStorage } from "./RemoteFileStorage";
import { RemoteSpeechController } from "./RemoteSpeech";

export type CatalogModel = { key: string; id: string; label: string; efforts: string[]; group: string };

export type Catalog = {
  skills: DiscoveredEntry[];
  commands: DiscoveredEntry[];
  subagents: SubagentEntry[];
  models: CatalogModel[];
  efforts: string[];
  permissionModes: Array<{ key: string; label: string }>;
  mcpServers: Array<{ name: string; enabled: boolean; status?: string }>;
  userName: string;
  hash: string;
};

const SETTINGS_KEY = "vaultgw.settings";

/* Fields the phone is allowed to own. Everything else in ClaudeChatSettings
   describes the Mac (claudePath, TC001, vault addendum) and is read from the
   defaults so a stale localStorage blob can never inject a path or a prompt. */
type DeviceSettings = Pick<
  ClaudeChatSettings,
  | "defaultModel"
  | "defaultEffort"
  | "permissionMode"
  | "autoGenerateTitles"
  | "voiceDefaultOn"
  | "voiceName"
  | "voiceRate"
  | "typewriterEnabled"
  | "typewriterSpeed"
  | "replySuggestions"
>;

class InertActiveFileIndicator implements ActiveFileIndicatorHandle {
  readonly root: HTMLElement;
  constructor() {
    this.root = document.createElement("div");
    this.root.className = "claudian-active-file-indicator claudesk-inert";
  }
  addPinnedPath(_path: string): void { /* no active note on a phone */ }
  getPinnedPaths(): string[] { return []; }
  getStickyPaths(): string[] { return []; }
  setPinnedPaths(_next: string[]): void { /* nothing to store */ }
  destroy(): void { this.root.remove(); }
}

class InertSelectionTracker implements SelectionTrackerHandle {
  clear(): void { /* no editor selection */ }
  destroy(): void { /* no listeners */ }
}

export class RemoteHost implements PluginHost {
  settings: ClaudeChatSettings;
  readonly subprocessManager: RemoteSubprocessManager;
  readonly speech: SpeechController;
  readonly permissionsStore = new PermissionsConfigStore(null);

  skillCatalog: DiscoveryResult = { skills: [], commands: [] };
  subagentCatalog: SubagentCatalog = { agents: [] };
  mcpDenyPatterns: string[] = [];

  /* The last /catalog payload. Everything catalog-derived is served from it so
     the refresh* methods can stay synchronous, exactly as PluginHost declares
     them (the node hosts scan disk synchronously; we cannot, so we cache). */
  /* Installed by the shell. TitleGenOptions carries no tab id — the signature
     was written for a local one-shot subprocess — and TabController fires
     title generation BEFORE it has even spawned a session, so nothing on the
     engine side can identify the caller yet. The shell can: it holds every
     live TabController and can match the message text back to a tab.

     Matches ANY user message in a tab, not just the first: suggestReply
     passes the LAST user message, and a first-only match would resolve
     nothing from the second turn on. */
  private tabResolver: ((userMessage: string) => string | null) | null = null;

  private catalog: Catalog | null = null;
  private catalogInflight: Promise<Catalog | null> | null = null;
  private vaultPath = "";

  constructor(
    private readonly conn: GatewayConnection,
    private readonly transport: GatewayTransport,
    readonly storage: RemoteFileStorage,
  ) {
    this.subprocessManager = new RemoteSubprocessManager(conn);
    this.settings = { ...DEFAULT_SETTINGS, ...this.loadDeviceSettings() };
    this.speech = new RemoteSpeechController(transport, () => this.settings) as unknown as SpeechController;
  }

  setTabResolver(resolve: (userMessage: string) => string | null): void {
    this.tabResolver = resolve;
  }

  /* ----- boot ------------------------------------------------------------- */

  /* Resolves the vault path and the first catalog. Called once from the
     renderer's boot sequence, before any tab mounts, mirroring the order
     DesktopHost's caller uses (deny patterns primed, then catalogs). */
  async prime(): Promise<void> {
    const health = await this.conn.rpc("GET", "/health");
    const cwd = (health.json as { cwd?: unknown } | undefined)?.cwd;
    if (typeof cwd === "string") this.vaultPath = cwd;
    await this.refreshCatalog(false);
  }

  async refreshCatalog(force: boolean): Promise<Catalog | null> {
    if (!force && this.catalogInflight) return this.catalogInflight;
    const job = (async () => {
      const res = await this.conn.rpc("GET", force ? "/catalog?refresh=1" : "/catalog");
      if (res.status !== 200 || !res.json || typeof res.json !== "object") return this.catalog;
      const catalog = res.json as Catalog;
      this.catalog = catalog;
      this.skillCatalog = {
        skills: Array.isArray(catalog.skills) ? catalog.skills : [],
        commands: Array.isArray(catalog.commands) ? catalog.commands : [],
      };
      this.subagentCatalog = { agents: Array.isArray(catalog.subagents) ? catalog.subagents : [] };
      this.mcpDenyPatterns = (catalog.mcpServers ?? [])
        .filter(s => s.enabled === false)
        .map(s => `mcp__${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`);
      if (catalog.userName && !this.settings.userName) this.settings.userName = catalog.userName;
      return catalog;
    })().finally(() => {
      if (this.catalogInflight === job) this.catalogInflight = null;
    });
    this.catalogInflight = job;
    return job;
  }

  get catalogSnapshot(): Catalog | null {
    return this.catalog;
  }

  /* ----- PluginHost ------------------------------------------------------- */

  getVaultPath(): string {
    return this.vaultPath;
  }

  async saveSettings(): Promise<void> {
    const device: DeviceSettings = {
      defaultModel: this.settings.defaultModel,
      defaultEffort: this.settings.defaultEffort,
      permissionMode: this.settings.permissionMode,
      autoGenerateTitles: this.settings.autoGenerateTitles,
      voiceDefaultOn: this.settings.voiceDefaultOn,
      voiceName: this.settings.voiceName,
      voiceRate: this.settings.voiceRate,
      typewriterEnabled: this.settings.typewriterEnabled,
      typewriterSpeed: this.settings.typewriterSpeed,
      replySuggestions: this.settings.replySuggestions,
    };
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(device));
    } catch {
      /* Private browsing / storage disabled: settings become session-scoped,
         which is a degradation, not a failure. */
    }
  }

  private loadDeviceSettings(): Partial<ClaudeChatSettings> {
    /* Phone tabs default to acceptEdits per CONTRACTS.md: every approval
       round trip on a 6-inch screen costs a push notification, and the
       genuinely risky tools still prompt. bypassPermissions is not a legal
       value anywhere in this client. */
    const base: Partial<ClaudeChatSettings> = { permissionMode: "acceptEdits" as PermissionMode };
    let raw: string | null = null;
    try { raw = window.localStorage.getItem(SETTINGS_KEY); } catch { raw = null; }
    if (!raw) return base;
    try {
      const parsed = JSON.parse(raw) as Partial<DeviceSettings>;
      const out: Partial<ClaudeChatSettings> = { ...base };
      if (typeof parsed.defaultModel === "string") out.defaultModel = parsed.defaultModel as ModelKey;
      if (typeof parsed.defaultEffort === "string") out.defaultEffort = parsed.defaultEffort as EffortLevel;
      if (typeof parsed.permissionMode === "string" && parsed.permissionMode !== "bypassPermissions") {
        out.permissionMode = parsed.permissionMode as PermissionMode;
      }
      if (typeof parsed.autoGenerateTitles === "boolean") out.autoGenerateTitles = parsed.autoGenerateTitles;
      if (typeof parsed.voiceDefaultOn === "boolean") out.voiceDefaultOn = parsed.voiceDefaultOn;
      if (typeof parsed.voiceName === "string") out.voiceName = parsed.voiceName;
      if (typeof parsed.voiceRate === "number") out.voiceRate = parsed.voiceRate;
      if (typeof parsed.typewriterEnabled === "boolean") out.typewriterEnabled = parsed.typewriterEnabled;
      /* Clamped on read as well as on write: the bounds can tighten between
         releases, and an out-of-range blob would otherwise drive the reveal
         at a speed the slider cannot represent. Keys the blob predates are
         simply absent — the constructor's DEFAULT_SETTINGS spread fills them. */
      if (typeof parsed.typewriterSpeed === "number") {
        out.typewriterSpeed = clampTypewriterSpeed(parsed.typewriterSpeed);
      }
      if (typeof parsed.replySuggestions === "boolean") out.replySuggestions = parsed.replySuggestions;
      return out;
    } catch {
      return base;
    }
  }

  async getMcpServers(force = false): Promise<ParsedMcpServer[]> {
    const catalog = force ? await this.refreshCatalog(true) : (this.catalog ?? await this.refreshCatalog(false));
    return (catalog?.mcpServers ?? []).map(s => ({
      name: s.name,
      endpoint: "",
      transport: "unknown" as const,
      /* The daemon forwards `claude mcp list`'s own status word; anything
         unexpected reads as unknown rather than being coerced to connected. */
      status: s.status === "connected" || s.status === "failed" || s.status === "pending"
        ? s.status
        : "unknown",
      statusText: s.status ?? "",
    }));
  }

  async refreshMcpDenyPatterns(): Promise<void> {
    await this.refreshCatalog(true);
  }

  /* Synchronous by contract (PluginHost declares it `void`, matching the node
     hosts' synchronous disk scan) — callers such as querySlashCommands' popup-
     open refresh and the `/agent` slash handler are fire-and-forget and read
     `this.catalog`/`this.skillCatalog`/`subagentCatalog` synchronously right
     after calling this, so nothing here ever awaits the round trip anyway.

     Deliberately non-forcing (`refreshCatalog(false)`): `force` bypasses BOTH
     the daemon's 5-minute /catalog cache AND catalogInflight's de-dup (see
     refreshCatalog above), so on this host specifically it meant every one of
     those fire-and-forget callers — most commonly just opening the slash
     popup — shelled out to `claude mcp list` on the Mac (server.ts documents
     that call alone as good for a >10s stall), and did it AGAIN, concurrently,
     on every reopen, for an interaction that discards the result anyway.
     `?refresh=1` stays reserved for the MCP manager's explicit refresh
     (getMcpServers(true) / refreshMcpDenyPatterns), which the user triggered
     on purpose and which awaits its result. */
  refreshSkillCatalog(): void {
    void this.refreshCatalog(false);
  }

  refreshSubagentCatalog(): void {
    void this.refreshCatalog(false);
  }

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

  createActiveFileIndicator(): ActiveFileIndicatorHandle {
    return new InertActiveFileIndicator();
  }

  createSelectionTracker(_onChange: (sel: ActiveSelection | null) => void): SelectionTrackerHandle {
    return new InertSelectionTracker();
  }

  /* The daemon owns title generation (POST /tabs/:id/title runs the same
     one-shot Haiku pass the desktop runs locally, against its own projection
     of the conversation).

     Two things make this more than a single call. First, the tab has to be
     identified — see tabResolver above. Second, TabController fires this the
     instant the user's bubble exists and BEFORE the turn is sent, so the
     daemon has not projected a user message yet and would answer 400
     no_messages; the route is polled until the turn has landed. Giving up
     quietly is correct: the tab keeps the first-message-prefix title the
     composer already set, which is exactly the desktop's degradation when
     generateTitle is absent. */
  async generateTitle(opts: TitleGenOptions): Promise<string | null> {
    const tabId = this.tabResolver?.(opts.userMessage) ?? null;
    if (!tabId) return null;
    const path = `/tabs/${encodeURIComponent(tabId)}`;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const tab = await this.conn.rpc("GET", path);
      if (tab.status === 404) return null;
      const messages = (tab.json as { messages?: unknown } | undefined)?.messages;
      if (Array.isArray(messages) && messages.some(m => (m as { role?: unknown })?.role === "user")) {
        const res = await this.conn.rpc("POST", `${path}/title`);
        if (res.status !== 200) return null;
        const title = (res.json as { title?: unknown } | undefined)?.title;
        return typeof title === "string" && title.trim() ? title.trim() : null;
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    return null;
  }

  /* Same shape as generateTitle: the daemon runs the Haiku pass against its
     own projection (POST /tabs/:id/suggest), and the tab is identified from
     the message text via tabResolver — here the LAST user message, which is
     why the resolver matches any user message rather than just the first.

     No polling loop, unlike title: TabController fires this only after the
     turn has landed, so the daemon has already projected both halves of the
     exchange. Any non-200 (400 no_messages on a race, 404 on a tab the
     daemon dropped) degrades to no ghost text, exactly as an absent
     capability does on the desktop. */
  async suggestReply(opts: ReplySuggestOptions): Promise<string | null> {
    const tabId = this.tabResolver?.(opts.userMessage) ?? null;
    if (!tabId) return null;
    const res = await this.conn.rpc("POST", `/tabs/${encodeURIComponent(tabId)}/suggest`);
    if (res.status !== 200) return null;
    const suggestion = (res.json as { suggestion?: unknown } | undefined)?.suggestion;
    return typeof suggestion === "string" && suggestion.trim() ? suggestion.trim() : null;
  }

  async dispose(): Promise<void> {
    this.speech.destroy();
    await this.subprocessManager.disposeAll();
  }
}
