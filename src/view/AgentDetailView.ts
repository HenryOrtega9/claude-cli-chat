import { platform } from "../platform";
import { truncateToolResult, type NestedSubagentEvent, type ToolCall } from "./state";
import { renderDetailEvent, updateDetailToolEvent, subagentStatusLabel, formatAgentDuration } from "./nestedEventRender";

export type AgentDetailCallbacks = {
  /* Fired only when the USER leaves the view (back button or Esc). A
     programmatic close() stays silent so a host handler that itself calls
     close() can't recurse. */
  onClose: () => void;
};

type NestedToolEvent = Extract<NestedSubagentEvent, { kind: "tool_use" }>;

/* Full-pane drill-in for a single agent (Task/Agent tool) run. Mounted on the
   tab's stable content root and display-toggled, same pattern as Welcome, so
   it overlays the whole tab rather than just the message list.

   Holds a live reference to the ToolCall, which TabController mutates in
   place as tracker updates land; refresh() then walks that same object. Safe
   because every reset/clear/teardown path in TabController closes this view
   before the tool objects are discarded.

   Runtime-only: nothing here is persisted, so incognito tabs are unaffected. */
export class AgentDetailView {
  private root: HTMLElement;
  private titleEl: HTMLElement;
  private descEl: HTMLElement;
  private statusEl: HTMLElement;
  private metaEl: HTMLElement;
  private transcriptEl: HTMLElement;
  private callbacks: AgentDetailCallbacks;

  private tool: ToolCall | null = null;
  private visible = false;

  /* Incremental-render bookkeeping. renderedEventCount is the append cursor
     into tool.nestedEvents; renderedTruncatedCount detects a buffer trim
     (which shifts every index and forces a full rebuild); renderedDegraded
     records which of the two transcript shapes is currently on screen so a
     host that starts producing events later can upgrade from the placeholder. */
  private renderedEventCount = 0;
  private renderedTruncatedCount = 0;
  private renderedDegraded = false;
  /* Nested tool rows keyed by the nested tool_use id, with a state key so an
     in-place update only touches rows whose status/result actually moved. */
  private toolRowEls = new Map<string, HTMLElement>();
  private toolRowKeys = new Map<string, string>();
  private promptBodyEl: HTMLElement | null = null;
  private resultEl: HTMLElement | null = null;
  private resultKey: string | null = null;
  private statusKey: string | null = null;

  /* Sticky-bottom autoscroll: appended events follow the transcript only while
     the user is already parked at the end. */
  private stickToBottom = true;
  private escListening = false;

  constructor(parentEl: HTMLElement, callbacks: AgentDetailCallbacks) {
    this.callbacks = callbacks;
    this.root = parentEl.createDiv({ cls: "claudian-agent-detail" });
    this.root.style.display = "none";

    const header = this.root.createDiv({ cls: "claudian-agent-detail-header" });
    const back = header.createDiv({
      cls: "claudian-agent-detail-back",
      attr: { role: "button", tabindex: "0", "aria-label": "Back", title: "Back (Esc)" },
    });
    const backIcon = back.createSpan();
    platform.setIcon(backIcon, "arrow-left");
    back.createSpan({ text: "Back" });
    back.addEventListener("click", () => this.userClose());
    back.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.userClose();
      }
    });

    this.titleEl = header.createDiv({ cls: "claudian-agent-detail-title" });
    this.descEl = header.createDiv({ cls: "claudian-agent-detail-desc" });
    this.statusEl = header.createDiv({ cls: "claudian-agent-detail-status" });
    this.metaEl = header.createDiv({ cls: "claudian-agent-detail-meta" });

    this.transcriptEl = this.root.createDiv({ cls: "claudian-agent-detail-transcript" });
    this.transcriptEl.addEventListener("scroll", () => {
      const el = this.transcriptEl;
      this.stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    });
  }

  open(tool: ToolCall): void {
    this.tool = tool;
    this.visible = true;
    this.root.style.display = "";
    this.stickToBottom = true;
    this.attachEsc();
    this.rebuild();
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }

  isOpenFor(toolId: string): boolean {
    return this.visible && this.tool?.id === toolId;
  }

  /* Idempotent, and deliberately silent — see AgentDetailCallbacks.onClose. */
  close(): void {
    this.detachEsc();
    if (!this.visible && this.tool === null) return;
    this.visible = false;
    this.root.style.display = "none";
    this.transcriptEl.empty();
    this.toolRowEls.clear();
    this.toolRowKeys.clear();
    this.promptBodyEl = null;
    this.resultEl = null;
    this.resultKey = null;
    this.statusKey = null;
    this.renderedEventCount = 0;
    this.renderedTruncatedCount = 0;
    this.renderedDegraded = false;
    this.tool = null;
  }

  refresh(): void {
    const tool = this.tool;
    if (!this.visible || !tool) return;

    this.renderHeader(tool);

    const truncated = tool.nestedTruncatedCount ?? 0;
    const events = tool.nestedEvents ?? [];
    /* A trim shifts every index, a degraded/live flip changes the transcript's
       whole shape, and a shrunken buffer means our cursor is meaningless —
       all three are cheaper to handle by rebuilding than by patching. */
    if (
      this.isDegraded(tool) !== this.renderedDegraded ||
      truncated !== this.renderedTruncatedCount ||
      events.length < this.renderedEventCount
    ) {
      this.rebuild();
      this.pinIfSticky();
      return;
    }

    /* Prompt fills in as input_json_delta parses, so keep it in sync without
       disturbing the user's expand/collapse. */
    this.syncPrompt(tool);

    if (!this.renderedDegraded) {
      for (let i = this.renderedEventCount; i < events.length; i++) {
        this.appendEvent(events[i]);
      }
      this.renderedEventCount = events.length;

      /* toolUseUpdates mutate already-rendered rows (status, result, isError).
         The buffer is capped at NESTED_EVENTS_CAP, so a full comparison pass
         is cheap and needs no separate dirty list. */
      for (const evt of events) {
        if (evt.kind !== "tool_use") continue;
        const row = this.toolRowEls.get(evt.id);
        if (!row) continue;
        const key = this.toolEventKey(evt);
        if (this.toolRowKeys.get(evt.id) === key) continue;
        this.toolRowKeys.set(evt.id, key);
        updateDetailToolEvent(row, evt);
      }
    }

    this.syncResult(tool);
    this.pinIfSticky();
  }

  /* ---- internals ---- */

  private userClose(): void {
    this.close();
    this.callbacks.onClose();
  }

  private escHandler = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !this.visible) return;
    /* The listener is on `document`, but a background tab's whole root is
       display:none'd on switch (TabController.hide) while this overlay stays
       logically open. Without this guard the hidden tab would swallow Escape
       from the visible tab's composer. offsetParent is null exactly when an
       ancestor is display:none. */
    if (this.root.offsetParent === null) return;
    /* Capture phase, so this beats InputBox's Escape-to-cancel binding while
       the overlay is up. Intended: Esc backs out of the drill-in first, and
       the overlay is covering the composer anyway. */
    e.preventDefault();
    e.stopPropagation();
    this.userClose();
  };

  private attachEsc(): void {
    if (this.escListening) return;
    document.addEventListener("keydown", this.escHandler, true);
    this.escListening = true;
  }

  private detachEsc(): void {
    if (!this.escListening) return;
    document.removeEventListener("keydown", this.escHandler, true);
    this.escListening = false;
  }

  private isDegraded(tool: ToolCall): boolean {
    return tool.nestedStatus === undefined && (tool.nestedEvents?.length ?? 0) === 0;
  }

  private toolEventKey(evt: NestedToolEvent): string {
    return `${evt.status}|${evt.isError ? 1 : 0}|${evt.result?.length ?? -1}`;
  }

  private toolInput(tool: ToolCall): { subagent_type?: string; description?: string; prompt?: string } {
    return tool.input as { subagent_type?: string; description?: string; prompt?: string };
  }

  private rebuild(): void {
    const tool = this.tool;
    if (!tool) return;

    this.renderHeader(tool);

    this.transcriptEl.empty();
    this.toolRowEls.clear();
    this.toolRowKeys.clear();
    this.promptBodyEl = null;
    this.resultEl = null;
    this.resultKey = null;

    this.renderPrompt(tool);

    if (this.isDegraded(tool)) {
      this.transcriptEl.createDiv({
        cls: "claudian-agent-detail-placeholder",
        text: "Live agent events aren't available on this host.",
      });
      this.renderedDegraded = true;
      this.renderedEventCount = 0;
      this.renderedTruncatedCount = tool.nestedTruncatedCount ?? 0;
      this.syncResult(tool);
      return;
    }

    const truncated = tool.nestedTruncatedCount ?? 0;
    if (truncated > 0) {
      this.transcriptEl.createDiv({
        cls: "claudian-agent-detail-truncated",
        text: `+${truncated} earlier events dropped`,
      });
    }

    const events = tool.nestedEvents ?? [];
    for (const evt of events) this.appendEvent(evt);

    this.renderedDegraded = false;
    this.renderedEventCount = events.length;
    this.renderedTruncatedCount = truncated;

    this.syncResult(tool);
  }

  private appendEvent(evt: NestedSubagentEvent): void {
    const row = renderDetailEvent(this.transcriptEl, evt);
    if (evt.kind === "tool_use") {
      this.toolRowEls.set(evt.id, row);
      this.toolRowKeys.set(evt.id, this.toolEventKey(evt));
    }
  }

  private renderHeader(tool: ToolCall): void {
    const input = this.toolInput(tool);
    this.titleEl.setText(`Agent → ${input.subagent_type ?? "agent"}`);

    const desc = input.description ?? "";
    this.descEl.setText(desc);
    this.descEl.toggleClass("is-empty", !desc);

    const status = this.statusFor(tool);
    if (this.statusKey !== status) {
      this.statusKey = status;
      this.statusEl.className = `claudian-agent-detail-status is-${status}`;
    }
    this.statusEl.setText(subagentStatusLabel(tool) || this.fallbackStatusLabel(tool));

    const steps = (tool.nestedEvents?.length ?? 0) + (tool.nestedTruncatedCount ?? 0);
    const parts: string[] = [];
    if (steps > 0) parts.push(`${steps} step${steps === 1 ? "" : "s"}`);
    if (tool.nestedDurationMs !== undefined) parts.push(formatAgentDuration(tool.nestedDurationMs));
    this.metaEl.setText(parts.join(" · "));
  }

  /* Status for the pill's modifier class. On a host with no subagent tracker
     nestedStatus is never set, so derive it from the tool's own status —
     the drill-in is never disabled, it just shows less. */
  private statusFor(tool: ToolCall): "spawning" | "running" | "completed" | "failed" {
    if (tool.nestedStatus) return tool.nestedStatus;
    if (tool.isError || tool.status === "errored" || tool.status === "denied") return "failed";
    if (tool.status === "completed") return "completed";
    return "running";
  }

  /* subagentStatusLabel returns "" when nestedStatus is absent (degraded
     host); give the pill something to say in that case. */
  private fallbackStatusLabel(tool: ToolCall): string {
    switch (this.statusFor(tool)) {
      case "failed": return "Failed";
      case "completed": return "Completed";
      case "spawning": return "Spawning subagent…";
      default: return "Running";
    }
  }

  private renderPrompt(tool: ToolCall): void {
    const prompt = this.toolInput(tool).prompt;
    if (typeof prompt !== "string" || !prompt) return;

    const block = this.transcriptEl.createDiv({ cls: "claudian-agent-detail-prompt" });
    const header = block.createDiv({ cls: "claudian-agent-detail-prompt-header" });
    const chevron = header.createSpan({ cls: "claudian-agent-detail-prompt-chevron" });
    platform.setIcon(chevron, "chevron-down");
    header.createSpan({ text: "Prompt" });
    this.promptBodyEl = block.createDiv({ cls: "claudian-agent-detail-prompt-body", text: prompt });
    header.addEventListener("click", () => {
      block.toggleClass("is-expanded", !block.hasClass("is-expanded"));
    });
  }

  private syncPrompt(tool: ToolCall): void {
    const prompt = this.toolInput(tool).prompt;
    if (typeof prompt !== "string") return;
    if (!this.promptBodyEl) {
      /* Prompt arrived after the first render (streaming spawn) — the block
         has to be created, and it belongs at the top of the transcript. */
      if (prompt) this.rebuild();
      return;
    }
    if (this.promptBodyEl.textContent !== prompt) this.promptBodyEl.setText(prompt);
  }

  private syncResult(tool: ToolCall): void {
    /* A background agent's tool completed at launch, and `result` holds only
       the launch acknowledgement until its task-notification replaces it —
       so its report is done only once nestedStatus says so. */
    const done = tool.backgroundAgent
      ? tool.nestedStatus === "completed" || tool.nestedStatus === "failed"
      : tool.status === "completed" || tool.status === "errored";
    const result = done && tool.result ? tool.result : null;
    if (!result) {
      if (this.resultEl) {
        this.resultEl.remove();
        this.resultEl = null;
        this.resultKey = null;
      }
      return;
    }
    const key = `${tool.status}|${tool.isError ? 1 : 0}|${result.length}`;
    if (this.resultEl && this.resultKey === key) {
      /* Late tracker events can append after the result block was built; keep
         the result last so the transcript still reads in order. */
      if (this.transcriptEl.lastElementChild !== this.resultEl) {
        this.transcriptEl.appendChild(this.resultEl);
      }
      return;
    }
    this.resultKey = key;
    if (this.resultEl) this.resultEl.remove();
    this.resultEl = this.transcriptEl.createDiv({
      cls: tool.isError ? "claudian-agent-detail-result is-error" : "claudian-agent-detail-result",
      text: truncateToolResult(result),
    });
  }

  private pinIfSticky(): void {
    if (!this.stickToBottom) return;
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }
}
