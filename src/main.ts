import { FileSystemAdapter, Plugin, WorkspaceLeaf, addIcon } from "obsidian";
import { ClaudeChatView, VIEW_TYPE_CLAUDE_CHAT } from "./view/ClaudeChatView";
import { ClaudeChatSettingTab, DEFAULT_SETTINGS, MODEL_IDS, EFFORT_ORDER, PERMISSION_MODE_ORDER, autodetectClaudePath, autodetectUserName, type ClaudeChatSettings } from "./settings";
import { SubprocessManager, spawnOptionsFromSettings } from "./claude/SubprocessManager";
import { MCPConfigStore } from "./mcp/MCPConfig";
import { listMcpServersViaCli, type ParsedMcpServer } from "./mcp/McpServerList";
import type { AssistantEvent, ResultEvent, StreamEvent } from "./claude/Events";
import { Persistence } from "./storage/Persistence";
import { CLAUDE_ASTERISK_ICON_SVG } from "./view/Welcome";
import { discoverSkillsAndCommands, type DiscoveryResult } from "./claude/SkillDiscovery";
import { discoverSubagents, type SubagentCatalog } from "./claude/SubagentDiscovery";
import { StateEmitter } from "./claude/StateEmitter";
import { PermissionsConfigStore } from "./permissions/PermissionsConfig";

/* Icon id we register with Obsidian's icon registry. Used by the ribbon
   button, the view's tab/breadcrumb icon, and any setIcon() call that wants
   the Claude asterisk. */
export const CLAUDE_ICON_ID = "claude-asterisk";

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

  /* Cached result of `claude mcp list` — the authoritative set of servers the
     spawned chat actually loads (our vault .claude/mcp.json is not a CLI
     source). Populated lazily; the MCP manager modal forces a refresh on
     open. An in-flight promise coalesces concurrent callers (e.g. several
     cost-surface refreshes) onto a single child process. */
  private mcpServerListCache: ParsedMcpServer[] | null = null;
  private mcpServerListInflight: Promise<ParsedMcpServer[]> | null = null;

  async onload() {
    await this.loadSettings();
    this.permissionsStore = new PermissionsConfigStore(this.app);
    /* Prime the deny cache before any tab can spawn so disabled servers are
       hidden from the very first turn. Best-effort: a read failure just
       leaves every server enabled. */
    await this.refreshMcpDenyPatterns();
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

    this.addSettingTab(new ClaudeChatSettingTab(this.app, this));

    /* TC001 status display: configure from persisted settings and emit
       idle once at load. No network calls happen unless the user has
       toggled the integration on. */
    StateEmitter.configure(this.settings.tc001Enabled, this.settings.tc001Ip);
    if (this.settings.tc001Enabled) StateEmitter.setState("idle");
  }

  async onunload() {
    StateEmitter.dispose();
    await this.persistence?.flush();
    await this.subprocessManager.killAll();
  }

  getVaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    return "";
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
    if (!EFFORT_ORDER.includes(this.settings.defaultEffort)) this.settings.defaultEffort = DEFAULT_SETTINGS.defaultEffort;
    if (!PERMISSION_MODE_ORDER.includes(this.settings.permissionMode)) this.settings.permissionMode = DEFAULT_SETTINGS.permissionMode;
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
