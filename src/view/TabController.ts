import { Notice, TFile, TFolder, type App, type Component } from "obsidian";
import { MessageListRenderer } from "./MessageRenderer";
import { ApprovalArea, type ApprovalDecision } from "./ApprovalModal";
import { InputBox, type SubmitPayload, type Suggestion } from "./InputBox";
import { renderWelcome, setWelcomeVisible } from "./Welcome";
import { RemotePairingCard } from "./RemotePairingCard";
import { StatusIndicator } from "./StatusIndicator";
import { SearchBar } from "./SearchBar";
import { ActiveFileIndicator } from "./ActiveFileIndicator";
import { SelectionTracker, type ActiveSelection } from "./SelectionTracker";
import { makeMessageId, makeTabState, NESTED_EVENTS_CAP, type ChatMessage, type TabState, type PendingApproval, type ToolCall, type NestedSubagentEvent } from "./state";
import { spawnOptionsFromSettings, type TabSession } from "../claude/SubprocessManager";
import { resolveModelId, type ModelKey, type EffortLevel, type PermissionMode, type EnvSnippet } from "../settings";
import { RemoteControlSession, sessionFilePathFor } from "../claude/RemoteControlSession";
import { JsonlTailer } from "../claude/JsonlTailer";
import { SubagentSessionTracker, type SubagentTrackerUpdate } from "../claude/SubagentSessionTracker";
import { generateTitle } from "../claude/TitleGenerator";
import { MCPConfigStore } from "../mcp/MCPConfig";
import { SubagentPicker } from "./SubagentPicker";
import { CreateSubagentModal } from "./CreateSubagentModal";
import type { SubagentEntry } from "../claude/SubagentDiscovery";
import { StateEmitter } from "../claude/StateEmitter";
import { extractOfficeText, isExtractableOffice } from "../util/officeExtract";
import type ClaudeChatPlugin from "../main";
import type {
  StreamEvent,
  ContentBlock,
  AssistantContentBlock,
  SystemInitEvent,
  SystemApiRetryEvent,
  StreamEventEvent,
  AssistantEvent,
  ToolUseEvent,
  ToolResultEvent,
  ToolUseBlock,
  ThinkingBlock,
  ControlRequestEvent,
  ResultEvent,
  ErrorEvent,
  ImageBlock,
  DocumentBlock,
  UsageEvent,
  UsageSnapshot,
} from "../claude/Events";

export type TabMode = "local" | "remote";

/* TabController owns the DOM and state for a single chat tab. It binds together
   the message renderer, approval area, input box, and the subprocess session,
   translating stream-json events into UI updates. */
export class TabController {
  readonly state: TabState;
  readonly root: HTMLElement;
  mode: TabMode = "local";

  private plugin: ClaudeChatPlugin;
  private app: App;
  private component: Component;
  private session: TabSession | null = null;
  private remoteSession: RemoteControlSession | null = null;
  /* Set true at the start of cancelStream() so the SIGTERM-driven exit event
     gets handled as a clean cancel (italic prompt) instead of an error. */
  private userCancelInitiated = false;
  private jsonlTailer: JsonlTailer | null = null;
  private pairingCard: RemotePairingCard;

  private messagesWrapperEl: HTMLElement;
  private welcomeEl: HTMLElement | null = null;
  private messagesEl: HTMLElement;
  private titleBarEl: HTMLElement;
  private titleTextEl: HTMLElement;
  private renderer: MessageListRenderer;
  private approvalArea: ApprovalArea;
  private inputBox: InputBox;
  private statusIndicator: StatusIndicator;
  private searchBar: SearchBar;
  private activeFileIndicator: ActiveFileIndicator;
  private selectionTracker: SelectionTracker;
  private onStateChangeCb: () => void;

  /* Maps tool_use_id to the ChatMessage holding that tool call, so tool_result
     events can find their parent bubble. */
  private toolToMessage = new Map<string, string>();

  /* One SubagentSessionTracker per active Task tool call. Created when the
     tool's input finalizes (content_block_stop or assistant event) and
     disposed when the matching tool_result arrives or the session is torn
     down. The map's keys are tool_use_ids. */
  private subagentTrackers = new Map<string, SubagentSessionTracker>();
  /* Spawn timestamps per Task tool call, used to compute nestedDurationMs
     when the tool_result arrives. */
  private subagentSpawnTimes = new Map<string, number>();

  /* Optional fork handler — provided by ClaudeChatView so the controller can
     ask the view to create a new tab branching from a given message id. */
  onForkRequest?: (sourceTab: TabController, messageId: string) => void;

  /* Set to true while teardownSession() is executing so re-entrant callers
     (e.g. an onExit firing mid-dispose) don't double-dispose. */
  private tearingDown = false;

  /* Tracks whether handleError has already pushed an error bubble for the
     current pass. onError and onExit can both fire for the same failure
     (spawn-error path → onError, then exit code 1 → onExit). Reset in
     teardownSession() and at the top of submit(). */
  private errorBubbleEmitted = false;

  /* Resolves when the initial replayMessages() pass finishes. submit() awaits
     this before mutating state to avoid racing the renderer's catch-up. */
  private replayDone: Promise<void>;

  constructor(
    plugin: ClaudeChatPlugin,
    parent: HTMLElement,
    component: Component,
    state: TabState | null,
    onStateChange: () => void
  ) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.component = component;
    this.state = state ?? makeTabState();
    this.onStateChangeCb = onStateChange;

    this.root = parent.createDiv({ cls: "claudian-tab-content" });

    /* Title bar sits at the top of the per-tab content. Auto-populated from
       generateTitle after the first turn; click to edit inline. */
    this.titleBarEl = this.root.createDiv({ cls: "claudian-title-bar" });
    this.titleTextEl = this.titleBarEl.createDiv({ cls: "claudian-title-text", attr: { tabindex: "0" } });
    this.titleTextEl.addEventListener("click", () => this.beginTitleEdit());
    this.titleTextEl.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.beginTitleEdit();
      }
    });
    this.refreshTitleBar();

    this.messagesWrapperEl = this.root.createDiv({ cls: "claudian-messages-wrapper" });
    this.messagesEl = this.messagesWrapperEl.createDiv({ cls: "claudian-messages" });
    /* SearchBar appended after messagesEl so its DOM order doesn't push the
       bottom sentinel — but its search target is the messages container so
       it never tries to match against its own input. */
    this.searchBar = new SearchBar(this.messagesWrapperEl, this.messagesEl);
    /* Welcome lives on the stable tab-content (this.root), not the messages
       wrapper. The wrapper shrinks when the input grows (e.g. when a pinned-
       file pill row appears), which used to slide the centered welcome up
       and down. Anchored to root, the welcome stays locked. */
    this.welcomeEl = renderWelcome(this.root, this.plugin.settings.userName);

    /* Cmd/Ctrl+F opens the in-conversation search when the tab content is
       focused. stopPropagation prevents Obsidian's global Find from claiming
       the keystroke. */
    this.root.addEventListener("keydown", e => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        this.searchBar.open();
      }
    });

    this.renderer = new MessageListRenderer(this.app, this.component, this.messagesEl);
    this.renderer.setActionCallbacks({
      onFork: messageId => this.onForkRequest?.(this, messageId),
    });
    this.approvalArea = new ApprovalArea(this.root, {
      onDecide: (requestId, decision) => this.handleApproval(requestId, decision),
    });
    this.statusIndicator = new StatusIndicator(this.root);
    /* Reparent the pill into the message list so it trails the last assistant
       block (tool call, text, thinking, etc.) and scrolls with chat content
       instead of floating above the input box. Renderer keeps it positioned
       just before the bottom sentinel on every layout pass. */
    this.renderer.setTailEl(this.statusIndicator.rootEl);
    this.inputBox = new InputBox(
      this.root,
      this.plugin.settings,
      {
        onSubmit: payload => void this.submit(payload),
        onModelChange: model => this.handleModelChange(model),
        onEffortChange: effort => this.handleEffortChange(effort),
        onPermissionModeChange: mode => this.handlePermissionModeChange(mode),
        onMentionQuery: query => this.queryFileSuggestions(query),
        onSlashQuery: query => this.querySlashCommands(query),
        onCancel: () => void this.cancelStream(),
        onSelectionDismissed: () => this.selectionTracker?.clear(),
        /* Pill click opens the Create-subagent modal. Launching an existing
           agent is still reachable via the /agent slash command, which keeps
           the SubagentPicker path alive without needing a second toolbar
           button. */
        onAgentLaunch: () => this.openCreateSubagentModal(),
        onPinFolder: path => this.activeFileIndicator.addPinnedPath(path),
        onTryPinVaultPath: path => this.tryPinVaultPath(path),
        onIsVaultDragActive: () => this.isVaultDragActive(),
        onTryConsumeVaultDrag: () => this.tryConsumeVaultDrag(),
      },
      {
        model: (this.state.model as ModelKey | undefined) ?? this.plugin.settings.defaultModel,
        effort: (this.state.effort as EffortLevel | undefined) ?? this.plugin.settings.defaultEffort,
        permissionMode: (this.state.permissionMode as PermissionMode | undefined) ?? this.plugin.settings.permissionMode,
      }
    );
    /* Initial paint for the agents pill — visible whenever the catalog has
       at least one entry. Re-painted in handlePluginSlashCommand after the
       catalog refreshes. */
    this.inputBox.setAgentCount(this.plugin.subagentCatalog.agents.length);
    /* Mount the active-file pill bar inside the input wrapper (above the
       textarea) instead of letting it float above the entire input box.
       Parent is this.root only to satisfy the constructor; the next line
       reparents to the wrapper. */
    /* Legacy-state migration for sticky pins. If the persisted state
       predates the sticky field (undefined), assume all currently-pinned
       files were sticky (matches old behavior where every pin survived
       across submits). Once stickyPinnedFilePaths is defined, it's
       authoritative — even when empty. */
    const initialPinned = this.state.pinnedFilePaths ?? [];
    const initialSticky = this.state.stickyPinnedFilePaths ?? initialPinned;
    this.activeFileIndicator = new ActiveFileIndicator(
      this.root,
      this.app,
      initialPinned,
      initialSticky,
      {
        onPinChange: (paths, stickyPaths) => {
          this.state.pinnedFilePaths = paths;
          this.state.stickyPinnedFilePaths = stickyPaths;
          this.state.updatedAt = Date.now();
          this.onStateChangeCb();
          /* Pin count is half of the cost-surface pill's payload; refresh
             so the toolbar count reflects this change immediately. MCP
             count comes along for the ride from the same async load. */
          void this.refreshCostSurface();
        },
      }
    );
    this.inputBox.mountTopBar(this.activeFileIndicator.root);
    /* Seed the cost-surface pill on mount: counts pinned files in this tab
       and MCP servers configured in <vault>/.claude/mcp.json. Async because
       the MCP config is read from disk. Re-fires from onPinChange and from
       refreshCostSurface() after the MCP manager closes. */
    void this.refreshCostSurface();

    this.pairingCard = new RemotePairingCard(this.root, {
      onDisconnect: () => void this.switchMode("local"),
    });

    /* SelectionTracker pushes the active editor selection into the input
       box as a pinned context chip. Selection survives keystrokes; the chip
       is consumed (cleared) on submit. */
    this.selectionTracker = new SelectionTracker(this.app, sel => {
      this.inputBox.setSelection(sel);
    });

    /* Disable the input until replay finishes so users can't fire a submit
       that races the renderer's catch-up pass. setBusy(false) re-enables it
       once replay resolves. */
    this.inputBox.setBusy(true);
    this.replayDone = this.replayMessages().finally(() => {
      if (!this.state.busy) this.inputBox.setBusy(false);
      /* After replay, surface any in-flight Task/Agent tools the persisted
         state still has marked running. Resumed tabs from a hard reload may
         carry stale "running" statuses; surfacing them is honest to what's
         in state and lets the user see something is unresolved. */
      this.refreshRunningAgentCount();
    });
    this.updateWelcomeVisibility();
  }

  show() { this.root.style.display = ""; }
  hide() { this.root.style.display = "none"; }
  async destroy(): Promise<void> {
    /* Unregister BEFORE disposing so the manager's onExit callback doesn't
       race against our own teardown. teardownSession() awaits SIGTERM and
       the eventual process-exit. */
    if (this.remoteSession) this.plugin.subprocessManager.unregisterRemote(this.state.id);
    await this.teardownSession("destroy");
    const remoteWork = this.remoteSession ? [this.remoteSession.dispose()] : [];
    const tailerWork = this.jsonlTailer ? [this.jsonlTailer.stop()] : [];
    this.statusIndicator.destroy();
    this.activeFileIndicator.destroy();
    this.selectionTracker.destroy();
    this.renderer.destroy();
    this.inputBox.destroy();
    this.root.remove();
    await Promise.all([...remoteWork, ...tailerWork]);
  }

  async switchMode(mode: TabMode): Promise<void> {
    if (this.mode === mode) return;
    /* eslint-disable no-console */
    console.log(`[claude-cli-chat] switchMode tab=${this.state.id} ${this.mode} -> ${mode}`);

    /* Tear down whatever is currently active. */
    if (this.mode === "local") {
      await this.teardownSession("switch");
    } else {
      if (this.remoteSession) {
        this.plugin.subprocessManager.unregisterRemote(this.state.id);
        await this.remoteSession.dispose();
        this.remoteSession = null;
      }
      await this.jsonlTailer?.stop();
      this.jsonlTailer = null;
      this.pairingCard.hide();
    }

    this.mode = mode;
    this.inputBox.setVisible(mode === "local");

    if (mode === "remote") {
      this.startRemoteMode();
    }
    /* Local mode is lazy: ensureSession() fires on next submit. */

    this.onStateChangeCb();
  }

  /* Consolidated subprocess teardown. Five call sites (cancel/restart/clear/
     switch/destroy) all used to duplicate roughly the same dispose-then-null
     sequence with subtle differences; centralizing them prevents drift and
     lets a single re-entrancy guard cover them all.
     - sets `tearingDown` so re-entrant onExit handlers see in-progress state
     - awaits session.dispose() in try/finally so `this.session` is always nulled
     - clears stream pointers and pass timing
     - resets busy (except for "switch", which hands off to the next mode)
     - dismisses visible approval cards for user-driven teardowns
     - clears the errorBubbleEmitted dedup flag */
  private async teardownSession(reason: "cancel" | "restart" | "clear" | "switch" | "destroy"): Promise<void> {
    if (this.tearingDown) return;
    this.tearingDown = true;
    try {
      const s = this.session;
      this.session = null;
      if (s) {
        try { await s.dispose(); } catch { /* ignore — already exited or never spawned */ }
      }
      /* Stop any in-flight subagent JSONL trackers so they don't keep
         pinging the disk after the parent session is gone. Fire and
         forget; releasing the session-file claim happens inside stop(). */
      for (const tracker of this.subagentTrackers.values()) {
        void tracker.stop();
      }
      this.subagentTrackers.clear();
      this.subagentSpawnTimes.clear();
      this.clearStreamingPointer();
      this.streamingBlocks.clear();
      this.passStartedAt = null;
      this.errorBubbleEmitted = false;
      if (reason !== "switch") {
        this.state.busy = false;
        this.inputBox.setBusy(false);
      }
      if (reason === "cancel" || reason === "clear" || reason === "destroy") {
        this.approvalArea.dismissAll();
      }
    } finally {
      this.tearingDown = false;
    }
  }

  /* Reload the cost-surface pill: count pinned files for this tab and read
     MCP server config (both enabled and disabled) from
     <vault>/.claude/mcp.json. Public so the parent view can re-trigger
     after the MCP manager modal closes (which may have added/removed
     servers). Pin changes call this from the indicator callback directly.

     Tool lists come from the most recent init event's tool catalog,
     stashed on state.mcpToolsByServer. Until the first init arrives
     (brand-new tab, no messages yet), tools arrays are empty and the
     pill shows server count without tool count. After init the pill
     gains "(N tools)".

     Errors swallowed because this is a UI hint, not load-bearing — the
     chat works regardless of whether the pill is accurate. */
  public async refreshCostSurface(): Promise<void> {
    const pinCount = (this.state.pinnedFilePaths ?? []).length;
    let mcpServers: Array<{ name: string; enabled: boolean; tools: string[] }> = [];
    try {
      const store = new MCPConfigStore(this.app);
      const all = await store.listAllServers();
      const toolMap = this.state.mcpToolsByServer ?? {};
      mcpServers = all.map(s => ({
        name: s.name,
        enabled: s.enabled,
        tools: s.enabled ? (toolMap[s.name] ?? []) : [],
      }));
    } catch {
      /* ignore — leave mcpServers empty */
    }
    this.inputBox.setCostSurface({
      pinCount,
      mcpServers,
      onMcpToggle: (name, enabled) => void this.setMcpEnabled(name, enabled),
    });
  }

  /* Toggle a server's enabled state and refresh the pill. The mcp.json
     change won't take effect until the CLI subprocess respawns (next
     /clear or new tab); we surface that via a Notice so the user knows
     to restart if they want the change to land immediately. */
  public async setMcpEnabled(name: string, enabled: boolean): Promise<void> {
    try {
      const changed = await new MCPConfigStore(this.app).setEnabled(name, enabled);
      if (changed) {
        new Notice(
          `${enabled ? "Enabled" : "Disabled"} MCP server "${name}". Restart this chat (/clear) for the change to take effect.`,
          6000
        );
      }
    } catch (err) {
      new Notice(`Failed to ${enabled ? "enable" : "disable"} MCP server: ${(err as Error).message}`, 6000);
    }
    void this.refreshCostSurface();
  }

  private startRemoteMode() {
    const cwd = this.plugin.getVaultPath();
    /* When the user sets a name, use it verbatim. Earlier behavior appended
       `-<last 6 of tab id>` to keep concurrent sessions distinct, but that
       leaked into the remote session list on the web/phone where the user
       just wants the configured label. If the field is blank, hand undefined
       to the proxy and let it fall back to the upstream default (hostname). */
    const sessionName = this.plugin.settings.remoteSessionNamePrefix?.trim() || undefined;

    this.pairingCard.show();
    this.pairingCard.setStatus("starting");
    this.pairingCard.setUrl("");

    this.remoteSession = new RemoteControlSession({
      cwd,
      sessionId: this.state.sessionId ?? undefined,
      sessionName,
      claudePath: this.plugin.settings.claudePath || undefined,
    });
    /* Register with the central manager so it gets reaped on plugin
       unload even if this TabController's destroy() never runs (e.g.
       Obsidian quits hard, plugin disabled while view is gone). */
    this.plugin.subprocessManager.registerRemote(this.state.id, this.remoteSession);

    this.remoteSession.onStatus(s => {
      this.pairingCard.setStatus(s);
      this.onStateChangeCb();
    });
    this.remoteSession.onUrl(url => {
      this.pairingCard.setUrl(url);
    });
    this.remoteSession.onSessionFile(path => {
      this.attachJsonlTailer(path);
    });
    this.remoteSession.onExit(() => {
      this.jsonlTailer?.stop();
      this.jsonlTailer = null;
    });
  }

  private attachJsonlTailer(path: string) {
    if (this.jsonlTailer) return;
    this.jsonlTailer = new JsonlTailer(path);
    this.jsonlTailer.onEvent(e => void this.onEvent(e));
    /* Surface start failures (file missing, EACCES, etc.) into the chat
       instead of letting them die as an unhandled promise rejection. */
    this.jsonlTailer.start().catch(err => {
      console.warn(`[claude-cli-chat] jsonlTailer.start failed:`, err);
      void this.handleError({ type: "error", subtype: "tailer_start_error", message: String(err) } as ErrorEvent);
    });
  }

  hasPendingApprovals(): boolean { return this.state.pendingApprovals.size > 0; }
  isBusy(): boolean { return this.state.busy; }

  /* Pull the current title from state into the title bar. Empty title or
     the default placeholder leaves the bar showing the placeholder hint. */
  refreshTitleBar() {
    const title = this.state.title;
    if (!title || title === "New chat") {
      this.titleTextEl.setText("New chat");
      this.titleTextEl.addClass("is-placeholder");
    } else {
      this.titleTextEl.setText(title);
      this.titleTextEl.removeClass("is-placeholder");
    }
  }

  /* Swap the title-text div for an inline input. Commit on Enter / blur,
     cancel on Escape. */
  private beginTitleEdit() {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "claudian-title-input";
    input.value = this.state.title === "New chat" ? "" : this.state.title;
    input.placeholder = "Conversation title";
    this.titleTextEl.replaceWith(input);
    input.focus();
    input.select();

    /* Sentinel guards against Enter + blur double-commit: pressing Enter
       triggers commit AND a blur (since the input is replaced), which
       without this would fire commit() twice and re-replace the already-
       replaced element. Cancel sets the flag too so the trailing blur is
       a no-op. */
    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      const value = input.value.trim();
      this.state.title = value || "New chat";
      this.state.updatedAt = Date.now();
      input.replaceWith(this.titleTextEl);
      this.refreshTitleBar();
      this.onStateChangeCb();
    };
    const cancel = () => {
      if (committed) return;
      committed = true;
      input.replaceWith(this.titleTextEl);
      this.refreshTitleBar();
    };
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", () => commit());
  }

  focusInput() { this.inputBox.focus(); }

  /* Intercept and run plugin-side slash commands. Returns true if the text
     was a command we handled (and the message should NOT be forwarded to
     the CLI), false otherwise. Case-insensitive, trimmed match. */
  private handlePluginSlashCommand(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return false;
    /* Split on first whitespace so commands with args are matchable later. */
    const parts = trimmed.split(/\s+/);
    const head = parts[0].toLowerCase();
    switch (head) {
      case "/clear":
        void this.clear();
        new Notice("Cleared chat — next message starts a new Claude session.");
        return true;
      case "/help": {
        const skills = this.state.availableSkills ?? [];
        const allSlash = this.state.availableSlashCommands ?? [];
        const builtins = allSlash.filter(s => !skills.includes(s));
        const skillsLine = skills.length > 0 ? `Skills (${skills.length}): ${skills.join(", ")}` : "Skills: (none discovered yet — send a message to spawn a session)";
        const builtinsLine = builtins.length > 0 ? `Slash commands: ${builtins.map(s => "/" + s).join(", ")}` : "";
        const agentsLine = this.plugin.subagentCatalog.agents.length > 0
          ? `Subagents (${this.plugin.subagentCatalog.agents.length}): ${this.plugin.subagentCatalog.agents.map(a => a.name).join(", ")}`
          : "Subagents: (none discovered — add .md files under <vault>/.claude/agents/)";
        new Notice(
          [
            "Plugin commands:",
            "  /clear — reset this tab to a fresh session",
            "  /help — show this help",
            "  /agent [name] — launch a subagent (Task tool); opens picker if name omitted",
            "",
            skillsLine,
            builtinsLine,
            agentsLine,
            "",
            "Pick Opus Plan in the model pill for Anthropic's opusplan alias (Opus while in plan mode, Sonnet otherwise). Shift+Tab cycles permission modes.",
          ].filter(Boolean).join("\n"),
          12000
        );
        return true;
      }
      case "/agent": {
        /* Refresh the catalog so edits made since the tab opened land
           without a plugin reload. */
        this.plugin.refreshSubagentCatalog();
        this.inputBox.setAgentCount(this.plugin.subagentCatalog.agents.length);
        const name = parts[1];
        const followup = parts.slice(2).join(" ").trim();
        if (!name) {
          this.openSubagentPicker(followup);
          return true;
        }
        const entry = this.plugin.subagentCatalog.agents.find(a => a.name === name);
        if (!entry) {
          new Notice(
            `No subagent named "${name}". Run /agent (no name) to pick from the discovered catalog.`,
            8000,
          );
          return true;
        }
        this.launchSubagent(entry, followup);
        return true;
      }
      default:
        return false;
    }
  }

  /* Opens the Create-subagent modal. After a successful save the modal
     calls back and we refresh the toolbar pill count so the new agent
     surfaces immediately. */
  openCreateSubagentModal(): void {
    new CreateSubagentModal(this.app, this.plugin, () => {
      this.inputBox.setAgentCount(this.plugin.subagentCatalog.agents.length);
    }).open();
  }

  /* Opens the SubagentPicker (Obsidian SuggestModal) and dispatches the
     chosen entry. Optional `followup` is appended to the synthetic prompt
     so the user can type `/agent some-followup-text` and have the picker
     ask the chosen subagent to act on that text. */
  openSubagentPicker(followup?: string): void {
    const agents = this.plugin.subagentCatalog.agents;
    if (agents.length === 0) {
      new Notice(
        "No subagents discovered. Add a markdown file under <vault>/.claude/agents/ or ~/.claude/agents/.",
        8000,
      );
      return;
    }
    new SubagentPicker(this.app, agents, (entry) => {
      this.launchSubagent(entry, followup ?? "");
    }).open();
  }

  /* Build a synthetic user message asking Claude to invoke the Task tool
     with the chosen subagent, then route it through submit() so the bubble
     renders, persistence fires, and Phase 3's nested rendering activates
     automatically. The synthetic prompt is the simplest reliable trigger;
     phrasing here may need tuning per model (Haiku is the most literal,
     Opus the most creative interpretation). */
  launchSubagent(entry: SubagentEntry, followup?: string): void {
    if (this.state.busy) {
      new Notice("Wait for the current turn to finish before launching a subagent.");
      return;
    }
    const followupText = (followup ?? "").trim();
    const descBit = entry.description ? ` Description: "${entry.description}".` : "";
    let text: string;
    if (followupText) {
      text = `Use the Task tool to launch the "${entry.name}" subagent.${descBit} ${followupText}`;
    } else {
      text = `Use the Task tool to launch the "${entry.name}" subagent.${descBit}`;
    }
    void this.submit({ text, attachments: [] });
  }

  /* Resets the active tab in place: kills the subprocess, wipes messages and
     session id, restores the welcome screen. The tab id is preserved so disk
     persistence and the tab bar position stay stable. */
  async clear() {
    await this.teardownSession("clear");
    this.state.messages = [];
    this.state.pendingApprovals.clear();
    this.state.sessionId = null;
    this.state.title = "New chat";
    this.state.updatedAt = Date.now();
    /* Drop cached skill / slash lists so the suggestion popup doesn't
       advertise commands until the new subprocess re-announces them. */
    this.state.availableSkills = undefined;
    this.state.availableSlashCommands = undefined;
    this.titleGenerationStarted = false;
    this.refreshTitleBar();
    this.toolToMessage.clear();
    this.renderer.reset();
    this.statusIndicator.hide();
    this.inputBox.setUsage(undefined);
    this.inputBox.setActiveSubModel(undefined);
    this.updateWelcomeVisibility();
    this.onStateChangeCb();
    /* Reset the TC001 to "ready" so it doesn't sit on whatever state the
       cancelled turn left it in (thinking / needs_permission). Animator's
       60s timeout will flip ready → idle if no follow-up turn arrives. */
    StateEmitter.setState("ready");
  }

  /* Esc-cancel: kill the in-flight subprocess so streaming stops, but keep
     `sessionId` so the next user message resumes the conversation via
     `--resume`. Visible messages are left in place. No-op if not busy. */
  async cancelStream() {
    if (!this.state.busy) return;
    this.userCancelInitiated = true;
    /* Best-effort deny any pending approvals so the CLI doesn't sit waiting
       for a response we'll never send. Ignore individual errors — the
       subprocess may already be gone. */
    for (const requestId of Array.from(this.state.pendingApprovals.keys())) {
      try {
        this.session?.deny(requestId, "User cancelled");
      } catch { /* ignore — best-effort */ }
    }
    this.state.pendingApprovals.clear();
    if (this.remoteSession) {
      await this.remoteSession.dispose();
      this.remoteSession = null;
    }
    await this.teardownSession("cancel");
    /* Mark any Task/Agent tools that were still running as errored — the
       subprocess just died, so they're not going to receive a tool_result.
       Without this they linger at status=running indefinitely and the
       Agents pill's running counter stays stuck. */
    for (const m of this.state.messages) {
      if (!m.toolCalls) continue;
      for (const t of m.toolCalls) {
        if ((t.name === "Task" || t.name === "Agent") && t.status === "running") {
          t.status = "errored";
          t.isError = true;
          t.nestedStatus = "failed";
        }
      }
    }
    this.refreshRunningAgentCount();
    this.statusIndicator.hide();
    new Notice("Stopped Claude.");
    this.onStateChangeCb();
  }

  private async replayMessages() {
    for (const msg of this.state.messages) {
      await this.renderer.upsertMessage(msg);
    }
  }

  private updateWelcomeVisibility() {
    setWelcomeVisible(this.welcomeEl, this.state.messages.length === 0);
  }

  private ensureSession(): TabSession {
    if (this.session && this.session.status !== "exited") return this.session;
    const cwd = this.plugin.getVaultPath();
    const modelKey = (this.state.model as ModelKey | undefined) ?? this.plugin.settings.defaultModel;
    const effortKey = (this.state.effort as EffortLevel | undefined) ?? this.plugin.settings.defaultEffort;
    const modeKey = (this.state.permissionMode as PermissionMode | undefined) ?? this.plugin.settings.permissionMode;
    /* If a snippet is applied, look it up at spawn time so edits to the
       snippet's systemPromptAddendum take effect on the next restart. */
    const snippet = this.state.envSnippetId
      ? this.plugin.settings.envSnippets.find(s => s.id === this.state.envSnippetId)
      : undefined;
    /* Compose the vault-wide addendum (always applies in this vault) with the
       per-tab snippet addendum (overlay). Either or both may be empty. */
    const vaultAddendum = (this.plugin.settings.vaultSystemPromptAddendum ?? "").trim();
    const snippetAddendum = (snippet?.systemPromptAddendum ?? "").trim();
    const composedAddendum =
      [vaultAddendum, snippetAddendum].filter(s => s.length > 0).join("\n\n") || undefined;
    const opts = spawnOptionsFromSettings(this.plugin.settings, cwd, this.state.sessionId ?? undefined, {
      model: resolveModelId(modelKey),
      effort: effortKey,
      permissionMode: modeKey,
      appendSystemPrompt: composedAddendum,
    });
    this.session = this.plugin.subprocessManager.spawn(this.state.id, opts);
    this.session.onEvent(e => this.onEvent(e));
    this.session.onExit((code, signal) => this.onExit(code, signal));
    this.session.onError(err => this.onErrorRaw(err));
    /* Buffer the most recent stderr so we can include it in the error bubble
       when the subprocess dies mid-stream. The CLI usually logs the actual
       crash reason there (panic trace, model-route failure, etc.). */
    this.session.onStderr(chunk => {
      this.lastStderr = (this.lastStderr + chunk).slice(-2000);
    });
    return this.session;
  }

  /* Last ~2KB of stderr from the active subprocess. Cleared on each spawn. */
  private lastStderr = "";

  private restartSubprocess() {
    void this.teardownSession("restart");
    this.lastStderr = "";
  }

  private handleModelChange(model: ModelKey) {
    this.state.model = model;
    this.state.updatedAt = Date.now();
    this.restartSubprocess();
    this.onStateChangeCb();
  }

  private handleEffortChange(effort: EffortLevel) {
    this.state.effort = effort;
    this.state.updatedAt = Date.now();
    this.restartSubprocess();
    this.onStateChangeCb();
  }

  private handlePermissionModeChange(mode: PermissionMode) {
    this.state.permissionMode = mode;
    this.state.updatedAt = Date.now();
    this.restartSubprocess();
    this.onStateChangeCb();
  }

  /* Apply an environment snippet — overwrites model + effort + permission
     mode on this tab and stores the snippet id so the addendum is reapplied
     on every subsequent spawn. Restarts the subprocess so the new
     --append-system-prompt takes effect immediately. */
  applySnippet(snippet: EnvSnippet) {
    this.state.envSnippetId = snippet.id;
    this.state.model = snippet.model;
    this.state.effort = snippet.effort;
    this.state.permissionMode = snippet.permissionMode;
    this.state.updatedAt = Date.now();
    this.inputBox.setModel(snippet.model);
    this.inputBox.setEffort(snippet.effort);
    this.inputBox.setPermissionMode(snippet.permissionMode);
    this.restartSubprocess();
    this.onStateChangeCb();
  }

  clearSnippet() {
    this.state.envSnippetId = undefined;
    this.restartSubprocess();
    this.onStateChangeCb();
  }

  getAppliedSnippetId(): string | undefined {
    return this.state.envSnippetId;
  }

  private async submit(payload: SubmitPayload) {
    let { text } = payload;
    const { attachments, selection } = payload;

    /* Block until the constructor's replay pass has fully rendered the
       restored messages — otherwise our state.messages.push() races the
       renderer's catch-up loop. */
    await this.replayDone;

    /* Reset per-pass dedup flags so a new submit can emit a fresh error
     bubble and so any lingering cancel intent from a previous interaction
     doesn't suppress the new turn's events. */
    this.errorBubbleEmitted = false;
    this.userCancelInitiated = false;

    /* Plugin-side slash commands. Claude Code's stream-json mode does NOT
       intercept slash commands — they get sent to the model as plain text.
       For commands the user clearly means as UI operations, we handle them
       here before anything reaches the subprocess. */
    if (attachments.length === 0 && !selection && this.handlePluginSlashCommand(text)) {
      return;
    }

    /* Build the wire text Claude actually sees. The chat bubble still shows
       only the user's typed `text`; pinned-file refs and the selection
       block are wire-only so the bubble stays clean. */
    let wireText = text;

    /* Pinned files from the file-pill bar inject as @-context. The pill bar
       is the new explicit mechanism (replaces the prior autoAttachActiveFile
       setting). Each pinned path is prepended once; duplicates the user
       already wrote into the message are skipped.

       Office binaries (.pptx, .docx) can't ride as @-refs — Claude Code's
       Read tool rejects them. For those we extract plain text on the plugin
       side and inline it as a fenced block; everything else still uses the
       @-ref path so the CLI handles file expansion + caching. */
    const pinnedPaths = this.activeFileIndicator.getPinnedPaths();
    const officePaths = pinnedPaths.filter(p => isExtractableOffice(p));
    const refPaths = pinnedPaths.filter(p => !isExtractableOffice(p));

    const pinnedRefs = refPaths
      .filter(p => !text.includes(`@${p}`))
      .map(p => `@${p}`)
      .join(" ");
    if (pinnedRefs) {
      wireText = `${pinnedRefs} ${wireText}`;
    }

    const officeInlines: string[] = [];
    for (const p of officePaths) {
      try {
        const extracted = await extractOfficeText(this.app, p);
        officeInlines.push(`<file path="${p}">\n${extracted}\n</file>`);
      } catch (err) {
        new Notice(`Couldn't extract text from ${p}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (officeInlines.length > 0) {
      wireText = `${officeInlines.join("\n\n")}\n\n${wireText}`;
    }

    /* If a selection was attached, render it as a small flag chip ABOVE
       the bubble via the message's selectionContext field. Claude still
       receives the full inlined version (fenced selection + question)
       via wireText. */
    let selectionContext: ChatMessage["selectionContext"];
    if (selection) {
      wireText = formatSelectionForPrompt(selection, wireText);
      selectionContext = {
        filePath: selection.filePath,
        startLine: selection.startLine,
        endLine: selection.endLine,
      };
      this.selectionTracker.clear();
    }

    const msg: ChatMessage = {
      id: makeMessageId(),
      role: "user",
      content: text,
      timestamp: Date.now(),
      attachments: attachments.length > 0 ? attachments : undefined,
      selectionContext,
    };
    this.state.messages.push(msg);
    this.state.busy = true;
    this.state.updatedAt = Date.now();
    if (this.state.title === "New chat" && text) {
      /* Use the user's original typed text for the fallback title, not the
         augmented wire text — otherwise tabs would be titled with the
         selection block prefix. */
      this.state.title = text.slice(0, 48);
    } else if (this.state.title === "New chat" && attachments.length > 0) {
      const allImages = attachments.every(a => (a.kind ?? "image") === "image");
      this.state.title = allImages
        ? `Image (${attachments.length})`
        : `Attachment (${attachments.length})`;
    }
    this.updateWelcomeVisibility();
    await this.renderer.upsertMessage(msg);
    this.renderer.forceStickToBottom();
    this.inputBox.setBusy(true);
    this.statusIndicator.setThinking();
    StateEmitter.setState("thinking");
    this.passStartedAt = Date.now();
    this.onStateChangeCb();

    /* Auto-drop non-sticky pins. The file contents are already inlined
       into THIS turn's wireText (built above), and once the API request
       lands they live forever in the conversation history. Re-shipping
       them on every follow-up turn is the cost we're trying to avoid.
       Sticky pins survive; non-sticky pins fall off the pill bar.
       setPinnedPaths is a no-op when sticky == pinned (nothing to drop). */
    const stickyOnly = this.activeFileIndicator.getStickyPaths();
    this.activeFileIndicator.setPinnedPaths(stickyOnly);

    /* Parallel-fire title generation: kick off the Haiku subprocess the
       moment we have the user's message, so it runs concurrently with the
       assistant response instead of waiting for it to complete. Title
       usually arrives during or right at the end of the response, making
       the lag invisible. Guarded by maybeGenerateTitle so it no-ops on
       follow-up turns and when the setting is off. */
    void this.maybeGenerateTitle();

    const session = this.ensureSession();
    /* eslint-disable no-console */
    console.log(`[claude-cli-chat] submit -> session.status=${session.status}`);
    /* Claude Code stream-json mode does NOT emit `system/init` until it has
       read at least one user message from stdin. Writing immediately after
       spawn is the correct pattern. The CLI processes the message, then
       emits init + response together. */
    /* Build per-kind output. Text attachments don't ride as content blocks —
       they get inlined into wireText as <file path="…"> envelopes, same shape
       as the office-extraction path above. Images and PDFs ride as blocks.
       Anything that fails its data/content invariant (shouldn't happen in
       practice; defensive against future persisted-shape drift) is logged
       and skipped rather than silently dropped or sent with bad data. */
    const mediaBlocks: ContentBlock[] = [];
    const textInlines: string[] = [];
    for (const att of attachments) {
      const kind = att.kind ?? "image";
      if (kind === "image") {
        if (!att.data) {
          console.warn("[claude-cli-chat] image attachment missing data; skipping", att);
          continue;
        }
        const block: ImageBlock = {
          type: "image",
          source: { type: "base64", media_type: att.mediaType, data: att.data },
        };
        mediaBlocks.push(block);
      } else if (kind === "pdf") {
        if (!att.data) {
          console.warn("[claude-cli-chat] pdf attachment missing data; skipping", att);
          continue;
        }
        /* No `title` field — undocumented for base64-PDF document blocks and
           may trip the CLI's Zod schema validation (see CLAUDE.md wire-format
           gotcha #4). The filename rides on the chip in the bubble, which is
           enough for the user; Claude infers context from the PDF content. */
        const block: DocumentBlock = {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: att.data },
        };
        mediaBlocks.push(block);
      } else if (kind === "text") {
        if (att.content === undefined) {
          console.warn("[claude-cli-chat] text attachment missing content; skipping", att);
          continue;
        }
        const path = att.filename ?? "attached.txt";
        textInlines.push(`<file path="${path}">\n${att.content}\n</file>`);
      }
    }
    const finalText = textInlines.length > 0
      ? `${textInlines.join("\n\n")}\n\n${wireText}`
      : wireText;
    if (mediaBlocks.length === 0) {
      session.sendUserText(finalText);
      return;
    }
    const blocks: ContentBlock[] = [...mediaBlocks];
    if (finalText) blocks.push({ type: "text", text: finalText });
    session.sendUserContent(blocks);
  }

  private async onEvent(event: StreamEvent) {
    switch (event.type) {
      case "system": {
        const sys = event as SystemInitEvent | SystemApiRetryEvent | { type: "system"; subtype: string };
        if (sys.subtype === "init") {
          const init = sys as SystemInitEvent;
          if (init.session_id) this.state.sessionId = init.session_id;
          /* Cache the slash-command and skill lists the CLI just announced.
             Reset on every spawn — when the user switches model / effort /
             permission mode the subprocess restarts and a new init arrives
             with the same data (or different, if a plugin's availability
             depends on permission mode). */
          if (init.slash_commands) this.state.availableSlashCommands = init.slash_commands;
          if (init.skills) this.state.availableSkills = init.skills;
          /* Group MCP-namespaced tools by server. The CLI names every MCP
             tool as `mcp__<server>__<tool>` (double-underscore separator),
             so parsing is mechanical. Other tools (Read, Bash, Edit, etc.)
             are non-MCP and skipped. Result feeds the cost-surface pill
             and its hover popup. */
          if (Array.isArray(init.tools)) {
            const grouped: Record<string, string[]> = {};
            for (const tool of init.tools) {
              if (!tool.startsWith("mcp__")) continue;
              const parts = tool.split("__");
              if (parts.length < 3) continue;
              const server = parts[1];
              const toolName = parts.slice(2).join("__");
              (grouped[server] ??= []).push(toolName);
            }
            this.state.mcpToolsByServer = grouped;
            /* Init carries the full tool list, so this is the canonical
               moment to refresh the pill with real tool counts. */
            void this.refreshCostSurface();
          }
        } else if (sys.subtype === "api_retry") {
          const retry = sys as SystemApiRetryEvent;
          this.statusIndicator.setRetrying(retry.attempt, retry.max_retries, retry.retry_delay_ms);
        }
        break;
      }
      case "user": {
        await this.handleUserEcho(event as { type: "user"; message: { role: "user"; content: Array<{ type: string; text?: string }> } });
        break;
      }
      case "stream_event": {
        await this.handleStreamEvent(event as StreamEventEvent);
        break;
      }
      case "assistant": {
        await this.handleAssistant(event as AssistantEvent);
        break;
      }
      case "tool_use": {
        await this.handleToolUse(event as ToolUseEvent);
        break;
      }
      case "tool_result": {
        await this.handleToolResult(event as ToolResultEvent);
        break;
      }
      case "control_request": {
        this.handleControlRequest(event as ControlRequestEvent);
        break;
      }
      case "result": {
        this.handleResult(event as ResultEvent);
        break;
      }
      case "usage": {
        const u = (event as UsageEvent).usage;
        if (u) this.inputBox.setUsage(u);
        break;
      }
      case "error": {
        await this.handleError(event as ErrorEvent);
        break;
      }
      default:
        break;
    }
    this.onStateChangeCb();
  }

  private async handleUserEcho(event: { message: { content: Array<{ type: string; text?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> } }) {
    /* Synthetic user turns from the CLI carry two kinds of blocks:
       - text blocks (real user input echoed back, OR skill bodies / file
         contents the CLI injects into the model's context behind the scenes)
       - tool_result blocks (delivered back to the model after a tool ran) */
    const blocks = event.message.content;

    for (const block of blocks) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        await this.handleToolResult({
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: (block.content as string | ContentBlock[]) ?? "",
          is_error: block.is_error,
        });
      }
    }

    /* Render text bubbles only in remote mode. In local mode the user's real
       input already got a synchronous bubble from submit(), so anything else
       arriving as a "user" text block is the CLI feeding context to itself
       (skill bodies, injected file contents) — rendering those as user
       bubbles is just noise. */
    if (this.mode !== "remote") return;

    const textBlocks = blocks.filter(b => b.type === "text") as Array<{ text: string }>;
    const text = textBlocks.map(b => b.text).join("");
    if (!text) return;
    const last = [...this.state.messages].reverse().find(m => m.role === "user");
    /* Compare trimmed so an echo that adds/strips trailing whitespace doesn't
       cause a duplicate bubble. */
    if (last && last.content.trim() === text.trim()) return;
    const msg: ChatMessage = {
      id: makeMessageId(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    this.state.messages.push(msg);
    if (this.state.title === "New chat") this.state.title = text.slice(0, 48);
    this.updateWelcomeVisibility();
    await this.renderer.upsertMessage(msg);
  }

  private async handleStreamEvent(event: StreamEventEvent) {
    if (this.userCancelInitiated) return;
    const inner = event.event;

    if (inner.type === "content_block_start") {
      const block = inner.content_block;
      if (block.type === "tool_use") {
        /* Surface the tool the moment Claude commits to calling it. The
           input may still be empty here — input_json_delta will fill it in. */
        const msg = this.getOrCreateStreamingAssistantMessage();
        msg.toolCalls = msg.toolCalls ?? [];
        if (!msg.toolCalls.find(t => t.id === block.id)) {
          msg.toolCalls.push({ id: block.id, name: block.name, input: block.input ?? {}, status: "running" });
          this.toolToMessage.set(block.id, msg.id);
          if (block.name === "Task" || block.name === "Agent") this.refreshRunningAgentCount();
        }
        this.streamingBlocks.set(inner.index, { kind: "tool", toolId: block.id, partialJson: "" });
        /* Re-arm the gerund spinner. Tool execution is a silent server-side
           wait — without this the indicator dies on the first text_delta
           and never returns, leaving a void below the running tool. */
        this.statusIndicator.setThinking();
        await this.renderer.upsertMessage(msg);
      } else if (block.type === "thinking") {
        const msg = this.getOrCreateStreamingAssistantMessage();
        msg.thinking = msg.thinking ?? "";
        msg.thinkingStreaming = true;
        this.streamingBlocks.set(inner.index, { kind: "thinking" });
        await this.renderer.upsertMessage(msg);
      }
      return;
    }

    if (inner.type === "content_block_delta") {
      if (inner.delta.type === "text_delta") {
        /* First text delta means the response is flowing — drop the thinking
           spinner so the user sees content instead. */
        this.statusIndicator.hide();
        const msg = this.getOrCreateStreamingAssistantMessage();
        msg.content += inner.delta.text;
        await this.renderer.upsertMessage(msg);
      } else if (inner.delta.type === "thinking_delta") {
        const msg = this.getOrCreateStreamingAssistantMessage();
        msg.thinking = (msg.thinking ?? "") + inner.delta.thinking;
        msg.thinkingStreaming = true;
        await this.renderer.upsertMessage(msg);
      } else if (inner.delta.type === "input_json_delta") {
        const slot = this.streamingBlocks.get(inner.index);
        if (slot && slot.kind === "tool") {
          slot.partialJson += inner.delta.partial_json;
          /* Attempt a partial parse so the user sees the tool input filling in.
             If JSON is incomplete this throws — silently ignore until it parses. */
          try {
            const parsed = JSON.parse(slot.partialJson);
            /* Resolve the owning message via toolToMessage first — that map
               is the authoritative registry of which message owns each
               tool_use_id (handled at content_block_start / handleToolUse).
               Fall back to scanning state.messages for legacy compat in case
               we somehow received deltas before the start event. */
            const ownerId = this.toolToMessage.get(slot.toolId);
            let msg = ownerId ? this.state.messages.find(m => m.id === ownerId) : undefined;
            if (!msg) msg = this.state.messages.find(m => m.toolCalls?.some(t => t.id === slot.toolId));
            const tool = msg?.toolCalls?.find(t => t.id === slot.toolId);
            if (tool) {
              tool.input = parsed;
              if (msg) await this.renderer.upsertMessage(msg);
            }
          } catch { /* incomplete JSON — wait for more deltas */ }
        }
      }
      return;
    }

    if (inner.type === "content_block_stop") {
      const slot = this.streamingBlocks.get(inner.index);
      if (slot?.kind === "thinking") {
        const msg = this.getOrCreateStreamingAssistantMessage();
        msg.thinkingStreaming = false;
        await this.renderer.upsertMessage(msg);
      } else if (slot?.kind === "tool") {
        /* Tool input is now finalized. Start the subagent tracker if this
           is a Task tool — by spawn time the CLI has already begun running
           the subagent, so kicking off the JSONL watcher here gives us the
           earliest window before any nested events land. */
        const msgId = this.toolToMessage.get(slot.toolId);
        const msg = msgId ? this.state.messages.find(m => m.id === msgId) : undefined;
        const tool = msg?.toolCalls?.find(t => t.id === slot.toolId);
        if (tool && msg) this.maybeStartSubagentTracker(tool, msg);
      }
      this.streamingBlocks.delete(inner.index);
      /* If a tool block is still streaming after this text/thinking block
         finishes, re-arm the gerund spinner — the user is still waiting on
         the model and tool deltas don't fire the indicator on their own. */
      const stillToolRunning = Array.from(this.streamingBlocks.values()).some(s => s.kind === "tool");
      if (stillToolRunning) this.statusIndicator.setThinking();
      return;
    }

    /* message_delta.usage is incremental output-token deltas, not a context
       snapshot — using it for the chip would jitter wildly. We get the real
       per-call usage from the assistant event instead. */
    /* message_start / message_delta / message_stop are no-ops for now. */
  }

  private async handleAssistant(event: AssistantEvent) {
    if (this.userCancelInitiated) return;
    const msg = this.getOrCreateStreamingAssistantMessage();
    const blocks = (event.message.content ?? []) as AssistantContentBlock[];

    /* Per-call usage is the right source for the context-window indicator —
       cumulative result.usage over-counts shared context across multi-pass
       tool turns. Update after each assistant message so the chip reflects
       the most recent API call's actual context size. */
    if (event.message.usage) this.inputBox.setUsage(event.message.usage);

    /* Surface the actual model the CLI resolved for this turn. Always a
       no-op when the user-selected model isn't opus-plan; for opus-plan
       this paints the "via Opus" / "via Sonnet" badge so the mid-turn
       hand-off is visible. */
    this.inputBox.setActiveSubModel(event.message.model);

    /* Text: replace, since streaming deltas may have only accumulated partial
       text and the assistant event is the authoritative final string. */
    const finalText = blocks.filter(b => b.type === "text").map(b => (b as { text: string }).text).join("");
    if (finalText) msg.content = finalText;

    /* Tool uses: ensure every tool_use block has a corresponding entry. The
       streaming path (content_block_start) usually creates these first, but
       this catches anything the stream missed (or runs in non-streaming mode). */
    msg.toolCalls = msg.toolCalls ?? [];
    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      const tu = block as ToolUseBlock;
      const existing = msg.toolCalls.find(t => t.id === tu.id);
      if (existing) {
        existing.input = tu.input;
        /* Late-arriving final input may be the first place a Task tool's
           prompt is fully populated in non-streaming mode. Try to start a
           tracker; maybeStart is idempotent. */
        this.maybeStartSubagentTracker(existing, msg);
      } else {
        const newTool: ToolCall = { id: tu.id, name: tu.name, input: tu.input, status: "running" };
        msg.toolCalls.push(newTool);
        this.toolToMessage.set(tu.id, msg.id);
        this.maybeStartSubagentTracker(newTool, msg);
        if (tu.name === "Task" || tu.name === "Agent") this.refreshRunningAgentCount();
      }
    }

    /* Thinking: concatenate any final thinking blocks. If streaming already
       built up msg.thinking, the final block's text matches and replacing is a
       no-op; if streaming was disabled, this is where thinking first appears. */
    const thinkingText = blocks
      .filter(b => b.type === "thinking")
      .map(b => (b as ThinkingBlock).thinking)
      .join("\n\n");
    if (thinkingText) msg.thinking = thinkingText;
    msg.thinkingStreaming = false;

    msg.streaming = false;
    if (this.passStartedAt !== null) {
      msg.durationMs = Date.now() - this.passStartedAt;
    }
    this.maybeMergePrefixPreamble(msg);
    await this.renderer.upsertMessage(msg);

    /* After a final assistant message, future deltas belong to a new bubble.
       Null out passStartedAt rather than restamping to Date.now(): the old
       code re-anchored here, which on a multi-pass tool turn caused the
       NEXT pass's timer to include the entire tool-execution wait (since
       no other event reset it before the next content_block_start). Nulling
       lets getOrCreateStreamingAssistantMessage() anchor a fresh timer
       when the next pass actually begins streaming. */
    this.clearStreamingPointer();
    this.streamingBlocks.clear();
    this.passStartedAt = null;
  }

  /* Interleaved thinking can produce two adjacent assistant passes where the
     first is a partial preamble ("I'll build the…"), gets interrupted by a
     thinking block, and the second pass re-emits the same opening in full
     ("I'll build the… file now."). The degenerate case is when the second
     pass re-emits the identical sentence verbatim — same text, two bubbles,
     two "Thought for Ns" footers. When the second pass finalizes, fold the
     earlier preamble into it: drop the older bubble from state + DOM, sum
     the durations, and prefer the longer thinking trace (the long pass's
     reasoning is the substantive one; the short pass after it is usually a
     sanity-check). Guarded so it never collapses a real preamble that was
     followed by a tool call, or short single-character prefixes. */
  private maybeMergePrefixPreamble(current: ChatMessage) {
    const idx = this.state.messages.findIndex(m => m.id === current.id);
    if (idx <= 0) return;
    const prev = this.state.messages[idx - 1];
    if (prev.role !== "assistant") return;
    if (prev.streaming) return;
    if (prev.toolCalls && prev.toolCalls.length > 0) return;
    const prevText = prev.content.trim();
    const currText = current.content.trim();
    if (prevText.length < 20) return;
    if (prevText.length > currText.length) return;
    if (!currText.startsWith(prevText)) return;

    if (prev.durationMs !== undefined) {
      current.durationMs = (current.durationMs ?? 0) + prev.durationMs;
    }
    if (prev.thinking && (!current.thinking || prev.thinking.length > current.thinking.length)) {
      current.thinking = prev.thinking;
    }
    this.state.messages.splice(idx - 1, 1);
    this.renderer.removeMessage(prev.id);
  }

  private async handleToolUse(event: ToolUseEvent) {
    if (this.userCancelInitiated) return;
    const msg = this.getOrCreateStreamingAssistantMessage();
    msg.toolCalls = msg.toolCalls ?? [];
    const tool: ToolCall = {
      id: event.id,
      name: event.name,
      input: event.input,
      status: "running",
    };
    msg.toolCalls.push(tool);
    this.toolToMessage.set(event.id, msg.id);
    /* Non-streaming fallback path. In stream mode the tracker has already
       been started from content_block_stop; this maybeStart no-ops then. */
    this.maybeStartSubagentTracker(tool, msg);
    await this.renderer.upsertMessage(msg);
  }

  private async handleToolResult(event: ToolResultEvent) {
    if (this.userCancelInitiated) return;
    const msgId = this.toolToMessage.get(event.tool_use_id);
    if (!msgId) return;
    const msg = this.state.messages.find(m => m.id === msgId);
    if (!msg || !msg.toolCalls) return;
    const tool = msg.toolCalls.find(t => t.id === event.tool_use_id);
    if (!tool) return;
    tool.status = event.is_error ? "errored" : "completed";
    tool.isError = !!event.is_error;
    tool.result = this.flattenContent(event.content);
    /* Finalize subagent tracking on Task/Agent tool completion: stop the
       tailer, compute duration, and flip nestedStatus. Leaves nestedEvents
       in place so the user can keep scrolling through what the subagent
       did. Tool name is "Task" on Claude Code 2.1.141 and "Agent" on
       2.1.143+. */
    if (tool.name === "Task" || tool.name === "Agent") {
      const tracker = this.subagentTrackers.get(event.tool_use_id);
      if (tracker) {
        void tracker.stop();
        this.subagentTrackers.delete(event.tool_use_id);
      }
      const spawnedAt = this.subagentSpawnTimes.get(event.tool_use_id);
      if (spawnedAt !== undefined) {
        tool.nestedDurationMs = Date.now() - spawnedAt;
        this.subagentSpawnTimes.delete(event.tool_use_id);
      }
      tool.nestedStatus = event.is_error ? "failed" : "completed";
      this.refreshRunningAgentCount();
    }
    await this.renderer.upsertMessage(msg);
  }

  /* Starts a SubagentSessionTracker for a Task/Agent tool, idempotent per
     tool id. Triggered from three places: content_block_stop (streaming),
     handleAssistant (final assistant event), and handleToolUse (non-
     streaming). All three reach the same point once tool.input.prompt is
     populated; first call wins. Tool name is "Task" on Claude Code 2.1.141
     and "Agent" on 2.1.143+. */
  private maybeStartSubagentTracker(tool: ToolCall, _msg: ChatMessage): void {
    if (tool.name !== "Task" && tool.name !== "Agent") return;
    if (this.subagentTrackers.has(tool.id)) return;
    if (!this.state.sessionId) return;
    const cwd = this.plugin.getVaultPath();
    if (!cwd) return;
    const promptVal = (tool.input as { prompt?: unknown })?.prompt;
    const parentPrompt = typeof promptVal === "string" ? promptVal : "";

    tool.nestedStatus = "spawning";
    tool.nestedEvents = tool.nestedEvents ?? [];
    this.subagentSpawnTimes.set(tool.id, Date.now());

    const tracker = new SubagentSessionTracker({
      cwd,
      parentSessionId: this.state.sessionId,
      parentToolUseId: tool.id,
      parentPrompt,
      onUpdate: (update) => this.applySubagentUpdate(tool.id, update),
      subprocessManager: this.plugin.subprocessManager,
    });
    this.subagentTrackers.set(tool.id, tracker);
    tracker.start();
  }

  /* Applies one tracker update to the corresponding ToolCall: appends
     events (with cap), promotes status, applies nested tool_use status
     updates, and triggers a renderer pass. Tolerant of late updates
     arriving after the tool_result already finalized — the nestedStatus
     check prevents the "running" status from clobbering "completed". */
  private applySubagentUpdate(toolId: string, update: SubagentTrackerUpdate): void {
    const msgId = this.toolToMessage.get(toolId);
    if (!msgId) return;
    const msg = this.state.messages.find(m => m.id === msgId);
    if (!msg || !msg.toolCalls) return;
    const tool = msg.toolCalls.find(t => t.id === toolId);
    if (!tool) return;

    if (update.sessionId && !tool.nestedSessionId) {
      tool.nestedSessionId = update.sessionId;
      if (tool.nestedStatus === "spawning") tool.nestedStatus = "running";
    }

    if (update.events.length > 0) {
      tool.nestedEvents = tool.nestedEvents ?? [];
      for (const e of update.events) tool.nestedEvents.push(e);
      if (tool.nestedEvents.length > NESTED_EVENTS_CAP) {
        const overflow = tool.nestedEvents.length - NESTED_EVENTS_CAP;
        tool.nestedTruncatedCount = (tool.nestedTruncatedCount ?? 0) + overflow;
        tool.nestedEvents = tool.nestedEvents.slice(overflow);
      }
    }

    if (update.toolUseUpdates) {
      for (const u of update.toolUseUpdates) {
        const entry = tool.nestedEvents?.find(
          (e): e is Extract<NestedSubagentEvent, { kind: "tool_use" }> =>
            e.kind === "tool_use" && e.id === u.id,
        );
        if (entry) {
          entry.status = u.status;
          entry.result = u.result;
          entry.isError = u.isError;
        }
      }
    }

    void this.renderer.upsertMessage(msg);
    this.onStateChangeCb();
  }

  private handleControlRequest(event: ControlRequestEvent) {
    if (this.userCancelInitiated) return;
    const approval: PendingApproval = {
      requestId: event.request_id,
      toolName: event.request.tool_name,
      toolUseId: event.request.tool_use_id,
      input: event.request.input,
      description: event.request.description,
      decisionReason: event.request.decision_reason,
      blockedPath: event.request.blocked_path,
    };
    this.state.pendingApprovals.set(event.request_id, approval);
    this.approvalArea.show(approval);
    StateEmitter.setState("needs_permission");
  }

  private handleResult(_event: ResultEvent) {
    this.state.busy = false;
    this.inputBox.setBusy(false);
    this.statusIndicator.hide();
    this.clearStreamingPointer();
    this.passStartedAt = null;
    /* Turn-end reconciliation for Task/Agent tools. If the model produced
       a final synthesis (we're in handleResult), every subagent it relied
       on must have returned a tool_result — otherwise the model couldn't
       have written the answer. In practice though, a few tool_result events
       can be missed by handleToolResult (out-of-order delivery, parser
       skipping a synthetic user envelope, a state restore mid-turn). Without
       a sweep those tools linger at status=running, leaving the Agents pill
       stuck on a non-zero count after the turn settles. Force-close them. */
    let swept = 0;
    for (const m of this.state.messages) {
      if (!m.toolCalls) continue;
      for (const t of m.toolCalls) {
        if ((t.name === "Task" || t.name === "Agent") && t.status === "running") {
          t.status = "completed";
          if (t.nestedStatus !== "completed" && t.nestedStatus !== "failed") {
            t.nestedStatus = "completed";
          }
          swept++;
        }
      }
    }
    if (swept > 0) this.refreshRunningAgentCount();
    /* Turn settled. StateEmitter auto-transitions complete -> ready after
       10s (matches the daemon's COMPLETE_TIMEOUT_S), and the animator daemon
       times ready -> idle after 60s. */
    StateEmitter.setState("complete");
    /* Do NOT use event.usage here — it sums across every API call in the
       turn (each tool round-trip counts the shared context again), inflating
       the displayed token count. handleAssistant updates the indicator
       per-call from the per-message usage, which is the correct source. */

    /* Title generation was already kicked off in submit() — it runs in
       parallel with the assistant response. Nothing to do here. */
  }

  private titleGenerationStarted = false;

  private async maybeGenerateTitle() {
    if (this.titleGenerationStarted) return;
    if (!this.plugin.settings.autoGenerateTitles) return;
    /* Only fire on the very first turn. After that the title is either the
       user's choice or a previous title-gen result — don't overwrite. */
    if (this.state.title !== "New chat" && !this.state.title.startsWith("Fork: New chat")) {
      /* If the title was set to the first-message-prefix fallback during
         submit(), regenerate it once with a proper model summary. */
      const looksLikeFallback = this.state.messages[0]?.role === "user"
        && this.state.title === this.state.messages[0].content.slice(0, 48);
      if (!looksLikeFallback) return;
    }
    const firstUser = this.state.messages.find(m => m.role === "user");
    if (!firstUser) return;
    /* Parallel-fire: title-gen kicks off from submit() the moment the user
       message exists, so the assistant response is still streaming (or hasn't
       started). Pass whatever assistant content is available — usually
       nothing yet, occasionally a partial response. The TitleGenerator falls
       back to a user-only prompt when assistantResponse is empty. */
    const firstAssistant = this.state.messages.find(m => m.role === "assistant" && m.content.trim().length > 0);
    this.titleGenerationStarted = true;
    /* Title generation is hard-pinned to Haiku 4.5. Rationale: under the
       2026-06-15 Agent SDK credit pool, every chat turn drains a $100/mo
       budget; auto-titling a tab is a one-shot summarization that Haiku
       does well at ~1/20th the per-message cost of Sonnet and ~1/100th of
       Opus. Locking the model here (rather than reading a setting) means
       the cheap path can't drift back to Sonnet/Opus through a stale
       settings file or a user typo. */
    const generated = await generateTitle({
      userMessage: firstUser.content,
      assistantResponse: firstAssistant?.content,
      claudePath: this.plugin.settings.claudePath || undefined,
      model: "claude-haiku-4-5-20251001",
      cwd: this.plugin.getVaultPath(),
    });
    if (generated) {
      this.state.title = generated;
      this.state.updatedAt = Date.now();
      this.refreshTitleBar();
      this.onStateChangeCb();
    }
  }

  private async handleError(event: ErrorEvent) {
    /* Dedup: onError (spawn failure) followed by onExit (non-zero exit code)
       used to push two error bubbles for the same underlying failure. The
       first call sets the flag; subsequent calls in the same pass no-op. */
    if (this.errorBubbleEmitted) return;
    this.errorBubbleEmitted = true;

    const errorMsg: ChatMessage = {
      id: makeMessageId(),
      role: "assistant",
      content: `**Error:** ${event.message ?? event.error ?? "Unknown error"}`,
      timestamp: Date.now(),
    };
    this.state.messages.push(errorMsg);
    /* ErrorEvent has no `isFatal` field today (see src/claude/Events.ts).
       TODO(bugfix-sweep): mid-stream non-fatal errors (transient API retries,
       partial decode failures) should NOT release busy — they should let the
       stream continue. Today, every error event clears busy because we have
       no way to distinguish. Once Agent D plumbs an isFatal/transient hint
       through ErrorEvent, gate the busy-clear on it. */
    this.state.busy = false;
    this.inputBox.setBusy(false);
    this.statusIndicator.hide();
    await this.renderer.upsertMessage(errorMsg);
  }

  private handleApproval(requestId: string, decision: ApprovalDecision) {
    if (this.userCancelInitiated) return;
    const approval = this.state.pendingApprovals.get(requestId);
    /* Order matters: bail if there's no session BEFORE removing the
       pendingApprovals entry. Otherwise a user-click during a teardown
       race silently drops the approval, the card is already gone via
       dismiss(), and the user has no way to redrive it. */
    if (!this.session) return;
    this.state.pendingApprovals.delete(requestId);
    if (decision.allowed) {
      /* Pass the original input from the request — the SDK requires
         `updatedInput` even when we're not modifying anything. */
      this.session.approve(requestId, approval?.input as Record<string, unknown> | undefined);
      /* Recovery: the assistant is about to resume running the tool, so
         flip the display back to thinking. handleResult will fire complete
         when the turn finally settles. Deny doesn't fire a recovery
         because the result event will arrive almost immediately with the
         denial outcome. */
      StateEmitter.setState("thinking");
    } else {
      this.session.deny(requestId, decision.reason);
    }
    this.onStateChangeCb();
  }

  private onExit(code: number | null, signal?: NodeJS.Signals | null) {
    if (this.userCancelInitiated) {
      /* Esc-cancel exit. Suppress the crash error and drop a soft italic
         system note so the chat doesn't end on a half-finished bubble. */
      void this.renderCancelNote();
      this.userCancelInitiated = false;
    } else if (this.state.busy) {
      /* Compose a diagnostic message. `code=null` with a signal means the
         OS killed the process (SIGTERM/SIGKILL/SIGPIPE etc.) — much more
         actionable than a bare exit code. Append the tail of stderr when
         we captured anything, that's where the CLI logs panic traces and
         model-route failures. */
      const sigSuffix = signal ? ` signal=${signal}` : "";
      const stderrSuffix = this.lastStderr.trim()
        ? `\n\n**stderr (last lines):**\n\`\`\`\n${this.lastStderr.trim().split("\n").slice(-12).join("\n")}\n\`\`\``
        : "";
      void this.handleError({
        type: "error",
        subtype: "subprocess_exit",
        message: `Claude exited (code=${code}${sigSuffix}) before completing the response.${stderrSuffix}`,
      });
    }
    this.state.busy = false;
    this.inputBox.setBusy(false);
    this.statusIndicator.hide();
    this.clearStreamingPointer();
    this.onStateChangeCb();
  }

  private async renderCancelNote() {
    const note: ChatMessage = {
      id: makeMessageId(),
      role: "assistant",
      content: "*Stopped. What would you like Claude to do instead?*",
      timestamp: Date.now(),
    };
    this.state.messages.push(note);
    await this.renderer.upsertMessage(note);
  }

  private onErrorRaw(err: Error) {
    void this.handleError({ type: "error", subtype: "spawn_error", message: err.message });
  }

  /* Tracks which message ID is the current "in-flight" assistant bubble so
     partial deltas + tool_use events can attach to it. */
  private streamingAssistantMessageId: string | null = null;

  /* Wall-clock anchor for the current assistant pass. Set on submit and
     reset after each assistant event so multi-pass turns (tool use) get
     a fresh per-pass duration. */
  private passStartedAt: number | null = null;

  /* Per-pass map of content-block index → block metadata. Used so streaming
     `input_json_delta` and `thinking_delta` events can find which tool entry
     or thinking buffer to append to. Cleared on each assistant event. */
  private streamingBlocks = new Map<number, { kind: "tool"; toolId: string; partialJson: string } | { kind: "thinking" }>();

  private getOrCreateStreamingAssistantMessage(): ChatMessage {
    if (this.streamingAssistantMessageId) {
      const existing = this.state.messages.find(m => m.id === this.streamingAssistantMessageId);
      if (existing) return existing;
    }
    const msg: ChatMessage = {
      id: makeMessageId(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      streaming: true,
    };
    this.state.messages.push(msg);
    this.streamingAssistantMessageId = msg.id;
    /* Anchor a new pass's wall-clock timer here — the first time we mint a
       fresh streaming bubble after clearStreamingPointer(). For the very
       first pass of a turn, submit() already set passStartedAt at the same
       Date.now() moment, so this is a benign overwrite. For subsequent
       passes after a tool round-trip, this is the correct anchor: it
       excludes the tool-execution wait from the assistant's "Thought for"
       elapsed time. */
    if (this.passStartedAt === null) this.passStartedAt = Date.now();
    return msg;
  }

  private clearStreamingPointer() {
    this.streamingAssistantMessageId = null;
  }

  /* Walk all messages and count Task/Agent tool calls still in flight
     (status === "running"). Cheap O(messages × toolCalls), called on every
     tool start/finish — counts grow slowly in practice so the walk is fine.
     "Task" matches Claude Code 2.1.141 and earlier; "Agent" matches 2.1.143+
     where the tool was renamed. */
  private refreshRunningAgentCount(): void {
    let running = 0;
    for (const m of this.state.messages) {
      if (!m.toolCalls) continue;
      for (const t of m.toolCalls) {
        if ((t.name === "Task" || t.name === "Agent") && t.status === "running") {
          running++;
        }
      }
    }
    this.inputBox.setRunningAgentCount(running);
  }

  /* Best-effort vault-path resolution for items dropped from the Obsidian
     file explorer. Tries the path as-is first (full vault path from a file
     drag), then a wikilink-style resolution for bare names (handles drags
     of a [[Note]]). Returns true when a vault item was found and pinned —
     the InputBox uses this to decide whether to skip its text-insert
     fallback. The pill bar handles file-vs-folder rendering via its own
     vault lookup, so this method doesn't need to distinguish kinds. */
  private tryPinVaultPath(path: string): boolean {
    const direct = this.app.vault.getAbstractFileByPath(path);
    if (direct instanceof TFile || direct instanceof TFolder) {
      this.activeFileIndicator.addPinnedPath(direct.path);
      return true;
    }
    /* Wikilink fallback: resolve bare note names like "MyNote" against the
       metadata cache. Sources from the active file's path so relative
       resolution works the same as Obsidian's built-in link resolution. */
    const activePath = this.app.workspace.getActiveFile()?.path ?? "";
    const dest = this.app.metadataCache.getFirstLinkpathDest(path, activePath);
    if (dest) {
      this.activeFileIndicator.addPinnedPath(dest.path);
      return true;
    }
    return false;
  }

  /* Reads Obsidian's internal drag state. The file-explorer drag populates
     `app.dragManager.draggable` with the dragged TFile/TFolder (or a
     `files` array for multi-select) but typically leaves the HTML5
     dataTransfer empty, so this is the only reliable way to detect that
     a vault drag is in flight from inside our dragover/drop handlers. The
     `dragManager` field is internal (not in the public Obsidian d.ts), so
     we narrow through `unknown` rather than reaching for `any`. */
  private readDragManagerItems(): Array<TFile | TFolder> {
    const dm = (this.app as unknown as {
      dragManager?: {
        draggable?: {
          file?: unknown;
          files?: unknown[];
          source?: unknown;
          type?: unknown;
        };
      };
    }).dragManager;
    const draggable = dm?.draggable;
    if (!draggable) return [];
    const collected: Array<TFile | TFolder> = [];
    if (draggable.file instanceof TFile || draggable.file instanceof TFolder) {
      collected.push(draggable.file);
    }
    if (Array.isArray(draggable.files)) {
      for (const f of draggable.files) {
        if (f instanceof TFile || f instanceof TFolder) collected.push(f);
      }
    }
    return collected;
  }

  private isVaultDragActive(): boolean {
    return this.readDragManagerItems().length > 0;
  }

  /* Consumes the active Obsidian drag (if any) by pinning every dragged
     TFile/TFolder. Returns true when at least one item was pinned so the
     InputBox knows to skip its text/plain fallback. Files and folders both
     route through the same pin call — ActiveFileIndicator picks the icon
     and color per item via its own vault lookup. */
  private tryConsumeVaultDrag(): boolean {
    const items = this.readDragManagerItems();
    if (items.length === 0) return false;
    for (const item of items) {
      this.activeFileIndicator.addPinnedPath(item.path);
    }
    return true;
  }

  /* Rank vault files AND folders for an @-mention query. Simple heuristic:
     prefer basename matches over path matches, then prefer prefix matches
     over substring matches. Cap at 20 results. Claude Code understands
     `@<path>` references natively for files (the CLI expands them into file
     content); folders are routed to onPinFolder instead and become pinned
     pills rather than text references. */
  private queryFileSuggestions(query: string): Suggestion[] {
    const q = query.toLowerCase();
    type Scored = { kind: "file" | "folder"; path: string; name: string; mtime: number; ext: string; score: number };
    const scored: Scored[] = [];

    const scoreOf = (name: string, path: string, mtime: number): number => {
      const base = name.toLowerCase();
      const lpath = path.toLowerCase();
      if (q.length === 0) return mtime;
      if (base.startsWith(q)) return 1000 - path.length;
      if (base.includes(q)) return 800 - path.length;
      if (lpath.includes(q)) return 400 - path.length;
      return -1;
    };

    for (const f of this.app.vault.getFiles()) {
      const score = scoreOf(f.basename, f.path, f.stat.mtime);
      if (score >= 0) scored.push({
        kind: "file", path: f.path, name: f.basename, mtime: f.stat.mtime, ext: f.extension, score,
      });
    }
    /* Walk every folder. The vault root is named "" — skip it so the user
       can't pin "the entire vault" by accident. Folder mtime isn't directly
       exposed, so use 0 as a neutral sort key when the query is empty
       (folders bunch at the bottom of the empty-query list, which matches
       Obsidian's quick-switcher behavior). */
    const walkFolders = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          if (child.path !== "" && child.path !== "/") {
            const score = scoreOf(child.name, child.path, 0);
            if (score >= 0) scored.push({
              kind: "folder", path: child.path, name: child.name, mtime: 0, ext: "", score,
            });
          }
          walkFolders(child);
        }
      }
    };
    walkFolders(this.app.vault.getRoot());

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 20).map((s): Suggestion => s.kind === "folder"
      ? {
          id: s.path,
          primary: s.name,
          secondary: s.path,
          icon: "folder",
          /* `insert` is unused for folders (acceptSuggestion routes them to
             onPinFolder) but kept non-empty so it's safe if the callback is
             absent and we fall back to text insertion. */
          insert: `@${s.path}`,
          kind: "folder",
        }
      : {
          id: s.path,
          primary: s.name,
          secondary: s.path,
          icon: s.ext === "md" ? "file-text" : "file",
          insert: `@${s.path}`,
          kind: "file",
        });
  }

  /* Slash-command palette. Four sources merged:

     1. Plugin-side commands (/clear, /help) — handled in handlePluginSlashCommand
        before the message ever reaches the subprocess.
     2. Disk-discovered skills + slash commands (plugin.skillCatalog) — populated
        at plugin load by scanning ~/.claude, the vault, and installed plugin
        dirs. Available immediately, before any subprocess spawn.
     3. Skills the CLI announced on init — supersedes (2) once the first
        message has been sent and we know exactly what's loaded.
     4. CLI slash commands announced on init — built-ins (init, review, …) plus
        anything (1)–(3) didn't already cover.

     Skills get a sparkles icon, CLI commands a terminal icon. Plugin commands
     and CLI built-ins de-dup against the dynamic lists by name. */
  private querySlashCommands(query: string): Suggestion[] {
    type Cmd = { cmd: string; desc: string; insert?: string; icon: string };
    const pluginCmds: Cmd[] = [
      { cmd: "/clear", desc: "Reset this tab — start a fresh Claude session", icon: "rotate-ccw" },
      { cmd: "/help",  desc: "Show plugin slash-command help", icon: "circle-help" },
      { cmd: "/agent", desc: "Launch a subagent (Task tool) — pick from the discovered catalog", icon: "users", insert: "/agent " },
    ];

    /* Per-agent entries so power users can fuzzy-match directly to a named
       subagent. Inserted as `/agent <name>` so submit() routes them through
       handlePluginSlashCommand below. */
    const agentCmds: Cmd[] = this.plugin.subagentCatalog.agents.map(a => ({
      cmd: `/agent ${a.name}`,
      desc: a.description ?? `${a.source} subagent`,
      icon: "users",
      insert: `/agent ${a.name}`,
    }));

    const pluginNameSet = new Set(pluginCmds.map(c => c.cmd.slice(1)));
    const seen = new Set<string>(pluginNameSet);
    /* Block raw subagent names from being shadowed by skill/builtin entries
       of the same name. The agent entries themselves carry the `/agent `
       prefix so they don't collide with anything else, but we add their
       bare names to the seen set as a courtesy in case someone names an
       agent "clear" or similar. */
    for (const a of this.plugin.subagentCatalog.agents) seen.add(`agent ${a.name}`);

    /* CLI init takes priority over disk-discovered list when present —
       it's the ground truth for what's loaded right now. */
    const initSkills = this.state.availableSkills;
    const initSlash  = this.state.availableSlashCommands;
    const catalog = this.plugin.skillCatalog;

    const skillCmds: Cmd[] = [];
    if (initSkills && initSkills.length > 0) {
      for (const name of initSkills) {
        if (seen.has(name)) continue;
        seen.add(name);
        const fromCatalog = catalog.skills.find(s => s.name === name);
        skillCmds.push({
          cmd: `/${name}`,
          desc: fromCatalog?.description ?? "Skill — auto-invoked via the Skill tool",
          icon: "sparkles",
        });
      }
    } else {
      for (const skill of catalog.skills) {
        if (seen.has(skill.name)) continue;
        seen.add(skill.name);
        skillCmds.push({
          cmd: `/${skill.name}`,
          desc: skill.description ?? "Skill — auto-invoked via the Skill tool",
          icon: "sparkles",
        });
      }
    }

    const builtinCmds: Cmd[] = [];
    if (initSlash && initSlash.length > 0) {
      for (const name of initSlash) {
        if (seen.has(name)) continue;
        seen.add(name);
        const fromCatalog = catalog.commands.find(c => c.name === name);
        builtinCmds.push({
          cmd: `/${name}`,
          desc: fromCatalog?.description ?? "Claude Code slash command",
          icon: "terminal",
        });
      }
    } else {
      for (const cmd of catalog.commands) {
        if (seen.has(cmd.name)) continue;
        seen.add(cmd.name);
        builtinCmds.push({
          cmd: `/${cmd.name}`,
          desc: cmd.description ?? "Claude Code slash command",
          icon: "terminal",
        });
      }
    }

    const commands = [...pluginCmds, ...agentCmds, ...skillCmds, ...builtinCmds];
    const q = query.toLowerCase();
    return commands
      .filter(c => c.cmd.slice(1).toLowerCase().includes(q))
      .sort((a, b) => {
        const ap = a.cmd.slice(1).toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.cmd.slice(1).toLowerCase().startsWith(q) ? 0 : 1;
        return ap - bp;
      })
      .slice(0, 50)
      .map(c => ({
        id: c.cmd,
        primary: c.cmd,
        secondary: c.desc,
        icon: c.icon,
        insert: c.insert ?? c.cmd,
      }));
  }

  private flattenContent(content: string | ContentBlock[]): string {
    if (typeof content === "string") return content;
    return content
      .map(b => (b.type === "text" ? b.text : `[${b.type} block]`))
      .join("");
  }
}

/* ---- Selection prompt formatting ---------------------------------------- */

function lineRangeLabel(sel: ActiveSelection): string {
  return sel.startLine === sel.endLine ? `line ${sel.startLine}` : `lines ${sel.startLine}–${sel.endLine}`;
}

function fenceLanguageFor(filePath: string): string {
  const ext = filePath.split(".").pop() ?? "";
  if (!ext || ext === filePath) return "";
  return ext;
}

/* Full prompt sent to Claude: fenced selection text labeled with file +
   line range, followed by the user's question. The fence language is the
   file extension so syntax highlighting renders correctly if Claude's reply
   echoes the snippet. The display layer renders just the line-range flag
   above the user bubble — see MessageRenderer.renderSelectionFlag. */
function formatSelectionForPrompt(sel: ActiveSelection, userText: string): string {
  const lang = fenceLanguageFor(sel.filePath);
  const fence = lang ? `\`\`\`${lang}` : "```";
  const block = `**Selected from \`${sel.filePath}\` (${lineRangeLabel(sel)}):**\n${fence}\n${sel.text}\n\`\`\``;
  return userText ? `${block}\n\n${userText}` : block;
}
