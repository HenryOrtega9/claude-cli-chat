import { Notice, TFile, TFolder, type App, type Component, type EventRef } from "obsidian";
import { MessageListRenderer } from "./MessageRenderer";
import { ApprovalArea, type ApprovalDecision } from "./ApprovalModal";
import { InputBox, extractObsidianUrlPaths, type SubmitPayload, type Suggestion } from "./InputBox";
import { renderWelcome, setWelcomeVisible } from "./Welcome";
import { RemotePairingCard } from "./RemotePairingCard";
import { StatusIndicator } from "./StatusIndicator";
import { SearchBar } from "./SearchBar";
import { ActiveFileIndicator } from "./ActiveFileIndicator";
import { SelectionTracker, type ActiveSelection } from "./SelectionTracker";
import { makeMessageId, makeTabState, NESTED_EVENTS_CAP, type ChatMessage, type TabState, type PendingApproval, type ToolCall, type NestedSubagentEvent } from "./state";
import { spawnOptionsFromSettings, type TabSession } from "../claude/SubprocessManager";
import { resolveModelId, trustedFolderAllowPatterns, effortLevelsForModel, MODEL_IDS, EFFORT_ORDER, PERMISSION_MODE_ORDER, type ModelKey, type EffortLevel, type PermissionMode, type EnvSnippet, type TrustedFolder } from "../settings";
import { PermissionsConfigStore } from "../permissions/PermissionsConfig";
import { RemoteControlSession, sessionFilePathFor, projectDirFor } from "../claude/RemoteControlSession";
import { rm } from "node:fs/promises";
import { JsonlTailer } from "../claude/JsonlTailer";
import { SubagentSessionTracker, type SubagentTrackerUpdate } from "../claude/SubagentSessionTracker";
import { generateTitle } from "../claude/TitleGenerator";
import { MCPConfigStore, sanitizeMcpServerName } from "../mcp/MCPConfig";
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
  RateLimitEvent,
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
  /* Session ids this tab has used while incognito. `--no-session-persistence`
     suppresses the transcript but the CLI still writes a one-line `ai-title`
     record (and any subagent session files) keyed by session id. We delete
     those on teardown so an incognito tab truly leaves nothing on disk. Only
     ever holds ids belonging to THIS tab, so deletion never touches another
     tab's files in the shared project dir. */
  private incognitoSessionIds = new Set<string>();
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

  /* Cached @-mention index: a flat snapshot of every vault file and folder.
     Built lazily on first use and invalidated on vault create/delete/rename so
     queryFileSuggestions doesn't re-walk the whole vault tree and re-allocate
     N entries on every keystroke. Scoring and sorting still run per query; only
     the O(N) enumeration is memoized. File mtime is snapshotted too, so the
     empty-query "recently modified" ordering can lag a content edit until the
     next structural change — an accepted trade for the typing-latency win. */
  private mentionIndex: Array<{ kind: "file" | "folder"; path: string; name: string; mtime: number; ext: string }> | null = null;
  private mentionIndexRefs: EventRef[] = [];

  /* Unsubscribe for the SpeechController playback listener that drives the
     composer's speaking indicator. Torn down in destroy(). */
  private speechUnsub: (() => void) | null = null;

  /* Optional fork handler — provided by ClaudeChatView so the controller can
     ask the view to create a new tab branching from a given message id. */
  onForkRequest?: (sourceTab: TabController, messageId: string) => void;
  /* Set by the view. Fired when the user toggles incognito on a still-empty
     tab so the view can reconcile disk state (delete any persisted file when
     turning on, resume persistence when turning off). */
  onIncognitoToggle?: (tabId: string, incognito: boolean) => void;

  /* Set to true while teardownSession() is executing so re-entrant callers
     (e.g. an onExit firing mid-dispose) don't double-dispose. */
  private tearingDown = false;

  /* In-flight teardown started by restartSubprocess() (fire-and-forget so the
     picker callback stays sync). ensureSession() awaits this before spawning
     so a model/effort/mode change followed by a quick submit can't race the
     not-yet-exited subprocess: spawn() returns a still-"running" session if
     the old process hasn't died, reusing the stale model and double-binding
     listeners. Awaiting the dispose closes that ~2s window. */
  private pendingRestartTeardown: Promise<void> | null = null;

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

    /* Invalidate the cached @-mention index when the vault tree changes. Torn
       down in destroy() via offref so the listeners don't outlive the tab.
       Content "modify" is intentionally not watched — it would rebuild the
       index mid-edit and defeat the cache; only structural changes matter. */
    const invalidateMentionIndex = () => { this.mentionIndex = null; };
    this.mentionIndexRefs.push(
      this.app.vault.on("create", invalidateMentionIndex),
      this.app.vault.on("delete", invalidateMentionIndex),
      this.app.vault.on("rename", invalidateMentionIndex),
    );

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
        onIncognitoChange: incognito => this.handleIncognitoChange(incognito),
        onVoiceChange: voice => this.handleVoiceChange(voice),
        onVoicePauseToggle: () => this.handleVoicePauseToggle(),
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
        onListTrustedFolders: () => this.plugin.settings.trustedFolders ?? [],
        onToggleTrustedFolder: (path, enabled) => void this.toggleTrustedFolder(path, enabled),
        onAddTrustedFolder: path => void this.addTrustedFolder(path),
        onRemoveTrustedFolder: path => void this.removeTrustedFolder(path),
      },
      {
        model: (this.state.model as ModelKey | undefined) ?? this.plugin.settings.defaultModel,
        effort: (this.state.effort as EffortLevel | undefined) ?? this.plugin.settings.defaultEffort,
        permissionMode: (this.state.permissionMode as PermissionMode | undefined) ?? this.plugin.settings.permissionMode,
        incognito: this.state.incognito,
        /* Undefined = tab predates voice mode or is brand new; seed from the
           plugin default. Written back so pill and state can't disagree. */
        voice: this.state.voiceEnabled ?? this.plugin.settings.voiceDefaultOn,
      }
    );
    /* Symmetric write-back: pin the seeded value (true OR false) so a later
       change to voiceDefaultOn can't retroactively flip a tab the user
       never touched. Persists on the tab's next state change. */
    if (this.state.voiceEnabled === undefined) {
      this.state.voiceEnabled = this.plugin.settings.voiceDefaultOn;
    }
    /* Keep the speaking indicator + play/pause icon in lockstep with actual
       playback. Speech is a plugin-wide singleton, so every tab hears every
       transition; each just repaints its own composer from the live state. */
    this.speechUnsub = this.plugin.speech.onStateChange(() => {
      this.inputBox.setVoiceSpeaking(this.plugin.speech.isSpeaking());
      this.inputBox.setVoicePaused(this.plugin.speech.isPaused());
    });
    /* Lock the incognito choice if this tab already has history or a session
       (e.g. restored from disk, or forked). The --no-session-persistence flag
       can only be applied at spawn time, so it can't change retroactively. */
    if (this.state.messages.length > 0 || this.state.sessionId !== null) {
      this.inputBox.setIncognitoLocked(true);
    }

    /* Whole-tab drop zone. The InputBox wrapper handles drops on itself;
       this catches drops anywhere else in the chat (title bar, message
       list, welcome screen) so "drag a note into the chat window" works
       without needing to hit the input box. Only engages for Obsidian
       vault drags and OS file drags — plain text drags keep their default
       behavior. The InputBox's own handler runs first (deeper target) and
       preventDefaults what it consumes, so `defaultPrevented` is the
       no-double-handling guard. */
    const rootDragHasPayload = (e: DragEvent) =>
      this.isVaultDragActive() ||
      (!!e.dataTransfer && Array.from(e.dataTransfer.types ?? []).includes("Files"));
    this.root.addEventListener("dragover", e => {
      if (e.defaultPrevented) return;
      if (rootDragHasPayload(e)) {
        e.preventDefault();
        this.root.addClass("is-drop-target");
      }
    });
    this.root.addEventListener("dragleave", e => {
      const related = e.relatedTarget as Node | null;
      if (!related || !this.root.contains(related)) {
        this.root.removeClass("is-drop-target");
      }
    });
    this.root.addEventListener("drop", e => {
      this.root.removeClass("is-drop-target");
      if (e.defaultPrevented) return;
      const dt = e.dataTransfer;
      if (!dt) return;
      const hasOsFiles = Array.from(dt.types ?? []).includes("Files");
      if (!this.isVaultDragActive() && !hasOsFiles) return;
      /* Swallow the drop so Electron doesn't navigate to a dropped file://
         URL and Obsidian's leaf handler doesn't try to open the note over
         the chat view. */
      e.preventDefault();
      if (this.tryConsumeVaultDrag()) return;
      const files = Array.from(dt.files ?? []);
      if (files.length > 0) {
        this.inputBox.ingestDroppedFiles(files);
        return;
      }
      /* Drag sources that populate neither dragManager file fields nor
         dt.files still put obsidian://open URLs on text/plain. */
      for (const p of extractObsidianUrlPaths(dt.getData("text/plain"))) {
        this.tryPinVaultPath(p);
      }
    });
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
  /* True once destroy() has started. Late async continuations (title-gen
     resolving, a submit suspended on a restart teardown) check this so they
     don't resurrect a deleted conversation on disk or spawn a subprocess for
     a dead tab. */
  private destroyed = false;
  isDestroyed(): boolean { return this.destroyed; }

  /* Sticky-pinned office files (.docx/.xlsx/.pptx) get fully re-extracted
     and re-inlined into wireText on every submit unless we dedupe: unlike
     @-ref pins (cheap references the CLI/model already has from turn 1),
     office content is inlined plugin-side, so re-sending it every turn is
     pure unbounded context growth. Tracks path -> the vault mtime at the
     moment we last inlined it; a submit skips re-inlining a sticky office
     pin whose mtime hasn't changed since. Cleared whenever a session spawns
     without a `--resume` (a genuinely fresh CLI context that has never seen
     this file), so it never causes an under-send. */
  private sentOfficePaths = new Map<string, number>();

  private officeFileMtime(path: string): number | undefined {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file.stat.mtime : undefined;
  }
  async destroy(): Promise<void> {
    this.destroyed = true;
    /* Closing a voice tab mid-narration silences it. Channel-scoped, so a
       sibling voice tab or an in-flight note read plays on untouched. */
    if (this.voiceOn()) {
      this.plugin.speech.stop(this.state.id);
      this.plugin.speech.forgetChannel(this.state.id);
    }
    this.speechUnsub?.();
    this.speechUnsub = null;
    /* Unregister BEFORE disposing so the manager's onExit callback doesn't
       race against our own teardown. teardownSession() awaits SIGTERM and
       the eventual process-exit. */
    if (this.remoteSession) this.plugin.subprocessManager.unregisterRemote(this.state.id);
    for (const ref of this.mentionIndexRefs) this.app.vault.offref(ref);
    this.mentionIndexRefs = [];
    await this.teardownSession("destroy");
    const remoteWork = this.remoteSession ? [this.remoteSession.dispose()] : [];
    const tailerWork = this.jsonlTailer ? [this.jsonlTailer.stop()] : [];
    this.statusIndicator.destroy();
    this.activeFileIndicator.destroy();
    this.selectionTracker.destroy();
    this.searchBar.destroy();
    this.renderer.destroy();
    this.inputBox.destroy();
    this.root.remove();
    await Promise.all([...remoteWork, ...tailerWork]);
  }

  async switchMode(mode: TabMode): Promise<void> {
    if (this.mode === mode) return;
    /* Remote Control tails the session JSONL, which an incognito tab never
       writes (--no-session-persistence). Block the switch rather than start a
       remote session that can never receive events. */
    if (mode === "remote" && this.state.incognito) {
      new Notice("Incognito chats are local-only — Remote Control needs the session file that incognito disables.", 6000);
      return;
    }
    /* eslint-disable no-console */
    console.log(`[claude-cli-chat] switchMode tab=${this.state.id} ${this.mode} -> ${mode}`);

    /* Tear down whatever is currently active. */
    if (this.mode === "local") {
      const wasBusy = this.state.busy;
      await this.teardownSession("switch");
      /* "switch" deliberately skips teardownSession's busy reset so the next
         mode owns the flag — but a turn that was streaming when the user
         flipped the toggle just got killed, and nothing on the remote side
         will ever emit its result event. Without this epilogue the tab badge
         stays streaming, the thinking pill spins until its watchdog, and the
         composer comes back disabled after switching home. Mirror the
         cancel path's abort handling. */
      if (wasBusy) {
        this.reconcileAbortedTurn();
        this.state.busy = false;
        this.inputBox.setBusy(false);
        this.statusIndicator.hide();
        this.approvalArea.dismissAll();
        /* dismissAll only removes the card from the DOM. Every OTHER abort
           path (cancel/restart/clear/destroy) also clears the underlying
           map; "switch" doesn't get that for free from teardownSession
           (its reason gate deliberately excludes "switch" — see the reason
           list a few methods down), so without this the entry lingers in
           state.pendingApprovals forever. hasPendingApprovals() (which
           drives the tab bar's "needs approval" badge) would then report a
           phantom pending approval indefinitely, since the card that would
           let the user act on it is already gone. */
        this.state.pendingApprovals.clear();
        StateEmitter.setState("ready");
      }
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
      if (s && reason === "restart") {
        /* A control_request can be in flight when the user flips the model/
           effort/permission-mode pill (setBusy only disables Send, not the
           pills). The fresh subprocess knows nothing about the old request,
           so deny it best-effort BEFORE dispose (the denial rides the write
           chain that closeStdin flushes). Without this the entry ghosts in
           pendingApprovals forever: hasPendingApprovals() keeps the tab
           badge lit and the orphaned card's Allow/Deny no-op against the
           nulled session. */
        for (const requestId of Array.from(this.state.pendingApprovals.keys())) {
          try { s.deny(requestId, "Session restarted"); } catch { /* ignore — best-effort */ }
        }
      }
      if (s) {
        try { await s.dispose(); } catch { /* ignore — already exited or never spawned */ }
      }
      if (reason === "restart") {
        this.state.pendingApprovals.clear();
      }
      /* The CLI writes an `ai-title` residue file even under
         --no-session-persistence. Once the process has exited (dispose above
         awaited it), purge this incognito tab's session files. Only on
         terminal teardowns — "restart"/"cancel"/"switch" keep chatting and
         the residue is cleaned on the eventual destroy/clear. */
      if (this.state.incognito && (reason === "destroy" || reason === "clear")) {
        await this.cleanupIncognitoSessionFiles();
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
      if (reason === "cancel" || reason === "restart" || reason === "clear" || reason === "destroy") {
        this.approvalArea.dismissAll();
      }
    } finally {
      this.tearingDown = false;
    }
  }

  /* Delete every on-disk file the CLI wrote for this incognito tab's sessions:
     the per-session `<id>.jsonl` (which holds the ai-title) and the `<id>/`
     subdirectory (subagent transcripts). Best-effort and idempotent — rm with
     `force` never throws on a missing path. Only this tab's session ids are in
     the set, so we never touch another tab's files in the shared project dir. */
  private async cleanupIncognitoSessionFiles(): Promise<void> {
    if (this.incognitoSessionIds.size === 0) return;
    const cwd = this.plugin.getVaultPath();
    const ids = Array.from(this.incognitoSessionIds);
    this.incognitoSessionIds.clear();
    const work: Promise<unknown>[] = [];
    for (const id of ids) {
      work.push(rm(sessionFilePathFor(cwd, id), { force: true }).catch(() => {}));
      work.push(rm(`${projectDirFor(cwd)}/${id}`, { force: true, recursive: true }).catch(() => {}));
    }
    await Promise.all(work);
  }

  /* Reload the cost-surface pill: count pinned files for this tab and read
     MCP server config (both enabled and disabled) from
     <vault>/.claude/mcp.json. Public so the parent view can re-trigger
     after the MCP manager modal closes (which may have added/removed
     servers). Pin changes call this from the indicator callback directly.

     Tool lists come from the most recent init event's tool catalog,
     stashed on state.mcpToolsByServer. Until this tab's first init
     arrives (brand-new tab, post-/clear before the next spawn), the
     plugin-level mcpToolCache — last-known lists from any prior init,
     persisted across reloads — fills in so the pill shows "(N tools)"
     from the start instead of a bare server count.

     Errors swallowed because this is a UI hint, not load-bearing — the
     chat works regardless of whether the pill is accurate. */
  public async refreshCostSurface(): Promise<void> {
    const pinCount = (this.state.pinnedFilePaths ?? []).length;
    let mcpServers: Array<{ name: string; enabled: boolean; tools: string[] }> = [];
    try {
      const disabled = new Set(await new MCPConfigStore(this.app).getDisabledServerNames());
      const toolMap = this.state.mcpToolsByServer ?? {};
      const cachedMap = this.plugin.settings.mcpToolCache;
      /* Authoritative server set from the CLI (cached). Tool counts come from
         this tab's init event, falling back to the persisted cache, keyed by
         the sanitized server name. A disabled server is denied at spawn, so
         its tools never arrive — show it with an empty list regardless. */
      const list = await this.plugin.getMcpServers().catch(() => []);
      if (list.length > 0) {
        mcpServers = list.map(s => {
          const enabled = !disabled.has(s.name);
          const sid = sanitizeMcpServerName(s.name);
          return {
            name: s.name,
            enabled,
            tools: enabled ? (toolMap[sid] ?? cachedMap[sid] ?? []) : [],
          };
        });
        /* This list is authoritative and non-empty — positive confirmation
           of which servers currently exist. Prune the persisted cache of
           anything else, so a server removed outside the plugin doesn't
           leave a stale entry that could resurface on a future transient
           list failure (see pruneMcpToolCache's own comment). */
        void this.plugin.pruneMcpToolCache(new Set(list.map(s => sanitizeMcpServerName(s.name))));
      } else {
        /* No list yet (CLI slow/unavailable). Fall back to whatever the
           runtime announced (this tab's init tool map), topped up with the
           persisted cache for servers no init has reported yet, plus the
           disabled names so they stay visible and re-enableable. */
        const runtimeAndCached = { ...cachedMap, ...toolMap };
        /* disabled holds display names; the map keys are sanitized ids.
           Compare in sanitized space so a cached entry for a now-disabled
           server doesn't resurface as enabled. */
        const disabledSids = new Set(Array.from(disabled).map(sanitizeMcpServerName));
        const fromRuntime = Object.keys(runtimeAndCached)
          .filter(sid => !disabledSids.has(sid))
          .map(sid => ({ name: sid, enabled: true, tools: runtimeAndCached[sid] }));
        const fromDisabled = Array.from(disabled).map(name => ({ name, enabled: false, tools: [] as string[] }));
        mcpServers = [...fromRuntime, ...fromDisabled];
      }
    } catch {
      /* ignore — leave mcpServers empty */
    }
    this.inputBox.setCostSurface({
      pinCount,
      mcpServers,
    });
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
    if (this.voiceOn()) {
      this.plugin.speech.stop(this.state.id);
      this.plugin.speech.forgetChannel(this.state.id);
    }
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
    /* Esc kills the turn — kill this tab's narration of it too, and drop
       its stream offsets (the turn is dead; nothing will finalize them). */
    if (this.voiceOn()) {
      this.plugin.speech.stop(this.state.id);
      this.plugin.speech.forgetChannel(this.state.id);
    }
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
    /* teardownSession no-ops behind its re-entrancy guard when another
       teardown (e.g. a model-change restart) is already in flight, leaving
       its busy-reset tail unrun. Reset unconditionally so Esc always
       re-enables the composer; idempotent when the teardown did run. */
    this.state.busy = false;
    this.inputBox.setBusy(false);
    /* The subprocess just died, so any still-running tool will never receive a
       tool_result — stop its subagent tracker and flip its row to errored (else
       it spins forever and the Agents pill's running counter sticks). Shared
       with the handleError / onExit abort paths. */
    this.reconcileAbortedTurn();
    this.statusIndicator.hide();
    /* Cancel leaves the last emitted device state as a held one (thinking /
       needs_permission), whose 5s heartbeat would otherwise re-assert that app
       on the TC001 forever. Drop back to ready, mirroring clearConversation. */
    StateEmitter.setState("ready");
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

  private async ensureSession(): Promise<TabSession> {
    /* Treat "error" as terminal alongside "exited": a spawn-level failure
       (ENOENT/EACCES) leaves the session in status "error" with no 'exit'
       event ever firing, so reusing it here would permanently brick the tab.
       Falling through lets ensureSession() spawn a fresh session, mirroring
       SubprocessManager.spawn's matching reuse guard. */
    if (this.session && this.session.status !== "exited" && this.session.status !== "error") return this.session;
    /* Await any in-flight restart teardown so the old subprocess has fully
       exited (and been dropped from SubprocessManager's session map) before we
       spawn. Otherwise spawn() finds the not-yet-exited session and returns it
       on the OLD model, and we'd re-bind listeners onto a stale session. */
    if (this.pendingRestartTeardown) {
      const pending = this.pendingRestartTeardown;
      this.pendingRestartTeardown = null;
      await pending;
    }
    const cwd = this.plugin.getVaultPath();
    /* Validate persisted enum fields before trusting them. On disk these are
       `string | undefined`, so a hand-edited file or a key removed in a later
       plugin version would otherwise cast straight through — an unknown model
       key makes resolveModelId() return undefined and the CLI silently spawns
       on its default model. Fall back to the configured default whenever the
       stored value isn't a currently-known key. */
    const sm = this.state.model;
    const modelKey: ModelKey = sm !== undefined && Object.prototype.hasOwnProperty.call(MODEL_IDS, sm)
      ? (sm as ModelKey)
      : this.plugin.settings.defaultModel;
    const se = this.state.effort;
    let effortKey: EffortLevel = se !== undefined && (EFFORT_ORDER as readonly string[]).includes(se)
      ? (se as EffortLevel)
      : this.plugin.settings.defaultEffort;
    /* Clamp effort against the resolved model. The pill UI demotes xhigh on
       model switch, but the settings tab's default-effort dropdown and env
       snippets can pair xhigh with a non-1M model, and that combo would
       otherwise reach the CLI as an `--effort` it rejects. Mirror
       InputBox.selectModel's demotion target (high). */
    if (!effortLevelsForModel(modelKey).includes(effortKey)) {
      effortKey = "high";
    }
    const spm = this.state.permissionMode;
    const modeKey: PermissionMode = spm !== undefined && (PERMISSION_MODE_ORDER as readonly string[]).includes(spm)
      ? (spm as PermissionMode)
      : this.plugin.settings.permissionMode;
    /* If a snippet is applied, look it up at spawn time so edits to the
       snippet's systemPromptAddendum take effect on the next restart. */
    const snippet = this.state.envSnippetId
      ? this.plugin.settings.envSnippets.find(s => s.id === this.state.envSnippetId)
      : undefined;
    /* Compose the vault-wide addendum (always applies in this vault) with the
       per-tab snippet addendum (overlay) and the trusted-folders hint. Any
       of the three may be empty. Trusted-folders hint is gated by the
       trustedFoldersInSystemPrompt setting (default on); it lists only
       enabled entries so disabled-but-remembered folders don't leak into
       discoverability. The hint is read-only discovery context — actual
       permission to read those paths comes from .claude/settings.json's
       allowlist, written when the user toggled the folder on. */
    const vaultAddendum = (this.plugin.settings.vaultSystemPromptAddendum ?? "").trim();
    const snippetAddendum = (snippet?.systemPromptAddendum ?? "").trim();
    const trustedAddendum = this.buildTrustedFoldersAddendum();
    /* Always-on voice guidance. Field-tested failure (2026-07-18): asked in
       chat to "read a note aloud", the model ran `say` via its Bash tool —
       an audio stream the plugin can't pause, stop, or even see, which
       overlapped the plugin's own voice mode as two simultaneous voices.
       Baked in unconditionally (not gated on the Voice pill) because the
       pill can flip mid-session while the system prompt is spawn-time. */
    const voiceAddendum =
      "Audio output: this chat UI has a built-in voice mode that reads your responses aloud, plus a " +
      "\"Read note aloud\" command, both with proper pause/stop controls. NEVER run `say`, `afplay`, " +
      "`osascript` speech, or any other command that produces spoken audio — the UI cannot pause or stop " +
      "that audio, and it overlaps voice mode as a second voice. If asked to read something aloud, put the " +
      "text in your response (voice mode speaks it), or point the user to the Voice pill / \"Read note aloud\" " +
      "command. Only produce audio files/commands if the user explicitly wants an audio artifact.";
    const composedAddendum =
      [vaultAddendum, snippetAddendum, trustedAddendum, voiceAddendum].filter(s => s.length > 0).join("\n\n") || undefined;
    /* Incognito sessions are never persisted, so `--resume` would point at a
       transcript that doesn't exist. On respawn (model/effort/mode change)
       start a fresh session instead — context is lost, which is the accepted
       incognito trade-off, rather than attempting a doomed resume. */
    const resumeId = this.state.incognito ? undefined : (this.state.sessionId ?? undefined);
    /* No resumeId means the CLI starts with a genuinely blank transcript —
       any sticky office file we'd previously deduped against is no longer
       actually in its context, so the dedup tracker must reset or the next
       submit would wrongly skip re-sending it. A resumed session keeps the
       tracker as-is since the CLI's own transcript still has that content. */
    if (resumeId === undefined) this.sentOfficePaths.clear();
    const opts = spawnOptionsFromSettings(this.plugin.settings, cwd, resumeId, {
      model: resolveModelId(modelKey),
      effort: effortKey,
      permissionMode: modeKey,
      appendSystemPrompt: composedAddendum,
      noSessionPersistence: this.state.incognito,
      /* Per-vault MCP disables, read from the plugin's in-memory cache (kept
         fresh by refreshMcpDenyPatterns on every toggle). Empty unless the
         user switched a server off in the MCP manager. */
      mcpDenyPatterns: this.plugin.mcpDenyPatterns,
    });
    this.session = this.plugin.subprocessManager.spawn(this.state.id, opts);
    /* The incognito decision is now baked into the live subprocess — lock the
       pill so it can't change for the rest of this tab's life. */
    this.inputBox.setIncognitoLocked(true);
    /* Identity-guard every listener: teardownSession nulls this.session
       BEFORE disposing, so events/exits from a session this tab has moved
       past must not reach the live handlers. Without the guard, the old idle
       process's SIGTERM exit lands while a restarted turn is already busy and
       renders as a spurious "Claude exited" crash bubble. Exception: the
       Esc-cancel exit must still route through — onExit owns rendering the
       cancel note and resetting userCancelInitiated. */
    const s = this.session;
    s.onEvent(e => { if (this.session === s) void this.onEvent(e); });
    s.onExit((code, signal) => {
      if (this.session !== s && !this.userCancelInitiated) return;
      this.onExit(code, signal);
    });
    s.onError(err => { if (this.session === s) this.onErrorRaw(err); });
    /* Buffer the most recent stderr so we can include it in the error bubble
       when the subprocess dies mid-stream. The CLI usually logs the actual
       crash reason there (panic trace, model-route failure, etc.). */
    s.onStderr(chunk => {
      if (this.session !== s) return;
      this.lastStderr = (this.lastStderr + chunk).slice(-2000);
    });
    return this.session;
  }

  /* Last ~2KB of stderr from the active subprocess. Cleared on each spawn. */
  private lastStderr = "";

  private restartSubprocess() {
    /* If a teardown is already in flight (e.g. a prior model/effort/mode
       change still inside its ~2s SIGTERM window), don't start a second one.
       teardownSession()'s re-entrancy guard would return a resolved no-op that
       overwrites pendingRestartTeardown, dropping the reference to the real
       in-flight dispose so ensureSession() spawns onto the not-yet-exited
       session and double-binds its listeners. The latest state.model/effort/
       mode is read at spawn time, so the single in-flight teardown plus the
       next ensureSession() still pick up the newest selection. */
    if (this.tearingDown) return;
    /* Capture the teardown promise (still fire-and-forget here) so the next
       ensureSession() can await the old subprocess's actual exit before
       spawning. Without this, a quick submit during the ~2s SIGTERM window
       would get the stale (still-running) session back from spawn() on the old
       model, with listeners re-bound. A swallowed rejection keeps this
       non-throwing for the unawaited path. Reconcile after the teardown: the
       old session's exit no longer reaches onExit (identity guard), so a
       mid-turn restart must flip its still-running tool rows here or they
       spin forever. Idempotent when the turn was idle. */
    this.pendingRestartTeardown = this.teardownSession("restart")
      .then(() => this.reconcileAbortedTurn())
      .catch(() => {});
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

  /* Toggle incognito on a still-empty tab. The InputBox only fires this while
     its pill is unlocked (no live session), so we never flip a tab that has
     already spawned. The view reconciles disk state via onIncognitoToggle:
     deleting any file written while the tab was a normal empty tab. */
  private handleIncognitoChange(incognito: boolean) {
    this.state.incognito = incognito || undefined;
    this.state.updatedAt = Date.now();
    this.onIncognitoToggle?.(this.state.id, incognito);
  }

  private handleVoiceChange(voice: boolean) {
    this.state.voiceEnabled = voice;
    this.state.updatedAt = Date.now();
    /* Turning the mode off silences this tab immediately; the play/pause
       button is the transport control while the mode stays on. The notify
       listener re-syncs the button. */
    if (!voice) {
      this.plugin.speech.stop(this.state.id);
      this.plugin.speech.forgetChannel(this.state.id);
    }
    this.onStateChangeCb();
  }

  private handleVoicePauseToggle() {
    const paused = this.plugin.speech.togglePause();
    this.inputBox.setVoicePaused(paused);
  }

  private voiceOn(): boolean {
    return this.state.voiceEnabled === true;
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

    /* A new message interrupts this tab's speech still reading the previous
       response — matches the mobile voice-mode feel where talking over
       Claude cuts it off. Channel-scoped: sibling tabs and note reads keep
       playing. The notify listener re-syncs the pause button. */
    if (this.voiceOn()) this.plugin.speech.stop(this.state.id);

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

    const stickySet = new Set(this.activeFileIndicator.getStickyPaths());
    const officeInlines: string[] = [];
    for (const p of officePaths) {
      /* Sticky office pins persist across turns (unlike one-shot pins,
         which are always fresh — see the auto-drop below). Skip
         re-extracting/re-inlining one whose content we already sent this
         session and whose file hasn't changed since: the model already
         has it in the conversation history, so resending is pure bloat. */
      if (stickySet.has(p)) {
        const mtime = this.officeFileMtime(p);
        if (mtime !== undefined && this.sentOfficePaths.get(p) === mtime) continue;
      }
      try {
        const extracted = await extractOfficeText(this.app, p);
        officeInlines.push(`<file path="${p}">\n${extracted}\n</file>`);
        if (stickySet.has(p)) {
          const mtime = this.officeFileMtime(p);
          if (mtime !== undefined) this.sentOfficePaths.set(p, mtime);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        new Notice(`Couldn't extract text from ${p}: ${message}`);
        /* Extraction failing must not silently drop the file from what
           Claude sees — the user still pinned it and expects it in
           context. Note the path and failure inline instead of an @-ref:
           the Read tool rejects these binary extensions outright, so an
           @-ref would just trade this error for a tool_use_error. */
        officeInlines.push(`<file path="${p}">\n[Text extraction failed: ${message}]\n</file>`);
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
      /* Record the notes pinned for this turn so the bubble can surface them
         as note pills. Captured before the post-submit auto-drop below clears
         non-sticky pins off the bar. */
      attachedNotePaths: pinnedPaths.length > 0 ? [...pinnedPaths] : undefined,
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

    /* Auto-drop non-sticky pins THAT WERE PART OF THIS TURN. The file
       contents are already inlined into THIS turn's wireText (built
       above from the `pinnedPaths` snapshot), and once the API request
       lands they live forever in the conversation history. Re-shipping
       them on every follow-up turn is the cost we're trying to avoid.
       Sticky pins survive; non-sticky pins that were snapshotted fall off
       the pill bar.

       Between that snapshot and here, submit() awaited office extraction
       and the message render — real yield points during which the user
       can click a new pin. Dropping against the LIVE pinned set (as
       opposed to the snapshot) would silently discard that pin: it was
       never in wireText (built before the click), and this call would
       then also strip it from the pill bar, losing it entirely with no
       error. Instead, keep anything sticky OR not part of this turn's
       sent snapshot, so a mid-submit pin survives to be sent next turn. */
    const sentSnapshot = new Set(pinnedPaths);
    const stickyPaths = new Set(this.activeFileIndicator.getStickyPaths());
    const survivors = this.activeFileIndicator.getPinnedPaths()
      .filter(p => stickyPaths.has(p) || !sentSnapshot.has(p));
    this.activeFileIndicator.setPinnedPaths(survivors);

    /* Parallel-fire title generation: kick off the Haiku subprocess the
       moment we have the user's message, so it runs concurrently with the
       assistant response instead of waiting for it to complete. Title
       usually arrives during or right at the end of the response, making
       the lag invisible. Guarded by maybeGenerateTitle so it no-ops on
       follow-up turns and when the setting is off. */
    void this.maybeGenerateTitle();

    const session = await this.ensureSession();
    /* The tab can be closed while ensureSession awaits a restart teardown —
       the session just spawned then belongs to a dead tab. Kill it instead of
       leaking a full turn (and its persistence writes) into a deleted
       conversation. */
    if (this.destroyed) {
      void session.dispose();
      return;
    }
    /* Esc pressed while ensureSession was awaiting a restart teardown: the
       cancel's own teardownSession no-op'd behind the re-entrancy guard, so
       nothing stopped this turn from proceeding — the user's Stop would be
       silently overridden and the message sent anyway. Honor the cancel:
       leave the bubble in place but never send. */
    if (this.userCancelInitiated) {
      this.state.busy = false;
      this.inputBox.setBusy(false);
      this.statusIndicator.hide();
      StateEmitter.setState("ready");
      this.onStateChangeCb();
      return;
    }
    /* ensureSession may have awaited a restart teardown whose epilogue clears
       busy (teardownSession's non-switch tail runs AFTER we set busy above).
       Re-assert so the live turn keeps Send disabled, Esc-cancel armed, and
       the tab badge accurate. */
    this.state.busy = true;
    this.inputBox.setBusy(true);
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
    /* sendUserText/sendUserContent throw synchronously when the child's
       stdin has already been destroyed (e.g. a spawn failure whose ENOENT
       'error' event landed during the ensureSession() await above, before
       stdin.writable flips false). Every caller of submit() fires it as
       `void this.submit(...)` with no .catch, so an uncaught throw here
       becomes an unhandled rejection that aborts the function with busy
       already (re)asserted true above — the composer stays disabled
       forever with no error shown; Esc is the only way out. Route through
       handleError so this degrades exactly like a mid-stream CLI error:
       error bubble, busy cleared, status hidden, trackers reconciled. */
    try {
      if (mediaBlocks.length === 0) {
        session.sendUserText(finalText);
        return;
      }
      const blocks: ContentBlock[] = [...mediaBlocks];
      if (finalText) blocks.push({ type: "text", text: finalText });
      session.sendUserContent(blocks);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.handleError({ type: "error", message: `Failed to send message: ${message}` });
    }
  }

  private async onEvent(event: StreamEvent) {
    /* Any inbound CLI event proves the subprocess is alive and progressing,
       so kick the status watchdog. Without this, a turn whose wall-clock is
       dominated by long-but-healthy tool calls (e.g. several sequential
       Perplexity / research lookups, each 30s+) crosses the inactivity
       ceiling with no setThinking() call and the spinner self-hides while the
       CLI is still working. heartbeat() is a no-op unless a thinking spinner
       is currently showing. */
    this.statusIndicator.heartbeat();
    switch (event.type) {
      case "system": {
        const sys = event as SystemInitEvent | SystemApiRetryEvent | { type: "system"; subtype: string };
        if (sys.subtype === "init") {
          const init = sys as SystemInitEvent;
          if (init.session_id) {
            this.state.sessionId = init.session_id;
            /* Remember this id so teardown can delete its on-disk residue. */
            if (this.state.incognito) this.incognitoSessionIds.add(init.session_id);
          }
          /* Cache the slash-command and skill lists the CLI just announced.
             Reset on every spawn — when the user switches model / effort /
             permission mode the subprocess restarts and a new init arrives
             with the same data (or different, if a plugin's availability
             depends on permission mode). */
          if (init.slash_commands) this.state.availableSlashCommands = init.slash_commands;
          if (init.skills) this.state.availableSkills = init.skills;
          /* Group MCP-namespaced tools by server. The CLI names every MCP
             tool as `mcp__<server>__<tool>` (double-underscore separator).
             Other tools (Read, Bash, Edit, etc.) are non-MCP and skipped.
             Result feeds the cost-surface pill and its hover popup. */
          if (Array.isArray(init.tools)) {
            const grouped: Record<string, string[]> = {};
            /* A fixed-position split("__") only works if the sanitized
               server name itself never contains "__" — but
               sanitizeMcpServerName replaces each disallowed character
               independently, so a display name with two adjacent special
               characters (e.g. "My  Server" or "Foo & Bar") sanitizes to
               something like "My__Server", which then mis-splits into the
               wrong server key and a corrupted tool name. Match against
               the known sanitized server-name set instead (longest first,
               in case one is itself a prefix of another), falling back to
               the old positional split only for a server this list
               doesn't (yet) know about. */
            const knownSids = (await this.plugin.getMcpServers().catch(() => []))
              .map(s => sanitizeMcpServerName(s.name))
              .sort((a, b) => b.length - a.length);
            for (const tool of init.tools) {
              if (!tool.startsWith("mcp__")) continue;
              const rest = tool.slice("mcp__".length);
              const matchedSid = knownSids.find(sid => rest.startsWith(`${sid}__`));
              let server: string;
              let toolName: string;
              if (matchedSid) {
                server = matchedSid;
                toolName = rest.slice(matchedSid.length + 2);
              } else {
                const parts = tool.split("__");
                if (parts.length < 3) continue;
                server = parts[1];
                toolName = parts.slice(2).join("__");
              }
              (grouped[server] ??= []).push(toolName);
            }
            this.state.mcpToolsByServer = grouped;
            /* Write through to the plugin-level cache so future sessions
               (new tab, post-/clear, plugin reload) can show tool counts
               in the pill before their own init arrives. */
            void this.plugin.updateMcpToolCache(grouped);
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
      case "rate_limit_event": {
        this.handleRateLimit(event as RateLimitEvent);
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
        /* Voice mode: feed the accumulated text so complete sentences get
           spoken while the rest of the reply is still streaming. The
           controller tracks its own spoken offset, so this is idempotent
           per delta. */
        if (this.voiceOn()) this.plugin.speech.updateStream(this.state.id, msg.id, msg.content);
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
          /* A top-level tool-input object only becomes parseable on the delta
             that carries its closing brace; skip the full-buffer parse on
             interior-content deltas to avoid O(n^2) scans + thrown SyntaxErrors
             while a large value (e.g. Write/Edit content) streams. The
             authoritative final input is set in handleAssistant, so these
             intermediate parses are a cosmetic live preview only. */
          if (inner.delta.partial_json.includes("}")) {
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
    /* Voice mode: this pass's text is now authoritative — speak the tail
       past the last sentence boundary. In non-streaming mode (no prior
       deltas) this is also where the whole message gets spoken. Runs
       BEFORE maybeMergePrefixPreamble so the spoken offset always refers
       to this message's own unmerged text. */
    if (this.voiceOn() && finalText) this.plugin.speech.finalizeStream(this.state.id, msg.id, finalText);

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
    /* Reset streaming state BEFORE yielding to the render await. node:readline
       dispatches buffered lines synchronously and onEvent is fire-and-forget, so
       a next-pass event in the same stdout chunk would otherwise bind to the
       stale streamingAssistantMessageId or have its streamingBlocks slot wiped
       by the clear below. passStartedAt is nulled (not restamped) so
       getOrCreateStreamingAssistantMessage anchors a fresh timer when the next
       pass actually begins streaming. */
    this.clearStreamingPointer();
    this.streamingBlocks.clear();
    this.passStartedAt = null;
    await this.renderer.upsertMessage(msg);
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
    if (this.userCancelInitiated) {
      /* A control_request that lands after the user hit cancel but before the
         subprocess is actually killed still needs a response, or the CLI blocks
         waiting for one during the (up-to-2s) teardown window. Deny it
         immediately rather than dropping it silently — no card is shown. */
      try { this.session?.deny(event.request_id, "User cancelled"); } catch { /* best-effort */ }
      return;
    }
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
    /* The CLI now blocks waiting for the user's Allow/Deny and emits no events
       meanwhile, so the inactivity watchdog would hide the thinking pill mid-
       approval even though nothing is wedged. Suspend it; the allow branch of
       handleApproval re-arms it via setThinking() when the turn resumes. */
    this.statusIndicator.suspendWatchdog();
    StateEmitter.setState("needs_permission");
  }

  private handleResult(event: ResultEvent) {
    this.state.busy = false;
    this.inputBox.setBusy(false);
    this.statusIndicator.hide();
    this.clearStreamingPointer();
    this.passStartedAt = null;
    /* Turn-level failures (error_max_turns, error_during_execution,
       error_budget_exhausted, …) arrive through this same result event —
       there is no separate top-level error event for them. Surface a bubble
       directly here rather than via handleError, whose errorBubbleEmitted
       dedup could swallow it if a prior error event already fired this
       session. Without this the conversation just stops dead with no
       indication anything failed. */
    const turnFailed = event.is_error === true ||
      (typeof event.subtype === "string" && event.subtype.startsWith("error"));
    if (turnFailed) {
      const label = typeof event.subtype === "string" && event.subtype !== "success" ? event.subtype : "error";
      const detail = typeof event.result === "string" && event.result ? ` — ${event.result}` : "";
      const errorMsg: ChatMessage = {
        id: makeMessageId(),
        role: "assistant",
        content: `**Turn failed (${label})**${detail}`,
        timestamp: Date.now(),
      };
      this.state.messages.push(errorMsg);
      void this.renderer.upsertMessage(errorMsg);
      /* A voice-mode user listening away from the screen would otherwise
         get silence with no indication the turn died mid-thought. */
      if (this.voiceOn()) {
        this.plugin.speech.finalizeStream(this.state.id, errorMsg.id, `The turn failed: ${label}.`);
      }
    }
    /* Turn-end reconciliation for any still-running tools. If the model
       produced a final synthesis (we're in handleResult), every tool it relied
       on must have returned a tool_result — otherwise the model couldn't have
       written the answer. In practice though, a few tool_result events can be
       missed by handleToolResult (out-of-order delivery, parser skipping a
       synthetic user envelope, a state restore mid-turn, or a result that
       arrived before its tool_use registered). Without a sweep those tools
       linger at status=running, spinning forever — and for Task/Agent tools,
       leaving the Agents pill stuck on a non-zero count. Force-close them —
       as errored when the turn itself failed, since a dead turn never
       finished its tools. */
    let swept = 0;
    for (const m of this.state.messages) {
      if (!m.toolCalls) continue;
      let touched = false;
      for (const t of m.toolCalls) {
        if (t.status !== "running") continue;
        if (t.name === "Task" || t.name === "Agent") {
          t.status = turnFailed ? "errored" : "completed";
          if (turnFailed) t.isError = true;
          if (t.nestedStatus !== "completed" && t.nestedStatus !== "failed") {
            t.nestedStatus = turnFailed ? "failed" : "completed";
          }
          /* This tool never received its tool_result, so handleToolResult never
             ran to stop its subagent tracker. Stop it here, or the tracker's
             JsonlTailer + session-file claim leak until the next teardownSession
             (which may be many turns away in a long-lived tab). */
          const tracker = this.subagentTrackers.get(t.id);
          if (tracker) {
            void tracker.stop();
            this.subagentTrackers.delete(t.id);
          }
          this.subagentSpawnTimes.delete(t.id);
          swept++;
        } else {
          /* A regular tool (Bash, Read, Edit, MCP, …) still running at the
             turn-terminal result event will never get a tool_result either, so
             close it too — otherwise its row keeps spinning for the tab's life. */
          t.status = turnFailed ? "errored" : "completed";
          if (turnFailed) t.isError = true;
        }
        touched = true;
      }
      /* Re-render so the swept tool row stops showing a running spinner. */
      if (touched) void this.renderer.upsertMessage(m);
    }
    if (swept > 0) this.refreshRunningAgentCount();
    /* Turn settled. StateEmitter auto-transitions complete -> ready after
       10s (matches the daemon's COMPLETE_TIMEOUT_S), and the animator daemon
       times ready -> idle after 60s. A failed turn goes straight to ready —
       "complete" on the TC001 would misreport the failure as success. */
    /* Drop any stream offsets this turn never finalized (errored passes,
       missed assistant events) — entries are keyed by unique message id,
       so without this sweep they'd accumulate for the plugin's lifetime.
       Audio is untouched; queued chunks keep playing. */
    this.plugin.speech.forgetChannel(this.state.id);
    StateEmitter.setState(turnFailed ? "ready" : "complete");
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
    /* Incognito tabs must touch no disk. generateTitle spawns a throwaway
       `claude --print --no-session-persistence` subprocess whose own session
       id is never captured in incognitoSessionIds, so the ai-title residue it
       writes (wire-format gotcha #6) would never be cleaned up — a privacy
       leak summarizing the chat. Skip title-gen entirely; the synchronous
       first-message-prefix title set in submit() is the incognito fallback. */
    if (this.state.incognito) return;
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
      /* The title-gen subprocess is independent and outlives teardownSession()/clear(),
         which neither kill it. If the tab was closed during the multi-second
         await, onStateChangeCb would rewrite the conversation file closeTab
         just deleted, resurrecting it as a History-modal orphan. Likewise if
         the conversation was cleared or replaced, the first user message is
         gone (or has a new id), and a stale title would retitle a fresh tab
         with the prior topic. */
      if (this.destroyed) return;
      if (this.state.messages.find(m => m.role === "user")?.id !== firstUser.id) return;
      this.state.title = generated;
      this.state.updatedAt = Date.now();
      this.refreshTitleBar();
      this.onStateChangeCb();
    }
  }

  /* Crash-path reconciliation shared by every turn-abort route (handleError,
     onExit, cancelStream). When a turn dies mid-stream the subprocess won't
     deliver any outstanding tool_result, so still-running tools linger at
     status=running (spinning forever) and any matched subagent's tracker keeps
     a JsonlTailer polling disk until the next teardownSession. Stop ALL
     subagent trackers, flip running tool rows to errored, re-render them, and
     refresh the Agents pill count. Idempotent: empty maps / no running tools
     => no-op, so paths that already tore the session down (and any double
     handleError → onExit sequence) cost nothing. */
  private reconcileAbortedTurn(): void {
    for (const tracker of this.subagentTrackers.values()) {
      void tracker.stop();
    }
    this.subagentTrackers.clear();
    this.subagentSpawnTimes.clear();
    for (const m of this.state.messages) {
      if (!m.toolCalls) continue;
      let touched = false;
      for (const t of m.toolCalls) {
        if (t.status !== "running") continue;
        t.status = "errored";
        t.isError = true;
        if (t.name === "Task" || t.name === "Agent") t.nestedStatus = "failed";
        touched = true;
      }
      if (touched) void this.renderer.upsertMessage(m);
    }
    this.refreshRunningAgentCount();
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
    /* A mid-stream error (e.g. a synthesized parse_error from one bad stdout
       line) aborts the turn but the subprocess may keep running and never fire
       'exit', so onExit's reconciliation never gets a chance. Run it here so
       outstanding subagent trackers stop and running tool rows don't spin for
       the life of the tab. Runs on the first (non-deduped) error call, which is
       the case that matters. */
    this.reconcileAbortedTurn();
    /* A failed turn otherwise leaves the last emitted device state as a held
       one (thinking / needs_permission), whose 5s heartbeat would keep POSTing
       to the TC001 forever. clear()/cancelStream()/handleResult already reset;
       mirror them so an errored-out turn the user walks away from doesn't leak
       the interval. */
    StateEmitter.setState("ready");
    await this.renderer.upsertMessage(errorMsg);
  }

  private handleApproval(requestId: string, decision: ApprovalDecision) {
    if (this.userCancelInitiated) return;
    const approval = this.state.pendingApprovals.get(requestId);
    /* Order matters: bail if there's no session BEFORE removing the
       pendingApprovals entry. Otherwise a user-click during a teardown
       race silently drops the approval, the card is already gone via
       dismiss(), and the user has no way to redrive it. isTerminal covers
       the dead-but-not-nulled session (unexpected exit): approving into it
       would swallow the write and flip the pill to a phantom "thinking". */
    if (!this.session || this.session.isTerminal()) return;
    this.state.pendingApprovals.delete(requestId);
    if (decision.allowed) {
      /* Pass the original input from the request — the SDK requires
         `updatedInput` even when we're not modifying anything. */
      this.session.approve(requestId, approval?.input as Record<string, unknown> | undefined);
      /* Recovery: the assistant is about to resume running the tool, so
         flip the display back to thinking. handleResult will fire complete
         when the turn finally settles. Deny doesn't fire a recovery
         because the result event will arrive almost immediately with the
         denial outcome. setThinking() also re-arms the inactivity watchdog
         that handleControlRequest suspended for the approval wait, and
         restores the pill if that wait outlasted the ceiling and hid it. */
      this.statusIndicator.setThinking();
      StateEmitter.setState("thinking");
    } else {
      this.session.deny(requestId, decision.reason);
    }
    this.onStateChangeCb();
  }

  /* Rate-limit telemetry. "allowed" is the steady-state no-op; warning and
     blocked are surfaced via Notice (the same channel other non-fatal
     signals use) — without it the user just sees the turn stall with no
     hint that a cap was hit or when it resets. */
  private handleRateLimit(event: RateLimitEvent) {
    const info = event.rate_limit_info;
    if (!info || info.status === "allowed") return;
    if (info.status !== "warning" && info.status !== "blocked") return;
    const cap = info.rateLimitType === "five_hour" ? "5-hour limit"
      : info.rateLimitType === "seven_day" ? "weekly limit"
      : "rate limit";
    const verb = info.status === "blocked" ? "reached" : "near";
    const resetSuffix = info.resetsAt ? ` Resets ${this.formatResetTime(info.resetsAt)}.` : "";
    const overageSuffix = (info.isUsingOverage || info.overageStatus === "blocked") && info.overageResetsAt
      ? ` Overage resets ${this.formatResetTime(info.overageResetsAt)}.`
      : "";
    new Notice(`Claude ${cap} ${verb}.${resetSuffix}${overageSuffix}`, 8000);
  }

  /* resetsAt arrives as Unix epoch seconds; tolerate ms just in case. */
  private formatResetTime(resetsAt: number): string {
    const ms = resetsAt > 1e12 ? resetsAt : resetsAt * 1000;
    return new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
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
    /* Crash-path reconciliation, mirroring what cancelStream and
       handleResult both do but the unexpected-exit path missed: the
       subprocess is gone, so no still-running tool will ever receive its
       tool_result. Stops ALL subagent trackers, flips running tool rows to
       errored, and refreshes the Agents pill. Idempotent on the teardown-
       driven exits (cancel/restart/clear), where the maps are already empty
       and no tools are left running. */
    this.reconcileAbortedTurn();
    /* The process is gone, so nothing can ever answer an outstanding
       approval. Clear the entries and dismiss the cards — otherwise the card
       outlives the crash, a late Allow writes into the dead session's stdin
       (silently swallowed), and the status pill + TC001 strand on a phantom
       "thinking" with no turn running. */
    this.state.pendingApprovals.clear();
    this.approvalArea.dismissAll();
    this.state.busy = false;
    this.inputBox.setBusy(false);
    this.statusIndicator.hide();
    /* A crashed turn leaves the last held device state (thinking /
       needs_permission) running its 5s heartbeat; drop to ready like the other
       turn-end paths so it doesn't keep POSTing to the TC001. */
    StateEmitter.setState("ready");
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
    /* Persist the error bubble. Unlike the onEvent "error" case (followed by
       the trailing onStateChangeCb) and onExit (which calls it directly), the
       raw spawn-error path has no other persistence trigger — an ENOENT spawn
       failure emits "error" without an "exit", so without this the bubble is
       shown live but never written to disk and vanishes on reload. */
    this.onStateChangeCb();
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

  /* Reads Obsidian's internal drag state and resolves it to vault paths.
     File-explorer drags populate `app.dragManager.draggable` with the
     dragged TFile/TFolder (or a `files` array for multi-select) but
     typically leave the HTML5 dataTransfer empty, so this is the only
     reliable way to detect that a vault drag is in flight from inside our
     dragover/drop handlers. Link drags (a [[wikilink]] dragged out of an
     editor, a search result, a backlink, a bookmark, a tab header) carry
     no TFile at all — just `linktext` + `sourcePath` — so those resolve
     through the metadata cache like Obsidian's own link resolution. The
     `dragManager` field is internal (not in the public Obsidian d.ts), so
     we narrow through `unknown` rather than reaching for `any`. */
  private readDragManagerPaths(): string[] {
    const dm = (this.app as unknown as {
      dragManager?: {
        draggable?: {
          file?: unknown;
          files?: unknown[];
          linktext?: unknown;
          sourcePath?: unknown;
          source?: unknown;
          type?: unknown;
        };
      };
    }).dragManager;
    const draggable = dm?.draggable;
    if (!draggable) return [];
    const paths: string[] = [];
    if (draggable.file instanceof TFile || draggable.file instanceof TFolder) {
      paths.push(draggable.file.path);
    }
    if (Array.isArray(draggable.files)) {
      for (const f of draggable.files) {
        if (f instanceof TFile || f instanceof TFolder) paths.push(f.path);
      }
    }
    if (paths.length === 0 && draggable.type === "link" && typeof draggable.linktext === "string") {
      /* linktext may carry a heading/block subpath ("Note#Section") — strip
         it; pins are whole-file. */
      const bare = draggable.linktext.split("#")[0].trim();
      const source = typeof draggable.sourcePath === "string" ? draggable.sourcePath : "";
      const dest = this.app.metadataCache.getFirstLinkpathDest(bare, source);
      if (dest) paths.push(dest.path);
    }
    return paths;
  }

  private isVaultDragActive(): boolean {
    return this.readDragManagerPaths().length > 0;
  }

  /* Consumes the active Obsidian drag (if any) by pinning every dragged
     item. Returns true when at least one item was pinned so the InputBox
     knows to skip its text/plain fallback. Files and folders both route
     through the same pin call — ActiveFileIndicator picks the icon and
     color per item via its own vault lookup. */
  private tryConsumeVaultDrag(): boolean {
    const paths = this.readDragManagerPaths();
    if (paths.length === 0) return false;
    for (const path of paths) {
      this.activeFileIndicator.addPinnedPath(path);
    }
    return true;
  }

  /* One-line system-prompt block listing every enabled trusted folder.
     Returns "" when the feature is off, no folders are trusted, or none
     are currently enabled — caller filters empty entries before joining,
     so an empty string is the right neutral value. Kept terse: each folder
     is one bullet line so the addendum costs a handful of tokens, not a
     paragraph. */
  private buildTrustedFoldersAddendum(): string {
    if (!this.plugin.settings.trustedFoldersInSystemPrompt) return "";
    const enabled = (this.plugin.settings.trustedFolders ?? []).filter(f => f.enabled);
    if (enabled.length === 0) return "";
    const lines = enabled.map(f => `- ${f.path}`);
    return [
      "Trusted folders outside the vault (Read/Glob/Grep are pre-approved here — use them on demand instead of expecting file contents inline):",
      ...lines,
    ].join("\n");
  }

  /* Adds a folder to the user's trusted-folder list. New entries default to
     `enabled: true` so the picker → checkbox handoff is one step (you
     picked it, you want it on). Idempotent: re-adding an already-present
     path quietly bumps it to enabled rather than appending a duplicate.
     Writes the matching Read/Glob/Grep allowlist patterns so the CLI
     auto-approves filesystem reads under the folder on the very next tool
     call — no session restart needed for permissions to take effect. The
     system-prompt hint, however, only refreshes on the next spawn (see
     ensureSession's composedAddendum). */
  private async addTrustedFolder(rawPath: string): Promise<void> {
    const path = rawPath.replace(/\/+$/, "");
    if (!path) return;
    const list = this.plugin.settings.trustedFolders ?? [];
    const existing = list.find(f => f.path === path);
    if (existing) {
      if (!existing.enabled) await this.toggleTrustedFolder(path, true);
      return;
    }
    list.push({ path, enabled: true });
    this.plugin.settings.trustedFolders = list;
    await this.plugin.saveSettings();
    await this.plugin.permissionsStore.addAllowMany(trustedFolderAllowPatterns(path));
    new Notice(`Trusted ${path}`);
  }

  private async toggleTrustedFolder(rawPath: string, enabled: boolean): Promise<void> {
    const path = rawPath.replace(/\/+$/, "");
    const list = this.plugin.settings.trustedFolders ?? [];
    const entry = list.find(f => f.path === path);
    if (!entry) return;
    entry.enabled = enabled;
    this.plugin.settings.trustedFolders = list;
    await this.plugin.saveSettings();
    const patterns = trustedFolderAllowPatterns(path);
    if (enabled) {
      await this.plugin.permissionsStore.addAllowMany(patterns);
    } else {
      for (const p of patterns) await this.plugin.permissionsStore.removeAllow(p);
    }
  }

  /* Removes the folder from the list entirely. Always clears the allowlist
     patterns whether the entry was enabled or not — keeps state consistent
     if someone hand-edited settings.json out of sync. */
  private async removeTrustedFolder(rawPath: string): Promise<void> {
    const path = rawPath.replace(/\/+$/, "");
    const list = this.plugin.settings.trustedFolders ?? [];
    const idx = list.findIndex(f => f.path === path);
    if (idx < 0) return;
    list.splice(idx, 1);
    this.plugin.settings.trustedFolders = list;
    await this.plugin.saveSettings();
    const patterns = trustedFolderAllowPatterns(path);
    for (const p of patterns) await this.plugin.permissionsStore.removeAllow(p);
  }

  /* Lazily build and memoize the flat file+folder index that backs the
     @-mention query. Invalidated by the vault create/delete/rename listeners
     wired in the constructor, so it survives across keystrokes. The vault root
     (path "") is skipped so the user can't pin "the entire vault"; folders
     carry mtime 0 (folder mtime isn't exposed) so they bunch at the bottom of
     the empty-query list, matching Obsidian's quick-switcher behavior. */
  private getMentionIndex(): Array<{ kind: "file" | "folder"; path: string; name: string; mtime: number; ext: string }> {
    if (this.mentionIndex) return this.mentionIndex;
    const index: Array<{ kind: "file" | "folder"; path: string; name: string; mtime: number; ext: string }> = [];
    for (const f of this.app.vault.getFiles()) {
      index.push({ kind: "file", path: f.path, name: f.basename, mtime: f.stat.mtime, ext: f.extension });
    }
    const walkFolders = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          if (child.path !== "" && child.path !== "/") {
            index.push({ kind: "folder", path: child.path, name: child.name, mtime: 0, ext: "" });
          }
          walkFolders(child);
        }
      }
    };
    walkFolders(this.app.vault.getRoot());
    this.mentionIndex = index;
    return index;
  }

  /* Rank vault files AND folders for an @-mention query. Simple heuristic:
     prefer basename matches over path matches, then prefer prefix matches
     over substring matches. Cap at 20 results. Claude Code understands
     `@<path>` references natively for files (the CLI expands them into file
     content); folders are routed to onPinFolder instead and become pinned
     pills rather than text references. Reads the memoized getMentionIndex()
     so a keystroke costs one scored pass, not a full vault re-traversal. */
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

    for (const entry of this.getMentionIndex()) {
      const score = scoreOf(entry.name, entry.path, entry.mtime);
      if (score >= 0) scored.push({ ...entry, score });
    }

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
    /* Refresh once per popup open (query === "" is the first keystroke —
       just "/" typed, nothing narrowing it yet), not on every subsequent
       character: skillCatalog is otherwise populated once at plugin load
       and never re-scanned (main.ts's refreshSkillCatalog has no other
       call site), so a skill/command added or edited on disk after Obsidian
       started would show a stale or generic-placeholder description for the
       rest of the session. Cheap enough here since it only fires when the
       popup transitions from closed to open, unlike re-scanning on every
       keystroke while the user narrows the query. */
    if (query === "") this.plugin.refreshSkillCatalog();
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
