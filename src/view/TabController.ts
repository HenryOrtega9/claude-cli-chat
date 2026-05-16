import { Notice, TFile, type App, type Component } from "obsidian";
import { MessageListRenderer } from "./MessageRenderer";
import { ApprovalArea, type ApprovalDecision } from "./ApprovalModal";
import { InputBox, type SubmitPayload, type Suggestion } from "./InputBox";
import { renderWelcome, setWelcomeVisible } from "./Welcome";
import { RemotePairingCard } from "./RemotePairingCard";
import { StatusIndicator } from "./StatusIndicator";
import { SearchBar } from "./SearchBar";
import { ActiveFileIndicator } from "./ActiveFileIndicator";
import { SelectionTracker, type ActiveSelection } from "./SelectionTracker";
import { makeMessageId, makeTabState, type ChatMessage, type TabState, type PendingApproval, type ToolCall } from "./state";
import { spawnOptionsFromSettings, type TabSession } from "../claude/SubprocessManager";
import { resolveModelId, type ModelKey, type EffortLevel, type PermissionMode, type EnvSnippet } from "../settings";
import { RemoteControlSession, sessionFilePathFor } from "../claude/RemoteControlSession";
import { JsonlTailer } from "../claude/JsonlTailer";
import { generateTitle } from "../claude/TitleGenerator";
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

  /* Optional fork handler — provided by ClaudeChatView so the controller can
     ask the view to create a new tab branching from a given message id. */
  onForkRequest?: (sourceTab: TabController, messageId: string) => void;

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
    this.activeFileIndicator = new ActiveFileIndicator(
      this.root,
      this.app,
      this.state.pinnedFilePaths ?? [],
      {
        onPinChange: paths => {
          this.state.pinnedFilePaths = paths;
          this.state.updatedAt = Date.now();
          this.onStateChangeCb();
        },
      }
    );
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
      },
      {
        model: (this.state.model as ModelKey | undefined) ?? this.plugin.settings.defaultModel,
        effort: (this.state.effort as EffortLevel | undefined) ?? this.plugin.settings.defaultEffort,
        permissionMode: (this.state.permissionMode as PermissionMode | undefined) ?? this.plugin.settings.permissionMode,
      }
    );

    this.pairingCard = new RemotePairingCard(this.root, {
      onDisconnect: () => void this.switchMode("local"),
    });

    /* SelectionTracker pushes the active editor selection into the input
       box as a pinned context chip. Selection survives keystrokes; the chip
       is consumed (cleared) on submit. */
    this.selectionTracker = new SelectionTracker(this.app, sel => {
      this.inputBox.setSelection(sel);
    });

    void this.replayMessages();
    this.updateWelcomeVisibility();
  }

  show() { this.root.style.display = ""; }
  hide() { this.root.style.display = "none"; }
  destroy() {
    void this.session?.dispose();
    void this.remoteSession?.dispose();
    this.jsonlTailer?.stop();
    this.statusIndicator.destroy();
    this.activeFileIndicator.destroy();
    this.selectionTracker.destroy();
    this.renderer.destroy();
    this.root.remove();
  }

  async switchMode(mode: TabMode): Promise<void> {
    if (this.mode === mode) return;
    /* eslint-disable no-console */
    console.log(`[claude-cli-chat] switchMode tab=${this.state.id} ${this.mode} -> ${mode}`);

    /* Tear down whatever is currently active. */
    if (this.mode === "local") {
      if (this.session) {
        await this.session.dispose();
        this.session = null;
      }
    } else {
      if (this.remoteSession) {
        await this.remoteSession.dispose();
        this.remoteSession = null;
      }
      this.jsonlTailer?.stop();
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

  private startRemoteMode() {
    const cwd = this.plugin.getVaultPath();
    const prefix = this.plugin.settings.remoteSessionNamePrefix?.trim() || undefined;
    const sessionName = prefix ? `${prefix}-${this.state.id.slice(-6)}` : undefined;

    this.pairingCard.show();
    this.pairingCard.setStatus("starting");
    this.pairingCard.setUrl("");

    this.remoteSession = new RemoteControlSession({
      cwd,
      sessionId: this.state.sessionId ?? undefined,
      sessionName,
      claudePath: this.plugin.settings.claudePath || undefined,
    });

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
    void this.jsonlTailer.start();
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

    const commit = () => {
      const value = input.value.trim();
      this.state.title = value || "New chat";
      this.state.updatedAt = Date.now();
      input.replaceWith(this.titleTextEl);
      this.refreshTitleBar();
      this.onStateChangeCb();
    };
    const cancel = () => {
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
    const [head] = trimmed.toLowerCase().split(/\s+/);
    switch (head) {
      case "/clear":
        this.clear();
        new Notice("Cleared chat — next message starts a new Claude session.");
        return true;
      case "/help":
        new Notice(
          "Plugin slash commands:\n" +
          "  /clear — reset this tab to a fresh session\n" +
          "  /help — show this help\n" +
          "Use the model / effort / mode pills (and Shift+Tab) for runtime switches.",
          8000
        );
        return true;
      default:
        return false;
    }
  }

  /* Resets the active tab in place: kills the subprocess, wipes messages and
     session id, restores the welcome screen. The tab id is preserved so disk
     persistence and the tab bar position stay stable. */
  clear() {
    if (this.session) {
      void this.session.dispose();
      this.session = null;
    }
    this.state.messages = [];
    this.state.pendingApprovals.clear();
    this.state.sessionId = null;
    this.state.title = "New chat";
    this.state.busy = false;
    this.state.updatedAt = Date.now();
    this.titleGenerationStarted = false;
    this.refreshTitleBar();
    this.toolToMessage.clear();
    this.clearStreamingPointer();
    this.streamingBlocks.clear();
    this.passStartedAt = null;
    this.renderer.reset();
    this.approvalArea.clear();
    this.statusIndicator.hide();
    this.inputBox.setBusy(false);
    this.inputBox.setUsage(undefined);
    this.updateWelcomeVisibility();
    this.onStateChangeCb();
  }

  /* Esc-cancel: kill the in-flight subprocess so streaming stops, but keep
     `sessionId` so the next user message resumes the conversation via
     `--resume`. Visible messages are left in place. No-op if not busy. */
  async cancelStream() {
    if (!this.state.busy) return;
    this.userCancelInitiated = true;
    if (this.session) {
      await this.session.dispose();
      this.session = null;
    }
    if (this.remoteSession) {
      await this.remoteSession.dispose();
      this.remoteSession = null;
    }
    this.state.pendingApprovals.clear();
    this.clearStreamingPointer();
    this.streamingBlocks.clear();
    this.passStartedAt = null;
    this.state.busy = false;
    this.statusIndicator.hide();
    this.approvalArea.clear();
    this.inputBox.setBusy(false);
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
    this.session.onExit(code => this.onExit(code));
    this.session.onError(err => this.onErrorRaw(err));
    return this.session;
  }

  private restartSubprocess() {
    if (this.session) void this.session.dispose();
    this.session = null;
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
       already wrote into the message are skipped. */
    const pinnedPaths = this.activeFileIndicator.getPinnedPaths();
    const pinnedRefs = pinnedPaths
      .filter(p => !text.includes(`@${p}`))
      .map(p => `@${p}`)
      .join(" ");
    if (pinnedRefs) {
      wireText = `${pinnedRefs} ${wireText}`;
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
      this.state.title = `Image (${attachments.length})`;
    }
    this.updateWelcomeVisibility();
    await this.renderer.upsertMessage(msg);
    this.renderer.forceStickToBottom();
    this.inputBox.setBusy(true);
    this.statusIndicator.setThinking();
    this.passStartedAt = Date.now();
    this.onStateChangeCb();

    const session = this.ensureSession();
    /* eslint-disable no-console */
    console.log(`[claude-cli-chat] submit -> session.status=${session.status}`);
    /* Claude Code stream-json mode does NOT emit `system/init` until it has
       read at least one user message from stdin. Writing immediately after
       spawn is the correct pattern. The CLI processes the message, then
       emits init + response together. */
    if (attachments.length === 0) {
      session.sendUserText(wireText);
      return;
    }
    const blocks: ContentBlock[] = [];
    for (const att of attachments) {
      const block: ImageBlock = {
        type: "image",
        source: { type: "base64", media_type: att.mediaType, data: att.data },
      };
      blocks.push(block);
    }
    if (wireText) blocks.push({ type: "text", text: wireText });
    session.sendUserContent(blocks);
  }

  private async onEvent(event: StreamEvent) {
    switch (event.type) {
      case "system": {
        const sys = event as SystemInitEvent | SystemApiRetryEvent | { type: "system"; subtype: string };
        if (sys.subtype === "init") {
          const init = sys as SystemInitEvent;
          if (init.session_id) this.state.sessionId = init.session_id;
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
    if (last && last.content === text) return;
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
        }
        this.streamingBlocks.set(inner.index, { kind: "tool", toolId: block.id, partialJson: "" });
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
            const msg = this.state.messages.find(m => m.toolCalls?.some(t => t.id === slot.toolId));
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
      }
      this.streamingBlocks.delete(inner.index);
      return;
    }

    /* message_delta.usage is incremental output-token deltas, not a context
       snapshot — using it for the chip would jitter wildly. We get the real
       per-call usage from the assistant event instead. */
    /* message_start / message_delta / message_stop are no-ops for now. */
  }

  private async handleAssistant(event: AssistantEvent) {
    const msg = this.getOrCreateStreamingAssistantMessage();
    const blocks = (event.message.content ?? []) as AssistantContentBlock[];

    /* Per-call usage is the right source for the context-window indicator —
       cumulative result.usage over-counts shared context across multi-pass
       tool turns. Update after each assistant message so the chip reflects
       the most recent API call's actual context size. */
    if (event.message.usage) this.inputBox.setUsage(event.message.usage);

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
      } else {
        msg.toolCalls.push({ id: tu.id, name: tu.name, input: tu.input, status: "running" });
        this.toolToMessage.set(tu.id, msg.id);
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
    await this.renderer.upsertMessage(msg);

    /* After a final assistant message, future deltas belong to a new bubble.
       Reset the pass anchor so the next pass (e.g. after a tool round-trip)
       measures its own duration cleanly. */
    this.clearStreamingPointer();
    this.streamingBlocks.clear();
    this.passStartedAt = Date.now();
  }

  private async handleToolUse(event: ToolUseEvent) {
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
    await this.renderer.upsertMessage(msg);
  }

  private async handleToolResult(event: ToolResultEvent) {
    const msgId = this.toolToMessage.get(event.tool_use_id);
    if (!msgId) return;
    const msg = this.state.messages.find(m => m.id === msgId);
    if (!msg || !msg.toolCalls) return;
    const tool = msg.toolCalls.find(t => t.id === event.tool_use_id);
    if (!tool) return;
    tool.status = event.is_error ? "errored" : "completed";
    tool.isError = !!event.is_error;
    tool.result = this.flattenContent(event.content);
    await this.renderer.upsertMessage(msg);
  }

  private handleControlRequest(event: ControlRequestEvent) {
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
  }

  private handleResult(_event: ResultEvent) {
    this.state.busy = false;
    this.inputBox.setBusy(false);
    this.statusIndicator.hide();
    this.clearStreamingPointer();
    this.passStartedAt = null;
    /* Do NOT use event.usage here — it sums across every API call in the
       turn (each tool round-trip counts the shared context again), inflating
       the displayed token count. handleAssistant updates the indicator
       per-call from the per-message usage, which is the correct source. */

    /* Fire-and-forget title generation after the very first complete turn.
       Skipped if the title was already set by the user (or by a previous
       title-gen pass), or if the setting is off. */
    void this.maybeGenerateTitle();
  }

  private titleGenerationStarted = false;

  private async maybeGenerateTitle() {
    if (this.titleGenerationStarted) return;
    if (!this.plugin.settings.autoGenerateTitles) return;
    /* Only fire on the very first user+assistant pair. After that the title
       is either the user's choice or a previous title-gen result — don't
       overwrite. */
    if (this.state.title !== "New chat" && !this.state.title.startsWith("Fork: New chat")) {
      /* If the title was set to the first-message-prefix fallback during
         submit(), regenerate it once with a proper model summary. */
      const looksLikeFallback = this.state.messages[0]?.role === "user"
        && this.state.title === this.state.messages[0].content.slice(0, 48);
      if (!looksLikeFallback) return;
    }
    const firstUser = this.state.messages.find(m => m.role === "user");
    const firstAssistant = this.state.messages.find(m => m.role === "assistant" && m.content.trim().length > 0);
    if (!firstUser || !firstAssistant) return;
    this.titleGenerationStarted = true;
    const generated = await generateTitle({
      userMessage: firstUser.content,
      assistantResponse: firstAssistant.content,
      claudePath: this.plugin.settings.claudePath || undefined,
      model: this.plugin.settings.titleGenerationModel || "haiku",
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
    const errorMsg: ChatMessage = {
      id: makeMessageId(),
      role: "assistant",
      content: `**Error:** ${event.message ?? event.error ?? "Unknown error"}`,
      timestamp: Date.now(),
    };
    this.state.messages.push(errorMsg);
    this.state.busy = false;
    this.inputBox.setBusy(false);
    this.statusIndicator.hide();
    await this.renderer.upsertMessage(errorMsg);
  }

  private handleApproval(requestId: string, decision: ApprovalDecision) {
    const approval = this.state.pendingApprovals.get(requestId);
    this.state.pendingApprovals.delete(requestId);
    if (!this.session) return;
    if (decision.allowed) {
      /* Pass the original input from the request — the SDK requires
         `updatedInput` even when we're not modifying anything. */
      this.session.approve(requestId, approval?.input as Record<string, unknown> | undefined);
    } else {
      this.session.deny(requestId, decision.reason);
    }
    this.onStateChangeCb();
  }

  private onExit(code: number | null) {
    if (this.userCancelInitiated) {
      /* Esc-cancel exit. Suppress the crash error and drop a soft italic
         system note so the chat doesn't end on a half-finished bubble. */
      void this.renderCancelNote();
      this.userCancelInitiated = false;
    } else if (this.state.busy) {
      void this.handleError({ type: "error", subtype: "subprocess_exit", message: `Claude exited (code=${code}) before completing the response.` });
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
    return msg;
  }

  private clearStreamingPointer() {
    this.streamingAssistantMessageId = null;
  }

  /* Rank vault files for an @-mention query. Simple heuristic: prefer
     basename matches over path matches, then prefer prefix matches over
     substring matches. Cap at 20 results. Claude Code understands `@<path>`
     references natively (the CLI expands them into file content). */
  private queryFileSuggestions(query: string): Suggestion[] {
    const q = query.toLowerCase();
    const files = this.app.vault.getFiles();
    type Scored = { file: TFile; score: number };
    const scored: Scored[] = [];
    for (const f of files) {
      const base = f.basename.toLowerCase();
      const path = f.path.toLowerCase();
      let score = -1;
      if (q.length === 0) {
        /* Empty query: show recently modified files first. */
        score = f.stat.mtime;
      } else if (base.startsWith(q)) score = 1000 - f.path.length;
      else if (base.includes(q)) score = 800 - f.path.length;
      else if (path.includes(q)) score = 400 - f.path.length;
      if (score >= 0) scored.push({ file: f, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 20).map(({ file }) => ({
      id: file.path,
      primary: file.basename,
      secondary: file.path,
      icon: file.extension === "md" ? "file-text" : "file",
      insert: `@${file.path}`,
    }));
  }

  /* Slash-command palette. Stream-json mode does NOT intercept slash
     commands the way the CLI's interactive REPL does — anything not handled
     plugin-side gets sent to Claude as plain text. So this list only
     includes commands the plugin handles directly. UI-equivalent actions
     (model picker, mode pill, history modal, etc.) are easier to discover
     via their buttons than via a slash. */
  private querySlashCommands(query: string): Suggestion[] {
    const commands: Array<{ cmd: string; desc: string; insert?: string }> = [
      { cmd: "/clear", desc: "Reset this tab — start a fresh Claude session" },
      { cmd: "/help",  desc: "Show plugin slash-command help" },
    ];
    const q = query.toLowerCase();
    return commands
      .filter(c => c.cmd.slice(1).startsWith(q))
      .map(c => ({
        id: c.cmd,
        primary: c.cmd,
        secondary: c.desc,
        icon: "terminal",
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
