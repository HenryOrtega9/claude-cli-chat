import { FileSystemAdapter, Plugin, WorkspaceLeaf, addIcon, getFrontMatterInfo, type Editor } from "obsidian";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { ClaudeChatView, VIEW_TYPE_CLAUDE_CHAT } from "./view/ClaudeChatView";
import { ClaudeChatSettingTab, DEFAULT_SETTINGS, MODEL_IDS, EFFORT_ORDER, PERMISSION_MODE_ORDER, autodetectClaudePath, autodetectUserName, type ClaudeChatSettings } from "./settings";
import { SubprocessManager, spawnOptionsFromSettings } from "./claude/SubprocessManager";
import { MCPConfigStore } from "./mcp/MCPConfig";
import { listMcpServersViaCli, type ParsedMcpServer } from "./mcp/McpServerList";
import type { AssistantEvent, ResultEvent, StreamEvent } from "./claude/Events";
import { Persistence, setSyncFileWriter } from "./storage/Persistence";
import { CLAUDE_ASTERISK_ICON_SVG } from "./view/Welcome";
import { discoverSkillsAndCommands, type DiscoveryResult } from "./claude/SkillDiscovery";
import { discoverSubagents, type SubagentCatalog } from "./claude/SubagentDiscovery";
import { StateEmitter } from "./claude/StateEmitter";
import { PermissionsConfigStore } from "./permissions/PermissionsConfig";
import { SpeechController } from "./voice/SpeechController";
import { initializePlatform } from "./platform";
import { ObsidianPlatform } from "./platform/obsidian";
import type { ActiveFileIndicatorHandle, ActiveSelection, SelectionTrackerHandle } from "./platform/host";
import {
  createJsonlTailer as createJsonlTailerImpl,
  createRemoteControlSession as createRemoteControlSessionImpl,
  createSubagentTracker as createSubagentTrackerImpl,
  openPathExternally as openPathExternallyImpl,
  removeSessionFiles as removeSessionFilesImpl,
  writeSubagentFile as writeSubagentFileImpl,
} from "./platform/node-capabilities";
import { generateTitle as generateTitleImpl } from "./claude/TitleGenerator";
import { suggestReply as suggestReplyImpl } from "./claude/ReplySuggester";
import type {
  SubagentFileResult,
  SubagentTrackerHandle,
  SubagentTrackerRequest,
} from "./platform/host";
import { ActiveFileIndicator } from "./view/ActiveFileIndicator";
import { SelectionTracker } from "./view/SelectionTracker";

/* Icon id we register with Obsidian's icon registry. Used by the ribbon
   button, the view's tab/breadcrumb icon, and any setIcon() call that wants
   the Claude asterisk. */
export const CLAUDE_ICON_ID = "claude-asterisk";

/* The three sync calls Persistence.flushSync() needs, handed over at boot. */
const nodeFs = { mkdirSync, renameSync, writeFileSync };

export default class ClaudeChatPlugin extends Plugin {
  settings: ClaudeChatSettings = DEFAULT_SETTINGS;
  subprocessManager = new SubprocessManager();
  persistence!: Persistence;
  /* Disk-scanned skill + slash-command catalog. Populated on load so the
     `/`-suggestion popup is non-empty before the first message ever fires
     the CLI's system/init event. Re-runnable via refreshSkillCatalog() so
     freshly added skills can be picked up without a plugin reload. */
  skillCatalog: DiscoveryResult = { skills: [], commands: [] };
  /* Disk-scanned subagent definitions from ~/.claude/agents and
     <vault>/.claude/agents (plus any plugin-bundled agents/ dirs). Populated
     on load so the `/agent` slash-command and the agents pill can list the
     full catalog before the first CLI subprocess spawn. */
  subagentCatalog: SubagentCatalog = { agents: [] };
  /* Shared allowlist writer for <vault>/.claude/settings.json. Used by the
     settings tab and by the per-tab attach popup's trusted-folder toggle.
     Holding a single store ensures the serialized write chain is shared so
     concurrent toggles from different UI surfaces don't race. */
  permissionsStore!: PermissionsConfigStore;

  /* `mcp__<server>` deny rules for servers the user disabled for this vault,
     cached in memory so the synchronous spawn path (ensureSession) can read
     them without an await. Refreshed on load and whenever a toggle lands.
     The CLI applies them via `--settings`, scoped to our subprocesses only. */
  mcpDenyPatterns: string[] = [];

  /* Voice output singleton. One speechSynthesis queue exists per renderer,
     so one controller serves every tab and the read-note-aloud commands.
     Constructed with a settings getter so voice/rate changes apply to the
     next utterance without re-wiring. */
  speech!: SpeechController;

  /* Cached result of `claude mcp list` — the authoritative set of servers the
     spawned chat actually loads (our vault .claude/mcp.json is not a CLI
     source). Populated lazily; the MCP manager modal forces a refresh on
     open. An in-flight promise coalesces concurrent callers (e.g. several
     cost-surface refreshes) onto a single child process. */
  private mcpServerListCache: ParsedMcpServer[] | null = null;
  private mcpServerListInflight: Promise<ParsedMcpServer[]> | null = null;

  async onload() {
    /* Install the platform abstraction FIRST — before settings, stores,
       views, or any engine code constructs. Shared modules reach Obsidian
       exclusively through this singleton (src/platform/), so it must be
       live before anything that might call platform.* runs. The standalone
       shell will make the equivalent call with its own Platform. */
    initializePlatform(new ObsidianPlatform(this.app));
    await this.loadSettings();
    this.speech = new SpeechController(() => this.settings);
    this.permissionsStore = new PermissionsConfigStore(this.app);
    /* Prime the deny cache before any tab can spawn so disabled servers are
       hidden from the very first turn. Best-effort: a read failure just
       leaves every server enabled. */
    await this.refreshMcpDenyPatterns();
    /* Persistence's quit-time flushSync() needs a synchronous file API; it no
       longer imports node itself so the shared bundle stays browser-safe. */
    setSyncFileWriter(nodeFs);
    this.persistence = new Persistence(this.app);
    this.refreshSkillCatalog();
    this.refreshSubagentCatalog();

    /* Register the Claude asterisk icon BEFORE any UI that references it.
       Obsidian's addIcon takes inner SVG content; the asterisk is pre-scaled
       in CLAUDE_ASTERISK_ICON_SVG to fit the default 0-100 viewBox. */
    addIcon(CLAUDE_ICON_ID, CLAUDE_ASTERISK_ICON_SVG);

    this.registerView(VIEW_TYPE_CLAUDE_CHAT, (leaf: WorkspaceLeaf) => new ClaudeChatView(leaf, this));

    this.addRibbonIcon(CLAUDE_ICON_ID, "Open Claude", () => this.activateView());

    this.addCommand({
      id: "open-claude-chat",
      name: "Open Claude",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "new-claude-tab",
      name: "New Claude tab",
      callback: () => {
        const view = this.getActiveView();
        if (view) view.newTab();
        else this.activateView();
      },
    });

    this.addCommand({
      id: "close-claude-tab",
      name: "Close active Claude tab",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        if (!checking) view.closeActiveTab();
        return true;
      },
    });

    this.addCommand({
      id: "next-claude-tab",
      name: "Next Claude tab",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        if (!checking) view.nextTab();
        return true;
      },
    });

    this.addCommand({
      id: "prev-claude-tab",
      name: "Previous Claude tab",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        if (!checking) view.prevTab();
        return true;
      },
    });

    this.addCommand({
      id: "read-note-aloud",
      name: "Read note aloud (selection or whole note)",
      editorCallback: (editor) => this.readEditorAloud(editor),
    });

    this.addCommand({
      id: "stop-speaking",
      name: "Stop speaking",
      callback: () => this.speech.stop(),
    });

    /* Right-click a note body → "Read aloud from here"-style entry point.
       Mirrors the command's selection-or-whole-note behavior. */
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        menu.addItem(item => {
          const hasSelection = editor.getSelection().trim().length > 0;
          item
            .setTitle(hasSelection ? "Read selection aloud" : "Read note aloud")
            .setIcon("volume-2")
            .onClick(() => this.readEditorAloud(editor));
        });
      })
    );

    this.addSettingTab(new ClaudeChatSettingTab(this.app, this));

    /* TC001 status display: configure from persisted settings and emit
       idle once at load. No network calls happen unless the user has
       toggled the integration on. */
    StateEmitter.configure(this.settings.tc001Enabled, this.settings.tc001Ip);
    if (this.settings.tc001Enabled) StateEmitter.setState("idle");
  }

  /* Speak the editor's selection, or the whole note when nothing is
     selected. Whole-note reads skip YAML frontmatter — property names and
     tags are metadata, not prose. Selections read exactly as selected. */
  private readEditorAloud(editor: Editor): void {
    const selection = editor.getSelection();
    let text = selection.trim().length > 0 ? selection : editor.getValue();
    if (selection.trim().length === 0) {
      /* Obsidian's own frontmatter parser, not a bare /^---…---/ regex —
         the regex ate the opening body of notes that start with a
         horizontal rule ("---\nIntro\n---\nRest" lost "Intro"). */
      const fm = getFrontMatterInfo(text);
      if (fm.exists) text = text.slice(fm.contentStart);
    }
    if (text.trim().length === 0) return;
    this.speech.stop();
    this.speech.speakDocument(text);
  }

  async onunload() {
    this.speech?.destroy();
    StateEmitter.dispose();
    /* Obsidian ignores the promise onunload returns, so on app quit the
       awaits below may never resume. Persist the debounced tail
       synchronously first — Cmd+Q within the 500ms debounce window would
       otherwise drop the last edits — then run the async flush, which still
       completes on the plugin disable/reload path where the process
       lives on. */
    this.persistence?.flushSync();
    await this.persistence?.flush();
    await this.subprocessManager.killAll();
    /* killAll's RC dispose gives the PTY proxy only ~1.5s between SIGTERM
       and SIGKILL. The proxy forwards the SIGTERM to the inner
       `claude remote-control` immediately, but if that process needs longer
       than the window for network teardown, the proxy dies first and the
       survivor is reparented to launchd. Run the same orphan sweep the
       settings panel uses so plugin disable/reload never leaks one. */
    try { await this.subprocessManager.killAllRemoteAndOrphans(); } catch { /* best-effort */ }
  }

  getVaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    return "";
  }

  /* PluginHost factories (src/platform/host.ts). ActiveFileIndicator and
     SelectionTracker are Obsidian-only widgets that need the live App;
     routing their construction through the plugin lets shared code
     (TabController) mount them without importing their modules. The real
     classes satisfy the narrow handle interfaces structurally. */
  createActiveFileIndicator(
    parent: HTMLElement,
    initialPinned: string[],
    initialSticky: string[],
    callbacks: { onPinChange: (pinnedPaths: string[], stickyPaths: string[]) => void },
  ): ActiveFileIndicatorHandle {
    return new ActiveFileIndicator(parent, this.app, initialPinned, initialSticky, callbacks);
  }

  createSelectionTracker(
    onChange: (sel: ActiveSelection | null) => void,
  ): SelectionTrackerHandle {
    return new SelectionTracker(this.app, onChange);
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

  /* Recompute the cached per-vault MCP deny patterns from the on-disk
     disable list. Call after any toggle so the next spawn picks up the
     change; the user still needs to restart the chat (/clear) for a live
     subprocess to reload. */
  async refreshMcpDenyPatterns(): Promise<void> {
    try {
      this.mcpDenyPatterns = await new MCPConfigStore(this.app).getDenyPatterns();
    } catch (err) {
      /* Keep the prior patterns rather than clobbering to []. A transient read
         failure here would otherwise silently re-enable every disabled MCP
         server for the rest of the session, since the spawn path reads this
         cache synchronously and nothing else re-primes it. */
      console.warn("[claude-cli-chat] MCP deny pattern refresh failed; keeping previous patterns:", err);
    }
  }

  /* Authoritative list of MCP servers the CLI loads, via `claude mcp list`.
     Returns the cache unless `force` is set; coalesces concurrent fetches.
     Throws are left to the caller — UI surfaces treat a failure as "no list
     available" and fall back to runtime data. */
  async getMcpServers(force = false): Promise<ParsedMcpServer[]> {
    if (!force && this.mcpServerListCache) return this.mcpServerListCache;
    /* Only coalesce onto an in-flight fetch when NOT forced. A force=true caller
       (the MCP manager opening, which wants a fresh list) must not be handed a
       stale in-flight non-forced result, so it starts its own fetch. */
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
      /* eslint-disable no-console */
      console.warn("[claude-cli-chat] skill discovery failed:", err);
      this.skillCatalog = { skills: [], commands: [] };
    }
  }

  refreshSubagentCatalog(): void {
    try {
      this.subagentCatalog = discoverSubagents(this.getVaultPath());
    } catch (err) {
      /* eslint-disable no-console */
      console.warn("[claude-cli-chat] subagent discovery failed:", err);
      this.subagentCatalog = { agents: [] };
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    /* Clamp enum-typed fields to the current vocabulary. Object.assign only
       backfills MISSING keys, so a persisted value whose id was later removed
       (e.g. a retired model key after a version migration) survives intact and
       then resolves to undefined at spawn / shows no selection in the dropdown.
       Snap any stale value back to its default. */
    if (!(this.settings.defaultModel in MODEL_IDS)) this.settings.defaultModel = DEFAULT_SETTINGS.defaultModel;
    /* Re-wrap the tool cache in a fresh object: on a first run Object.assign
       hands us the DEFAULT_SETTINGS.mcpToolCache reference itself, and
       updateMcpToolCache mutates in place — without the copy we'd be
       writing into the shared default. */
    this.settings.mcpToolCache = { ...(this.settings.mcpToolCache ?? {}) };
    /* Same class of risk as mcpToolCache above: Object.assign copies
       whatever's in data.json regardless of value, so a hand-edited or
       corrupted file with e.g. "envSnippets": null overwrites the default
       [] with null. Every consumer (the snippet picker, ensureSession's
       lookup by id) calls array methods on this with no independent guard,
       so an un-normalized null would throw a TypeError deep in an unrelated
       code path instead of just degrading to "no snippets". */
    /* Always re-wrap into a fresh array, same as mcpToolCache above (and
       for the same reason): on a totally fresh install, Object.assign
       backfills DEFAULT_SETTINGS.envSnippets by REFERENCE (loadData() has
       no key to override it with), and the settings UI mutates this array
       in place (push/splice when adding or removing a snippet) — without
       this copy, the very first push would corrupt the shared default for
       the rest of this plugin's process lifetime. Validate the type first
       since a corrupted/hand-edited data.json (e.g. "envSnippets": null)
       would otherwise survive Object.assign intact and throw a TypeError
       in the snippet picker or ensureSession's lookup by id. */
    this.settings.envSnippets = Array.isArray(this.settings.envSnippets) ? [...this.settings.envSnippets] : [];
    if (!EFFORT_ORDER.includes(this.settings.defaultEffort)) this.settings.defaultEffort = DEFAULT_SETTINGS.defaultEffort;
    if (!PERMISSION_MODE_ORDER.includes(this.settings.permissionMode)) this.settings.permissionMode = DEFAULT_SETTINGS.permissionMode;
    /* Voice migration: the first voice-mode build stored speechSynthesis
       voiceURIs ("com.apple.voice.…"); playback now runs through `say`,
       which takes plain voice names ("Ava (Premium)"). A leftover URI would
       make every `say` spawn exit(1) — silent, total speech failure — so
       reset it to the system default. */
    if (/^com\.apple\./.test(this.settings.voiceName)) {
      this.settings.voiceName = "";
      /* Persist so the stale URI doesn't sit in data.json depending on
         this line re-running every load. */
      await this.saveSettings();
    }
    /* First-install user name autodetect. Empty userName means we've never
       populated it; try the OS account once and save. Validate the result
       — if dscl misbehaves and leaks an error string into stdout, the
       truthy check would otherwise save the garbage forever. Whitelist:
       starts with a letter, allows letters / spaces / common punctuation,
       caps at 50 chars, must contain a letter. Falls through to USER env. */
    if (!this.settings.userName) {
      const detected = autodetectUserName();
      const looksLikeName = /^[A-Za-z][A-Za-z .'-]{0,49}$/.test(detected) && /[A-Za-z]/.test(detected);
      if (detected && looksLikeName) {
        this.settings.userName = detected;
        await this.saveSettings();
      } else {
        /* Fall through to capitalized $USER as a safer secondary source. */
        const u = process.env.USER ?? "";
        const fallback = u ? u.charAt(0).toUpperCase() + u.slice(1) : "";
        if (fallback && /^[A-Za-z][A-Za-z .'-]{0,49}$/.test(fallback)) {
          this.settings.userName = fallback;
          await this.saveSettings();
        }
      }
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* Merge a fresh init event's per-server tool lists into the persisted
     cache so the cost-surface pill can show real tool counts before the
     first message of a session. Merge (not replace): an init only reports
     servers enabled for THAT tab, and replacing would drop cached entries
     for servers the user disabled there but still has enabled elsewhere.
     Saves only when something actually changed to avoid disk churn on
     every spawn. */
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

  /* Drop cache entries for servers absent from an AUTHORITATIVE, successful
     `claude mcp list` result (sanitized ids). Deliberately NOT run from
     updateMcpToolCache's merge above — that merge is intentionally
     non-destructive so a server disabled in one tab doesn't lose its
     cached tools that another tab still relies on. Pruning only belongs
     here, gated on positive confirmation the server is truly gone, so a
     transient `getMcpServers()` failure (which the caller already treats
     as "no list yet" and falls back to this same cache for) can never be
     mistaken for removal and wipe an entry that's still valid. Otherwise a
     server removed entirely (e.g. `claude mcp remove`, outside the plugin)
     leaves a stale entry that can resurface as enabled with its old tool
     list the next time a transient list failure hits the fallback path. */
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

  /* Programmatic one-shot prompt for other plugins (e.g. obsidian-docx-claude).
     Spawns a transient TabSession with systemPrompt appended via
     --append-system-prompt, sends userPrompt once, accumulates assistant text
     from `assistant` events, resolves on the `result` event, and disposes the
     session in finally. */
  async runHeadlessPrompt(
    systemPrompt: string,
    userPrompt: string,
    opts?: { timeoutMs?: number; cwd?: string },
  ): Promise<string> {
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const tabId = `headless-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cwd = opts?.cwd ?? this.getVaultPath() ?? process.cwd();
    const spawnOpts = spawnOptionsFromSettings(this.settings, cwd, undefined, {
      appendSystemPrompt: systemPrompt,
      mcpDenyPatterns: this.mcpDenyPatterns,
      /* Headless has no approval UI and wires no control_request handler. If
         we inherited the user's default permission mode, any tool the model
         attempts would emit a control_request that never gets answered,
         stalling the subprocess until the timeout. Run non-interactive so
         tool use proceeds without an approval round-trip. */
      permissionMode: "bypassPermissions",
    });
    const session = this.subprocessManager.spawn(tabId, spawnOpts);

    let resolved = false;
    let assistantText = "";

    return new Promise<string>((resolve, reject) => {
      const finish = (value: string | null, err?: Error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        session.dispose().finally(() => {
          if (err) reject(err);
          else resolve(value ?? "");
        });
      };

      const timer = setTimeout(() => {
        finish(null, new Error(`runHeadlessPrompt timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      session.onEvent((e: StreamEvent) => {
        /* `e` is unvalidated CLI wire data (JSON.parse-d, not schema-checked),
           so any field access below can throw on a malformed/future shape.
           Route any throw to finish() instead of letting it escape this
           listener — otherwise the timer never clears and the promise hangs
           until the timeout, masking the real parse failure. */
        try {
          if (e.type === "assistant") {
            const ae = e as AssistantEvent;
            const blocks = Array.isArray(ae.message?.content) ? ae.message.content : [];
            for (const block of blocks) {
              if (block.type === "text") assistantText += block.text;
            }
          } else if (e.type === "result") {
            const re = e as ResultEvent;
            if (re.is_error) {
              finish(null, new Error(`Claude returned error: ${re.subtype}`));
              return;
            }
            if (typeof re.result === "string" && re.result.length > 0) {
              finish(re.result);
            } else if (re.result && typeof re.result === "object") {
              const blocks = Array.isArray(re.result.content) ? re.result.content : [];
              const textBlocks = blocks
                .filter((b): b is { type: "text"; text: string } => b.type === "text")
                .map((b) => b.text)
                .join("");
              finish(textBlocks || assistantText);
            } else {
              finish(assistantText);
            }
          }
        } catch (err) {
          finish(null, err instanceof Error ? err : new Error(String(err)));
        }
      });
      session.onError((err) => finish(null, err));
      session.onExit((code) => {
        if (!resolved) finish(null, new Error(`Claude subprocess exited (code=${code}) before result`));
      });

      try {
        session.sendUserText(userPrompt);
      } catch (err) {
        finish(null, err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_CHAT);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_CLAUDE_CHAT, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private getActiveView(): ClaudeChatView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_CHAT);
    if (leaves.length === 0) return null;
    const view = leaves[0].view;
    return view instanceof ClaudeChatView ? view : null;
  }
}
