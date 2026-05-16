import { App, Component, MarkdownRenderer, Notice, setIcon } from "obsidian";
import type { ChatMessage, ToolCall } from "./state";
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
  /* Sticky per-message override for the thinking-block toggle. Set when the
     user clicks the header. Survives the empty()+rebuild cycle that happens
     on every streaming delta, so a user-collapsed block doesn't auto-reopen
     on the next token. Absent = use the streaming default. */
  private thinkingOpenOverride = new Map<string, boolean>();
  private stickToBottom = true;
  private resizeObserver: ResizeObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private actionCallbacks: MessageActionCallbacks | null = null;

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
    this.stickToBottom = true;
  }

  /* Public hook for callers that want to pin scroll regardless of the user's
     current position — e.g. when they hit Send, the view should follow the
     new message even if they were reading scrolled-up history. */
  forceStickToBottom() {
    this.stickToBottom = true;
    this.pinIfSticky();
  }

  private pinIfSticky() {
    if (!this.stickToBottom) return;
    /* Keep the sentinel as the absolute last child — message bubbles get
       appended via createDiv which appends to the end, so we need to move
       the sentinel back after them. */
    if (this.bottomSentinel.parentElement !== this.container ||
        this.container.lastChild !== this.bottomSentinel) {
      this.container.appendChild(this.bottomSentinel);
    }
    /* scrollIntoView reliably places the sentinel at the visible end of its
       scrollable ancestor. The accompanying CSS rule `view-content { overflow:
       hidden }` keeps it from climbing past our messages wrapper into Obsidian
       chrome, so the header/tab bar stay locked. */
    this.bottomSentinel.scrollIntoView({ block: "end", behavior: "auto" });
  }

  async upsertMessage(msg: ChatMessage) {
    let entry = this.liveEls.get(msg.id);
    if (!entry) {
      entry = this.createBubble(msg);
      this.liveEls.set(msg.id, entry);
    }
    await this.renderContent(entry.content, msg);
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
      header.createSpan({ cls: "claudian-tool-status" });
      const chevron = header.createSpan({ cls: "claudian-tool-chevron" });
      setIcon(chevron, "chevron-down");
      toolEl.createDiv({ cls: "claudian-tool-content" });
      this.toolEls.set(tool.id, toolEl);

      /* Click the header to toggle. Default is collapsed — content is shown
         only on demand so giant Read/Skill results don't dominate the chat. */
      header.addEventListener("click", () => {
        toolEl!.toggleClass("is-expanded", !toolEl!.hasClass("is-expanded"));
      });
    }
    const statusEl = toolEl.querySelector(".claudian-tool-status") as HTMLElement;
    statusEl.empty();
    statusEl.addClass(`status-${tool.status}`);
    statusEl.setText(this.labelForStatus(tool.status));

    /* Auto-expand on first sight while running (so the user sees what's about
       to execute) and on error (so they don't have to click to find what
       failed). Collapse on successful completion. */
    if (tool.isError) {
      toolEl.addClass("is-expanded");
    } else if (tool.status === "completed") {
      /* Only collapse if the user hasn't explicitly toggled — we leave their
         choice in place by checking if the element is already in a stable
         state. Since toggling a not-yet-expanded element just adds the class,
         absence of `is-expanded` here means we should leave it absent. */
      /* no-op: keep current state */
    } else if (tool.status === "running" && !toolEl.hasClass("is-user-toggled")) {
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

    /* Task tool (subagent invocation) — render the subagent type + the short
       description above the collapsed prompt so the user can see at a glance
       what was delegated, without having to expand. */
    const isTask = tool.name === "Task";
    const existingSubagent = toolEl.querySelector(".claudian-subagent-summary");
    if (existingSubagent) existingSubagent.remove();
    if (isTask) {
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
    if (msg.attachments && msg.attachments.length > 0) {
      const attRow = el.createDiv({ cls: "claudian-message-attachments" });
      for (const att of msg.attachments) {
        const img = attRow.createEl("img", { cls: "claudian-message-attachment" });
        img.src = `data:${att.mediaType};base64,${att.data}`;
        img.alt = "Pasted image";
      }
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
      }
      if (msg.durationMs !== undefined && !msg.streaming && this.passHasVisibleContent(msg)) {
        el.createDiv({ cls: "claudian-thought-duration", text: `Thought for ${this.formatDuration(msg.durationMs)}` });
      }
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

  /* A pass is worth labeling only if it produced something the user can see.
     Otherwise the bubble would collapse into a stray "Thought for Ns" line
     with nothing else in it. */
  private passHasVisibleContent(msg: ChatMessage): boolean {
    if (msg.content.trim().length > 0) return true;
    if (msg.thinking && msg.thinking.trim().length > 0) return true;
    if (msg.toolCalls && msg.toolCalls.length > 0) return true;
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
     gets retitled to "Task → <subagent_type>" so the row scans clearly. */
  private renderSubagentSummary(toolEl: HTMLElement, tool: ToolCall) {
    const input = tool.input as { subagent_type?: string; description?: string; prompt?: string };
    const subagentType = input.subagent_type ?? "agent";
    const description = input.description ?? "";

    /* Retitle the header's tool name to make the subagent visible at a glance. */
    const nameEl = toolEl.querySelector(".claudian-tool-name") as HTMLElement | null;
    if (nameEl) nameEl.setText(`Task → ${subagentType}`);

    if (!description) return;
    const container = createDiv({ cls: "claudian-subagent-summary" });
    container.createDiv({ cls: "claudian-subagent-description", text: description });
    const header = toolEl.querySelector(".claudian-tool-header");
    if (header && header.nextSibling) {
      toolEl.insertBefore(container, header.nextSibling);
    } else {
      toolEl.appendChild(container);
    }
  }

  /* Explicit scroll trigger from upsertMessage. ResizeObserver handles
     streaming growth automatically; this catches in-place updates that
     don't change the container's size (e.g. tool status badge update). */
  private scrollToBottom() {
    this.pinIfSticky();
  }
}
