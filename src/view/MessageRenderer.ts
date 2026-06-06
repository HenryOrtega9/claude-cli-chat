import { App, Component, MarkdownRenderer, Notice, setIcon } from "obsidian";
import type { Attachment, ChatMessage, NestedSubagentEvent, ToolCall } from "./state";
import { editOpsFromInput, renderDiff, renderWritePreview } from "./DiffRenderer";

export type MessageActionCallbacks = {
  onFork: (messageId: string) => void;
};

/* MessageRenderer manages DOM for the message list. It caches per-message
   elements in `liveEls` so streaming partial updates can mutate the existing
   bubble in place without re-rendering the entire list.

   Auto-scroll strategy:
   - A 1px sentinel `<div>` is appended as the last child of the messages
     container. To pin scroll to the bottom we call `scrollIntoView` on the
     sentinel — the browser walks up to find the actual scrolling ancestor
     itself (could be our wrapper, could be Obsidian's view-content), so we
     don't have to guess.
   - An IntersectionObserver watches the sentinel. When it leaves the
     viewport, the user has scrolled up; when it returns, stickiness re-
     engages. This is the standard chat-app pattern and avoids the rAF /
     scrollHeight-mismatch races we had with the previous approach. */
export class MessageListRenderer {
  private app: App;
  private component: Component;
  private container: HTMLElement;
  private bottomSentinel: HTMLElement;
  private liveEls = new Map<string, { root: HTMLElement; content: HTMLElement }>();
  private toolEls = new Map<string, HTMLElement>();
  /* Per-message render chain. `renderContent` awaits MarkdownRenderer.render,
     opening a race window where two concurrent upserts can both clear pre-await
     DOM and both append. Serializing per-id removes the window structurally
     rather than patching symptoms downstream (footer dedup, etc.). */
  private renderChains = new Map<string, Promise<void>>();
  /* Sticky per-message override for the thinking-block toggle. Set when the
     user clicks the header. Survives the empty()+rebuild cycle that happens
     on every streaming delta, so a user-collapsed block doesn't auto-reopen
     on the next token. Absent = use the streaming default. */
  private thinkingOpenOverride = new Map<string, boolean>();
  /* Sticky per-tool override for the subagent timeline toggle, keyed by Task
     tool id. Same rationale as thinkingOpenOverride: the subagent summary is
     rebuilt on every nested-event delta, so a user-expanded (or collapsed)
     timeline must survive the rebuild. Absent = use the default (collapsed). */
  private subagentEventsOpenOverride = new Map<string, boolean>();
  private stickToBottom = true;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private actionCallbacks: MessageActionCallbacks | null = null;
  /* Optional element kept positioned immediately before bottomSentinel on
     every layout pass — used to trail the status pill at the end of the
     visible message stream. Reference survives reset() so we can re-attach. */
  private tailEl: HTMLElement | null = null;

  constructor(app: App, component: Component, container: HTMLElement) {
    this.app = app;
    this.component = component;
    this.container = container;
    this.bottomSentinel = container.createDiv({ cls: "claudian-bottom-sentinel" });

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.pinIfSticky());
      this.resizeObserver.observe(this.container);
    }
    if (typeof IntersectionObserver !== "undefined") {
      /* Threshold 0.01 means "any pixel of the sentinel is visible" — that
         counts as being at the bottom. Margin of 80px lets the user be
         slightly off-bottom and still trigger stickiness. */
      this.intersectionObserver = new IntersectionObserver(
        entries => {
          for (const entry of entries) {
            this.stickToBottom = entry.isIntersecting;
          }
        },
        { root: null, rootMargin: "0px 0px 80px 0px", threshold: 0.01 }
      );
      this.intersectionObserver.observe(this.bottomSentinel);
    }
  }

  destroy() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
  }

  setActionCallbacks(cb: MessageActionCallbacks) {
    this.actionCallbacks = cb;
  }

  reset() {
    this.container.empty();
    this.bottomSentinel = this.container.createDiv({ cls: "claudian-bottom-sentinel" });
    this.intersectionObserver?.disconnect();
    if (typeof IntersectionObserver !== "undefined") {
      this.intersectionObserver = new IntersectionObserver(
        entries => {
          for (const entry of entries) {
            this.stickToBottom = entry.isIntersecting;
          }
        },
        { root: null, rootMargin: "0px 0px 80px 0px", threshold: 0.01 }
      );
      this.intersectionObserver.observe(this.bottomSentinel);
    }
    this.liveEls.clear();
    this.toolEls.clear();
    this.thinkingOpenOverride.clear();
    this.subagentEventsOpenOverride.clear();
    /* Clear render chains too: a doUpsert queued behind an in-flight
       MarkdownRenderer.render await would otherwise re-run after reset, miss
       the now-empty liveEls, and re-append a fresh bubble — resurrecting a
       message /clear was meant to remove. Dropping the chain map detaches the
       stale promise so a late render can't re-enter the cleared container. */
    this.renderChains.clear();
    this.stickToBottom = true;
    /* Container was emptied above; re-insert the tracked tail element so the
       status pill survives /clear and new-chat resets. */
    this.pinTail();
  }

  /* Register an element (typically the status pill) to be kept just before
     the bottom sentinel on every layout pass. Pass null to detach. */
  setTailEl(el: HTMLElement | null) {
    this.tailEl = el;
    this.pinTail();
  }

  private pinTail() {
    if (!this.tailEl) return;
    if (this.tailEl.parentElement !== this.container ||
        this.bottomSentinel.previousSibling !== this.tailEl) {
      this.container.insertBefore(this.tailEl, this.bottomSentinel);
    }
  }

  /* Public hook for callers that want to pin scroll regardless of the user's
     current position — e.g. when they hit Send, the view should follow the
     new message even if they were reading scrolled-up history. */
  forceStickToBottom() {
    this.stickToBottom = true;
    this.pinIfSticky();
  }

  private pinIfSticky() {
    /* Trailing-order enforcement runs every layout pass regardless of scroll
       state: sentinel must be the absolute last child, and the tail (status
       pill) sits immediately before it. New bubbles are appended via
       createDiv which lands them at the container end, so without this they
       would slot in after the sentinel/tail. */
    if (this.bottomSentinel.parentElement !== this.container ||
        this.container.lastChild !== this.bottomSentinel) {
      this.container.appendChild(this.bottomSentinel);
    }
    this.pinTail();

    if (!this.stickToBottom) return;
    /* scrollIntoView reliably places the sentinel at the visible end of its
       scrollable ancestor. The accompanying CSS rule `view-content { overflow:
       hidden }` keeps it from climbing past our messages wrapper into Obsidian
       chrome, so the header/tab bar stay locked. */
    this.bottomSentinel.scrollIntoView({ block: "end", behavior: "auto" });
  }

  async upsertMessage(msg: ChatMessage) {
    /* Serialize per-message: queue this upsert behind any in-flight chain for
       the same id so MarkdownRenderer.render's await can never interleave with
       another upsert clearing the same content element. GC the map entry once
       the chain settles so long-lived sessions don't leak. */
    const prev = this.renderChains.get(msg.id) ?? Promise.resolve();
    const next = prev.then(() => this.doUpsert(msg));
    this.renderChains.set(msg.id, next);
    next.finally(() => {
      if (this.renderChains.get(msg.id) === next) this.renderChains.delete(msg.id);
    });
    await next;
  }

  /* Tear down all DOM and bookkeeping for a single message. Used when a
     preamble pass is being folded into the following pass (interleaved
     thinking can produce two adjacent assistant bubbles where the first is
     a strict-prefix duplicate of the second). Also sweeps any tool elements
     nested inside the bubble so their entries in toolEls don't dangle. */
  removeMessage(id: string) {
    const entry = this.liveEls.get(id);
    if (!entry) return;
    for (const [toolId, toolEl] of Array.from(this.toolEls)) {
      if (entry.root.contains(toolEl)) {
        this.toolEls.delete(toolId);
        this.subagentEventsOpenOverride.delete(toolId);
      }
    }
    entry.root.remove();
    this.liveEls.delete(id);
    this.thinkingOpenOverride.delete(id);
    this.renderChains.delete(id);
  }

  private async doUpsert(msg: ChatMessage) {
    let entry = this.liveEls.get(msg.id);
    if (!entry) {
      entry = this.createBubble(msg);
      this.liveEls.set(msg.id, entry);
    }
    await this.renderContent(entry.content, msg);
    /* renderContent awaits MarkdownRenderer; removeMessage() (preamble fold)
       can run during that await, detaching entry.root and clearing liveEls. If
       so, bail — otherwise we write to a detached bubble and re-register this
       message's tools in toolEls pointing at orphaned DOM. */
    if (this.liveEls.get(msg.id) !== entry) return;
    if (msg.toolCalls) {
      for (const tool of msg.toolCalls) {
        this.upsertTool(entry.root, tool);
      }
    }
    this.scrollToBottom();
  }

  upsertTool(parentEl: HTMLElement, tool: ToolCall) {
    let toolEl = this.toolEls.get(tool.id);
    if (!toolEl) {
      toolEl = parentEl.createDiv({ cls: "claudian-tool-call", attr: { "data-tool-id": tool.id } });
      const header = toolEl.createDiv({ cls: "claudian-tool-header" });
      const icon = header.createSpan({ cls: "claudian-tool-icon" });
      setIcon(icon, this.iconForTool(tool.name));
      header.createSpan({ cls: "claudian-tool-name", text: tool.name });
      /* Inline subject (e.g. "cortex", "Cortex.md", "git status") shown
         next to the tool name so the row reads as one compact phrase. */
      header.createSpan({ cls: "claudian-tool-subject" });
      /* Status surfaces as a tiny right-aligned icon (check / x /
         loader / shield-off) instead of an uppercase text badge. */
      header.createSpan({ cls: "claudian-tool-status" });
      toolEl.createDiv({ cls: "claudian-tool-content" });
      this.toolEls.set(tool.id, toolEl);

      /* Click the header to toggle. Default is collapsed — content is shown
         only on demand so giant Read/Skill results don't dominate the chat.
         Record the user's intent via `is-user-toggled` so the running-tool
         auto-expand guard below leaves their choice alone across the per-delta
         rebuild — without it a user-collapsed running row snaps back open. */
      header.addEventListener("click", () => {
        toolEl!.toggleClass("is-expanded", !toolEl!.hasClass("is-expanded"));
        toolEl!.addClass("is-user-toggled");
      });
    }
    const subjectEl = toolEl.querySelector(".claudian-tool-subject") as HTMLElement;
    const subject = this.subjectForTool(tool);
    subjectEl.setText(subject ?? "");
    subjectEl.toggleClass("is-empty", !subject);

    const statusEl = toolEl.querySelector(".claudian-tool-status") as HTMLElement;
    statusEl.empty();
    /* Drop any prior status-* class so the color resets between transitions. */
    statusEl.className = "claudian-tool-status";
    statusEl.addClass(`status-${tool.status}`);
    const statusIcon = this.iconForStatus(tool.status, tool.isError);
    if (statusIcon) setIcon(statusEl, statusIcon);
    statusEl.setAttr("aria-label", this.labelForStatus(tool.status));

    /* Auto-expand on first sight while running (so the user sees what's about
       to execute) and on error (so they don't have to click to find what
       failed). Collapse on successful completion. Exception: Task/Agent spawns
       render their own summary (description + live timeline) above the content,
       so auto-expanding their raw prompt JSON just adds noise — leave it
       collapsed and let the summary carry the live state. */
    const isSpawn = tool.name === "Task" || tool.name === "Agent";
    /* A terminal transition (error or completion) is a fresh system-driven
       state change, so clear the user's running-tool toggle intent and let the
       error/complete rules below decide expansion. While still running the
       flag is preserved so a user-collapsed row stays collapsed. */
    if (tool.isError || tool.status === "completed") {
      toolEl.removeClass("is-user-toggled");
    }
    if (tool.isError) {
      toolEl.addClass("is-expanded");
    } else if (tool.status === "completed") {
      /* Only collapse if the user hasn't explicitly toggled — we leave their
         choice in place by checking if the element is already in a stable
         state. Since toggling a not-yet-expanded element just adds the class,
         absence of `is-expanded` here means we should leave it absent. */
      /* no-op: keep current state */
    } else if (tool.status === "running" && !isSpawn && !toolEl.hasClass("is-user-toggled")) {
      toolEl.addClass("is-expanded");
    }

    /* TodoWrite gets special treatment — render the list outside the
       collapsed content area so the user always sees the current todos
       without clicking to expand. */
    const isTodoWrite = tool.name === "TodoWrite";
    const existingTodos = toolEl.querySelector(".claudian-todo-list-container");
    if (existingTodos) existingTodos.remove();
    if (isTodoWrite) {
      this.renderTodoList(toolEl, tool);
    }

    /* Task / Agent tool (subagent invocation) — render the subagent type +
       the short description above the collapsed prompt so the user can see
       at a glance what was delegated, without having to expand. The tool
       name varies by CLI version: Claude Code 2.1.141 emitted "Task";
       2.1.143+ emits "Agent". Match both. */
    const isSubagentSpawn = tool.name === "Task" || tool.name === "Agent";
    const existingSubagent = toolEl.querySelector(".claudian-subagent-summary");
    if (existingSubagent) existingSubagent.remove();
    if (isSubagentSpawn) {
      this.renderSubagentSummary(toolEl, tool);
    }

    /* Edit / MultiEdit / Write tools — render the proposed change as a
       unified diff above the collapsed body, always visible. The collapsed
       content area still holds the raw input JSON for power users. */
    const existingDiff = toolEl.querySelector(".claudian-diff");
    if (existingDiff) existingDiff.remove();
    this.renderToolDiff(toolEl, tool);

    const contentEl = toolEl.querySelector(".claudian-tool-content") as HTMLElement;
    contentEl.empty();
    const inputPreview = this.previewInput(tool);
    if (inputPreview) contentEl.createDiv({ cls: "claudian-tool-input", text: inputPreview });
    if (tool.result) {
      const resultEl = contentEl.createDiv({
        cls: tool.isError ? "claudian-tool-result-row claudian-tool-result-error" : "claudian-tool-result-row",
      });
      resultEl.createSpan({ cls: "claudian-tool-result-text", text: tool.result });
      /* When a successful result lands, collapse back to compact form so the
         chat doesn't get swamped. Errors stay expanded. */
      if (!tool.isError && tool.status === "completed") {
        toolEl.removeClass("is-expanded");
      }
    }
  }

  /* Renders the TodoWrite tool's `todos` array as a checkbox list. Statuses:
     pending, in_progress, completed, cancelled. The list lives outside the
     collapsible content area so it's always visible. */
  private renderTodoList(toolEl: HTMLElement, tool: ToolCall) {
    const todos = (tool.input as { todos?: Array<{ content?: string; status?: string; activeForm?: string }> }).todos;
    if (!Array.isArray(todos) || todos.length === 0) return;
    const container = createDiv({ cls: "claudian-todo-list-container" });
    /* Insert after the header so the list sits between the header and the
       collapsible content area. */
    const header = toolEl.querySelector(".claudian-tool-header");
    if (header && header.nextSibling) {
      toolEl.insertBefore(container, header.nextSibling);
    } else {
      toolEl.appendChild(container);
    }
    for (const todo of todos) {
      const item = container.createDiv({ cls: `claudian-todo-item status-${todo.status ?? "pending"}` });
      const iconEl = item.createSpan({ cls: "claudian-todo-status-icon" });
      const iconName = this.iconForTodoStatus(todo.status);
      setIcon(iconEl, iconName);
      const text = item.createSpan({ cls: "claudian-todo-text" });
      /* Use activeForm if the todo is currently in progress and the SDK gave
         us one ("Reading file" vs "Read file"); otherwise the static content. */
      const label = todo.status === "in_progress" && todo.activeForm ? todo.activeForm : (todo.content ?? "");
      text.setText(label);
    }
  }

  /* Wraps the DiffRenderer helpers for the supported edit-shaped tools.
     The diff lives between the header and the collapsible content. */
  private renderToolDiff(toolEl: HTMLElement, tool: ToolCall) {
    const input = (tool.input ?? {}) as Record<string, unknown>;
    let block: HTMLElement | null = null;
    if (tool.name === "Edit" || tool.name === "MultiEdit") {
      const ops = editOpsFromInput(tool.name, input);
      if (!ops || ops.length === 0) return;
      const target = document.createElement("div");
      renderDiff(target, ops, {
        filePath: typeof input.file_path === "string" ? input.file_path : undefined,
        numbered: tool.name === "MultiEdit" && ops.length > 1,
      });
      block = target.firstElementChild as HTMLElement | null;
    } else if (tool.name === "Write") {
      if (typeof input.file_path !== "string" || typeof input.content !== "string") return;
      const target = document.createElement("div");
      renderWritePreview(target, input.file_path, input.content);
      block = target.firstElementChild as HTMLElement | null;
    }
    if (!block) return;
    const header = toolEl.querySelector(".claudian-tool-header");
    if (header && header.nextSibling) {
      toolEl.insertBefore(block, header.nextSibling);
    } else {
      toolEl.appendChild(block);
    }
  }

  private iconForTodoStatus(status: string | undefined): string {
    switch (status) {
      case "completed": return "check-circle-2";
      case "in_progress": return "loader-circle";
      case "cancelled": return "circle-x";
      default: return "circle";
    }
  }

  private createBubble(msg: ChatMessage): { root: HTMLElement; content: HTMLElement } {
    /* Wrap each message in a flex-column container so out-of-bubble
       affordances (the selection flag) can sit above the bubble while
       keeping the bubble's right-alignment for user messages. */
    const wrapper = this.container.createDiv({
      cls: `claudian-message-wrapper claudian-message-wrapper-${msg.role}`,
    });
    if (msg.role === "user" && msg.selectionContext) {
      this.renderSelectionFlag(wrapper, msg.selectionContext);
    }
    const root = wrapper.createDiv({
      cls: `claudian-message claudian-message-${msg.role}`,
      attr: { "data-message-id": msg.id, "data-role": msg.role },
    });
    const content = root.createDiv({ cls: "claudian-message-content", attr: { dir: "auto" } });
    this.attachMessageActions(root, msg);
    return { root, content };
  }

  /* Small pill-shaped flag rendered above the user's bubble showing the
     file and line range of the selection they attached. The bubble itself
     stays clean — only the user's typed text shows inside it. */
  private renderSelectionFlag(parent: HTMLElement, ctx: NonNullable<ChatMessage["selectionContext"]>) {
    const flag = parent.createDiv({ cls: "claudian-selection-flag" });
    const iconEl = flag.createSpan({ cls: "claudian-selection-flag-icon" });
    setIcon(iconEl, "text-cursor");
    const fileName = ctx.filePath.split("/").pop() ?? ctx.filePath;
    const range = ctx.startLine === ctx.endLine
      ? `line ${ctx.startLine}`
      : `lines ${ctx.startLine}–${ctx.endLine}`;
    flag.createSpan({ cls: "claudian-selection-flag-text", text: `Selected from ${fileName} · ${range}` });
    flag.setAttr("title", `${ctx.filePath} · ${range}`);
  }

  /* Per-message action toolbar — hidden until the message is hovered. Has a
     fork button (creates a new tab branching from this point) and a copy
     button (copies the message text). The toolbar is positioned absolutely
     in the top-right of the bubble via CSS. */
  private attachMessageActions(root: HTMLElement, msg: ChatMessage) {
    const bar = root.createDiv({ cls: "claudian-message-actions" });

    const forkBtn = bar.createSpan({
      cls: "claudian-message-action",
      attr: { "aria-label": "Fork from here", title: "Fork into a new tab" },
    });
    setIcon(forkBtn, "git-branch");
    forkBtn.addEventListener("click", e => {
      e.stopPropagation();
      this.actionCallbacks?.onFork(msg.id);
    });

    const copyBtn = bar.createSpan({
      cls: "claudian-message-action",
      attr: { "aria-label": "Copy message", title: "Copy message text" },
    });
    setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", e => {
      e.stopPropagation();
      const live = this.container.querySelector(`[data-message-id="${msg.id}"]`);
      const text = (live as HTMLElement | null)?.querySelector(".claudian-text-block")?.textContent ?? msg.content;
      void navigator.clipboard.writeText(text);
      new Notice("Copied message");
    });
  }

  private async renderContent(el: HTMLElement, msg: ChatMessage) {
    el.empty();
    /* Clear any previously rendered out-of-bubble attachments row so a
       re-render can re-decide placement based on current msg state. */
    const wrapper = el.closest(".claudian-message-wrapper") as HTMLElement | null;
    wrapper?.querySelector(":scope > .claudian-message-attachments")?.remove();

    const hasAttachments = !!(msg.attachments && msg.attachments.length > 0);
    const hasUserText = msg.role === "user" && !!msg.content && msg.content.trim().length > 0;
    /* User messages with both an image and text: lift the image out of the
       bubble so the bubble can size itself to the text alone. The wrapper's
       align-items: flex-end keeps the image right-aligned and tight to its
       intrinsic width. Image-only user messages stay inside the bubble where
       the bubble hugs the image nicely. */
    const liftAttachmentsAboveBubble = hasAttachments && hasUserText;

    const renderAttachmentInto = (parent: HTMLElement, att: Attachment) => {
      const kind = att.kind ?? "image";
      if (kind === "image") {
        if (att.data) {
          const img = parent.createEl("img", { cls: "claudian-message-attachment" });
          img.src = `data:${att.mediaType};base64,${att.data}`;
          img.alt = att.filename ?? "Pasted image";
          return;
        }
        /* Image attachment with no data — defensive path. Render as a chip
           with the image icon so the user still sees "an image was here"
           rather than misleading "file" iconography. */
        const chip = parent.createDiv({ cls: "claudian-message-attachment claudian-message-attachment-file" });
        const iconEl = chip.createSpan({ cls: "claudian-message-attachment-icon" });
        setIcon(iconEl, "image");
        const label = att.filename ?? "Image (data missing)";
        chip.createSpan({ cls: "claudian-message-attachment-label", text: label, attr: { title: label } });
        return;
      }
      /* pdf / text — render as a compact file chip. Same visual treatment for
         both; only the icon differs so the user can scan-distinguish. */
      const chip = parent.createDiv({ cls: "claudian-message-attachment claudian-message-attachment-file" });
      const iconEl = chip.createSpan({ cls: "claudian-message-attachment-icon" });
      setIcon(iconEl, kind === "pdf" ? "file-text" : "file");
      const label = att.filename ?? (kind === "pdf" ? "document.pdf" : "file");
      chip.createSpan({ cls: "claudian-message-attachment-label", text: label, attr: { title: label } });
    };

    if (hasAttachments && !liftAttachmentsAboveBubble) {
      const attRow = el.createDiv({ cls: "claudian-message-attachments" });
      for (const att of msg.attachments!) renderAttachmentInto(attRow, att);
    }
    if (liftAttachmentsAboveBubble && wrapper) {
      const bubbleRoot = el.parentElement;
      const attRow = createDiv({ cls: "claudian-message-attachments claudian-message-attachments-above" });
      for (const att of msg.attachments!) renderAttachmentInto(attRow, att);
      if (bubbleRoot) wrapper.insertBefore(attRow, bubbleRoot);
      else wrapper.appendChild(attRow);
    }

    if (msg.role === "user") {
      if (msg.content) el.createDiv({ cls: "claudian-text-block", text: msg.content });
    } else {
      if (msg.thinking) {
        this.renderThinking(el, msg);
      }
      const block = el.createDiv({ cls: "claudian-text-block" });
      if (msg.content.trim().length > 0) {
        await MarkdownRenderer.render(this.app, msg.content, block, "", this.component);
        this.wireInternalLinks(block);
      }
      if (msg.durationMs !== undefined && !msg.streaming && this.passHasVisibleContent(msg)) {
        /* Idempotent: concurrent upserts can both cross the MarkdownRenderer
           await above, and the later el.empty() only wipes pre-await DOM.
           Drop any prior footer before appending so the second arrival
           replaces instead of stacks. */
        el.querySelector(":scope > .claudian-thought-duration")?.remove();
        el.createDiv({ cls: "claudian-thought-duration", text: `Thought for ${this.formatDuration(msg.durationMs)}` });
      }
    }
  }

  /* MarkdownRenderer renders `[[Cortex]]` as `<a class="internal-link">`
     but does NOT wire click behavior — that's normally MarkdownView's job.
     We attach it ourselves so wikilinks open the target note. Because the
     chat lives in a sidebar pane, we force `paneType: "tab"` so plain
     clicks don't replace the sidebar with the file. Hover triggers the
     "hover-link" event so the Page Preview core plugin shows its tile. */
  private wireInternalLinks(container: HTMLElement) {
    const links = container.querySelectorAll<HTMLAnchorElement>("a.internal-link");
    for (const a of Array.from(links)) {
      const linkpath = a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
      if (!linkpath) continue;
      a.addEventListener("click", e => {
        e.preventDefault();
        e.stopPropagation();
        /* Mirror Obsidian's modifier rules: Cmd/Ctrl+Shift opens a split,
           plain click and bare Cmd/Ctrl both open a new tab in the main
           editor area (sidebar-originated openLeaf("tab") routes there). */
        const split = (e.metaKey || e.ctrlKey) && e.shiftKey;
        void this.app.workspace.openLinkText(linkpath, "", split ? "split" : "tab");
      });
      a.addEventListener("auxclick", e => {
        if (e.button !== 1) return;
        e.preventDefault();
        void this.app.workspace.openLinkText(linkpath, "", "tab");
      });
      a.addEventListener("mouseover", event => {
        this.app.workspace.trigger("hover-link", {
          event,
          source: "claude-cli-chat",
          hoverParent: this.component,
          targetEl: a,
          linktext: linkpath,
          sourcePath: "",
        });
      });
    }
  }

  /* Collapsible "Thinking" section. Open while streaming so the user can
     watch the reasoning build up; collapses to a one-line summary once the
     thinking block finalizes. Clicking the header toggles open/closed. */
  private renderThinking(el: HTMLElement, msg: ChatMessage) {
    const wrap = el.createDiv({
      cls: "claudian-thinking-block" + (msg.thinkingStreaming ? " is-streaming" : ""),
    });
    const header = wrap.createDiv({ cls: "claudian-thinking-header" });
    const chevron = header.createSpan({ cls: "claudian-thinking-chevron" });
    setIcon(chevron, "chevron-down");
    header.createSpan({
      cls: "claudian-thinking-label",
      text: msg.thinkingStreaming ? "Thinking…" : "Thinking",
    });
    if (msg.thinkingStreaming) {
      header.createSpan({ cls: "claudian-thinking-pulse" });
    }
    const body = wrap.createDiv({ cls: "claudian-thinking-body" });
    body.setText(msg.thinking ?? "");
    /* Default: open while streaming, collapsed once complete. If the user
       has explicitly toggled the block, their choice wins and survives the
       per-delta rebuild via the thinkingOpenOverride map. */
    const userOverride = this.thinkingOpenOverride.get(msg.id);
    const startOpen = userOverride !== undefined ? userOverride : !!msg.thinkingStreaming;
    wrap.toggleClass("is-open", startOpen);
    header.addEventListener("click", () => {
      const nextOpen = !wrap.hasClass("is-open");
      wrap.toggleClass("is-open", nextOpen);
      this.thinkingOpenOverride.set(msg.id, nextOpen);
    });
    /* While thinking is streaming AND the block is currently open, keep the
       body pinned to the bottom so the latest tokens stay in view. Skip when
       the user has collapsed it — no point scrolling a hidden body. */
    if (msg.thinkingStreaming && startOpen) {
      requestAnimationFrame(() => {
        body.scrollTop = body.scrollHeight;
      });
    }
  }

  /* A pass earns the trailing "Thought for Ns" footer only when there's
     actual reasoning or prose to label. Tool-only passes (e.g. Skill + Read
     pre-amble before the model speaks) get nothing — the compact tool rows
     already convey what happened and the footer would just add height. */
  private passHasVisibleContent(msg: ChatMessage): boolean {
    if (msg.content.trim().length > 0) return true;
    if (msg.thinking && msg.thinking.trim().length > 0) return true;
    return false;
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return "<1s";
    const totalSec = Math.round(ms / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  }

  private iconForTool(name: string): string {
    switch (name) {
      case "Bash": return "terminal-square";
      case "Read": return "file-text";
      case "Write": return "file-plus";
      case "Edit": return "file-edit";
      case "Grep": return "search";
      case "Glob": return "search";
      case "WebFetch": return "globe";
      case "WebSearch": return "globe";
      case "Task": return "users";
      case "TodoWrite": return "list-checks";
      case "Skill": return "zap";
      default: return "wrench";
    }
  }

  private labelForStatus(status: ToolCall["status"]): string {
    switch (status) {
      case "pending": return "Awaiting approval";
      case "approved": return "Approved";
      case "denied": return "Denied";
      case "running": return "Running";
      case "completed": return "Completed";
      case "errored": return "Error";
    }
  }

  /* Tiny status glyph rendered on the right side of the compact tool row.
     Picks a Lucide icon name; null means no icon (the slot collapses). */
  private iconForStatus(status: ToolCall["status"], isError?: boolean): string | null {
    if (isError) return "x";
    switch (status) {
      case "pending": return "shield-off";
      case "approved": return "shield-check";
      case "denied": return "shield-off";
      case "running": return "loader-circle";
      case "completed": return "check";
      case "errored": return "x";
    }
  }

  /* Returns the one-token phrase shown next to the tool name (e.g. "Read
     Cortex.md", "Skill cortex", "Bash git status"). Kept short — long
     paths and commands are truncated to ~48 chars with an ellipsis so the
     row stays on a single line in narrow side panes. */
  private subjectForTool(tool: ToolCall): string | null {
    const input = tool.input ?? {};
    const truncate = (s: string, n = 48) => s.length > n ? s.slice(0, n - 1) + "…" : s;
    const basename = (p: string) => {
      const trimmed = p.replace(/\/+$/, "");
      const idx = trimmed.lastIndexOf("/");
      return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
    };
    if (tool.name === "Skill" && typeof input.skill === "string") return truncate(input.skill);
    if (tool.name === "Bash" && typeof input.command === "string") return truncate(input.command.replace(/\s+/g, " ").trim());
    if (tool.name === "Task" && typeof input.subagent_type === "string") return truncate(input.subagent_type);
    if (tool.name === "TodoWrite" && Array.isArray((input as { todos?: unknown[] }).todos)) {
      const n = ((input as { todos?: unknown[] }).todos ?? []).length;
      return `${n} item${n === 1 ? "" : "s"}`;
    }
    if (tool.name === "WebFetch" && typeof input.url === "string") {
      try { return truncate(new URL(input.url).host); } catch { return truncate(input.url); }
    }
    if (tool.name === "WebSearch" && typeof input.query === "string") return truncate(input.query);
    if (typeof input.file_path === "string") return truncate(basename(input.file_path));
    if (typeof input.path === "string") return truncate(basename(input.path));
    if (typeof input.pattern === "string") return truncate(input.pattern);
    return null;
  }

  private previewInput(tool: ToolCall): string | null {
    const input = tool.input ?? {};
    if (tool.name === "Bash" && typeof input.command === "string") return `$ ${input.command}`;
    /* Task tool: the visible summary already shows description + subagent, so
       use the prompt as the expandable preview body. */
    if (tool.name === "Task" && typeof input.prompt === "string") return input.prompt;
    if (typeof input.path === "string") return input.path;
    if (typeof input.file_path === "string") return input.file_path;
    if (typeof input.pattern === "string") return input.pattern;
    try {
      const compact = JSON.stringify(input);
      if (compact && compact !== "{}") return compact.length > 240 ? compact.slice(0, 240) + "..." : compact;
    } catch {
      /* ignore */
    }
    return null;
  }

  /* Render the Task tool's subagent_type + description prominently in a
     summary block above the collapsed prompt. The header's title text also
     gets retitled to "Task → <subagent_type>" so the row scans clearly.
     When SubagentSessionTracker has populated nestedEvents, this also
     renders a nested timeline of what the subagent did (text/thinking/tool
     calls) plus a status line with elapsed duration. */
  private renderSubagentSummary(toolEl: HTMLElement, tool: ToolCall) {
    const input = tool.input as { subagent_type?: string; description?: string; prompt?: string };
    const subagentType = input.subagent_type ?? "agent";
    const description = input.description ?? "";

    /* Retitle the header's tool name to make the subagent visible at a glance.
       Use the actual tool name as prefix so the row reads correctly across
       CLI versions ("Task → general-purpose" vs "Agent → general-purpose"). */
    const nameEl = toolEl.querySelector(".claudian-tool-name") as HTMLElement | null;
    if (nameEl) nameEl.setText(`${tool.name} → ${subagentType}`);

    const eventCount = (tool.nestedEvents?.length ?? 0) + (tool.nestedTruncatedCount ?? 0);
    const hasEvents = eventCount > 0;
    const hasNestedSurface = !!description || tool.nestedStatus !== undefined || hasEvents;
    if (!hasNestedSurface) return;

    const container = createDiv({ cls: "claudian-subagent-summary" });
    if (description) {
      container.createDiv({ cls: "claudian-subagent-description", text: description });
    }

    /* Default the timeline collapsed so a busy subagent doesn't flood the
       chat with its internal steps. The toggle row + current-activity preview
       keep the live state legible at a glance; expand for the full timeline.
       A user's explicit toggle (stored per tool id) overrides the default and
       survives the per-delta rebuild. */
    const override = this.subagentEventsOpenOverride.get(tool.id);
    const isOpen = hasEvents && (override !== undefined ? override : false);
    container.toggleClass("is-events-open", isOpen);

    /* Toggle row: chevron (only when there's a timeline to expand) + status
       label + step count + a running pulse. Clicking it flips the timeline. */
    if (tool.nestedStatus || hasEvents) {
      const toggle = container.createDiv({
        cls: `claudian-subagent-toggle is-${tool.nestedStatus ?? "running"}`,
      });
      if (hasEvents) {
        const chevron = toggle.createSpan({ cls: "claudian-subagent-chevron" });
        setIcon(chevron, "chevron-down");
      }
      toggle.createSpan({
        cls: "claudian-subagent-toggle-label",
        text: this.subagentStatusLabel(tool) || "Running",
      });
      if (hasEvents) {
        toggle.createSpan({
          cls: "claudian-subagent-step-count",
          text: `${eventCount} step${eventCount === 1 ? "" : "s"}`,
        });
      }
      if (tool.nestedStatus === "running" || tool.nestedStatus === "spawning") {
        toggle.createSpan({ cls: "claudian-subagent-pulse" });
      }
      if (hasEvents) {
        toggle.addEventListener("click", () => {
          const next = !container.hasClass("is-events-open");
          container.toggleClass("is-events-open", next);
          this.subagentEventsOpenOverride.set(tool.id, next);
          if (next) this.scrollToBottom();
        });
      }
    }

    /* Collapsed view: a single live line showing the subagent's latest step,
       so the user still sees "what is it doing now" without the wall of text.
       Only while the subagent is live — once it finishes, the status label +
       step count carry the summary and a "current step" line would mislead. */
    const isLive = tool.nestedStatus !== "completed" && tool.nestedStatus !== "failed";
    if (hasEvents && !isOpen && isLive) {
      const current = this.latestActivity(tool);
      if (current) {
        container.createDiv({ cls: "claudian-subagent-current", text: current });
      }
    }

    /* Full nested events timeline. Always built when events exist; CSS hides
       the wrapper unless the summary carries `is-events-open`. */
    if (hasEvents) {
      const eventsWrap = container.createDiv({ cls: "claudian-subagent-events-wrap" });
      const events = eventsWrap.createDiv({ cls: "claudian-subagent-events" });
      if ((tool.nestedTruncatedCount ?? 0) > 0) {
        events.createDiv({
          cls: "claudian-subagent-events-truncated",
          text: `+${tool.nestedTruncatedCount} earlier events dropped`,
        });
      }
      for (const evt of tool.nestedEvents ?? []) {
        this.renderNestedEvent(events, evt);
      }
    }

    const header = toolEl.querySelector(".claudian-tool-header");
    if (header && header.nextSibling) {
      toolEl.insertBefore(container, header.nextSibling);
    } else {
      toolEl.appendChild(container);
    }
  }

  private subagentStatusLabel(tool: ToolCall): string {
    const dur = tool.nestedDurationMs;
    const durStr = dur !== undefined ? ` · ${this.formatDuration(dur)}` : "";
    switch (tool.nestedStatus) {
      case "spawning": return "Spawning subagent…";
      case "running":  return `Running${durStr}`;
      case "completed": return `Completed${durStr}`;
      case "failed":   return `Failed${durStr}`;
      default: return "";
    }
  }

  private renderNestedEvent(parent: HTMLElement, evt: NestedSubagentEvent) {
    const row = parent.createDiv({ cls: "claudian-subagent-event" });
    if (evt.kind === "text") {
      row.createDiv({ cls: "claudian-subagent-event-text", text: evt.text });
    } else if (evt.kind === "thinking") {
      row.createDiv({ cls: "claudian-subagent-event-thinking", text: evt.text });
    } else if (evt.kind === "tool_use") {
      const toolRow = row.createDiv({ cls: "claudian-subagent-event-tool" });
      toolRow.createSpan({ cls: "claudian-subagent-event-tool-name", text: evt.name });
      const subject = this.nestedToolSubject(evt);
      if (subject) toolRow.createSpan({ text: ` ${subject}` });
      toolRow.createSpan({
        cls: "claudian-subagent-event-tool-status",
        text: ` [${evt.status}${evt.isError ? " · err" : ""}]`,
      });
    }
  }

  /* Best-effort subject string for a nested tool row. Mirrors subjectForTool's
     intent — pick a short identifier (file_path / pattern / command) — but
     stays scoped to the nested rendering so a future change in subjectForTool
     doesn't accidentally reflow the timeline. */
  private nestedToolSubject(evt: Extract<NestedSubagentEvent, { kind: "tool_use" }>): string | null {
    const input = evt.input as { file_path?: string; path?: string; command?: string; pattern?: string; subagent_type?: string };
    if (typeof input.file_path === "string") return input.file_path;
    if (typeof input.path === "string") return input.path;
    if (typeof input.command === "string") return input.command.length > 80 ? input.command.slice(0, 80) + "…" : input.command;
    if (typeof input.pattern === "string") return input.pattern;
    if (typeof input.subagent_type === "string") return input.subagent_type;
    return null;
  }

  /* One-line summary of the subagent's most recent step, shown while the
     timeline is collapsed. Mirrors the timeline's own formatting (tool name +
     subject, or the first line of a text/thinking delta) but kept to a single
     truncated line so the collapsed summary stays compact. */
  private latestActivity(tool: ToolCall): string | null {
    const events = tool.nestedEvents;
    if (!events || events.length === 0) return null;
    const last = events[events.length - 1];
    const oneLine = (s: string, n = 72) => {
      const flat = s.replace(/\s+/g, " ").trim();
      return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
    };
    if (last.kind === "text" || last.kind === "thinking") {
      const text = oneLine(last.text);
      return text || null;
    }
    if (last.kind === "tool_use") {
      const subject = this.nestedToolSubject(last);
      const base = subject ? `${last.name} ${subject}` : last.name;
      const tail = last.status === "running" ? "…" : "";
      return oneLine(base) + tail;
    }
    return null;
  }

  /* Explicit scroll trigger from upsertMessage. ResizeObserver handles
     streaming growth automatically; this catches in-place updates that
     don't change the container's size (e.g. tool status badge update). */
  private scrollToBottom() {
    this.pinIfSticky();
  }
}
