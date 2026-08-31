import { platform, type AppHandle, type RenderLifecycle } from "../platform";
import type { Attachment, ChatMessage, ToolCall } from "./state";
import { truncateToolResult } from "./state";
import { editOpsFromInput, renderDiff, renderWritePreview } from "./DiffRenderer";
import { isExtractableOffice, officeIconName } from "../util/officeExtract";
import { AgentGroupRenderer } from "./AgentGroupRenderer";
import { formatAgentDuration, iconForToolName } from "./nestedEventRender";

export type MessageActionCallbacks = {
  onFork: (messageId: string) => void;
};

/* Task ≤ CLI 2.1.141, Agent 2.1.143+ — both are subagent spawns. */
function isSpawnTool(tool: ToolCall): boolean {
  return tool.name === "Task" || tool.name === "Agent";
}

/* True on a touch-primary host (the iOS app). Mirrors the same check in
   TabBar.ts / InputBox.ts (each file keeps its own copy rather than sharing
   an import — it's five lines and none of these files otherwise depend on
   each other). Used only to gate the floating scroll-to-bottom button below:
   on a desktop pointer, scroll wheel/trackpad already reach the bottom in
   one gesture and a mouse can grab the scrollbar, so the button would be a
   new, un-asked-for permanent fixture over the transcript. On a phone,
   scrolling away from a long streaming reply to re-read earlier text is
   common, and swiping back down through everything that streamed in the
   meantime is not a reasonable way to return to it. */
function isTouchHost(): boolean {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  } catch {
    return false;
  }
}

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
  /* At or above this many attached notes, the pill row collapses behind a
     single "N notes" summary pill the user can click to expand. */
  private static readonly NOTE_COLLAPSE_THRESHOLD = 4;
  private app: AppHandle;
  private component: RenderLifecycle;
  private container: HTMLElement;
  private bottomSentinel: HTMLElement;
  private liveEls = new Map<string, { root: HTMLElement; content: HTMLElement }>();
  private toolEls = new Map<string, HTMLElement>();
  /* Per-message render chain. `renderContent` awaits MarkdownRenderer.render,
     opening a race window where two concurrent upserts can both clear pre-await
     DOM and both append. Serializing per-id removes the window structurally
     rather than patching symptoms downstream (footer dedup, etc.). */
  private renderChains = new Map<string, Promise<void>>();
  /* Generation token bumped on every reset(). Clearing renderChains alone
     cannot cancel an already-scheduled .then continuation, so a doUpsert queued
     behind an in-flight one still runs after reset() and would re-create a
     cleared bubble. Each upsert captures the generation it was queued under;
     doUpsert bails if it no longer matches, so post-reset stragglers are inert. */
  private generation = 0;
  /* Sticky per-message override for the thinking-block toggle. Set when the
     user clicks the header. Survives the empty()+rebuild cycle that happens
     on every streaming delta, so a user-collapsed block doesn't auto-reopen
     on the next token. Absent = use the streaming default. */
  private thinkingOpenOverride = new Map<string, boolean>();
  /* Owns the grouped agent card that replaces per-spawn tool rows. Keyed by
     message id internally; spawn tools never enter `toolEls`. */
  private agentGroups = new AgentGroupRenderer();
  private stickToBottom = true;
  private resizeObserver: ResizeObserver | null = null;
  /* rAF handle for the resize-triggered pin below. Coalesces the resize
     notification with doUpsert's own synchronous pinIfSticky() (see the
     comment on the ResizeObserver construction) so the pair collapses into
     one forced layout per frame instead of firing twice per upsert. */
  private resizeRafHandle: number | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private actionCallbacks: MessageActionCallbacks | null = null;
  /* Optional element kept positioned immediately before bottomSentinel on
     every layout pass — used to trail the status pill at the end of the
     visible message stream. Reference survives reset() so we can re-attach. */
  private tailEl: HTMLElement | null = null;
  /* Touch-only floating "jump to latest" button — see isTouchHost(). Null on
     every other host, including when the container has no scrollable parent
     yet (defensive; TabController always appends messagesEl to the wrapper
     before constructing this class, but nothing here should hard-depend on
     that ordering). */
  private scrollBottomBtn: HTMLElement | null = null;
  /* Streaming re-render throttle. Every delta from the daemon (text_delta,
     thinking_delta, a tool's content_block_start/stop, a completed
     input_json_delta boundary) calls upsertMessage() again for the SAME
     growing message, and each call is a full doUpsert pass: renderContent
     re-parses and re-sanitizes the WHOLE accumulated text (see
     renderContent/renderMarkdownInto), not just what's new. Left
     unthrottled, a 400-delta reply reparses and re-sanitizes its own
     (growing) markup 400 times on a phone's main thread while it's also
     trying to lay out and scroll. While `msg.streaming` is true, calls are
     coalesced per message id: the first in a burst renders immediately (the
     user still sees the first token land without delay), and any that land
     within STREAM_THROTTLE_MS of it are folded into a single trailing
     render rather than each getting their own pass — `msg` is the SAME
     mutable object every caller mutates in place, so whichever call the
     trailing timer fires under already reflects every delta that arrived
     in between. A message's final call (`msg.streaming` false or absent —
     the authoritative post-stream `assistant` event, or any non-streaming
     upsert) always renders immediately at full fidelity, bypassing the
     throttle entirely, so the finished output can never be what a stale
     trailing timer produced. */
  private readonly streamRenderTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastStreamRenderAt = new Map<string, number>();
  private static readonly STREAM_THROTTLE_MS = 80;

  constructor(app: AppHandle, component: RenderLifecycle, container: HTMLElement) {
    this.app = app;
    this.component = component;
    this.container = container;
    this.bottomSentinel = container.createDiv({ cls: "claudian-bottom-sentinel" });

    if (typeof ResizeObserver !== "undefined") {
      /* doUpsert ends every render with a synchronous pinIfSticky() (via
         scrollToBottom), and the DOM growth from that same render then fires
         this observer again for the same frame — mutating the observed
         subtree (appendChild/insertBefore in pinIfSticky's own reordering)
         from inside the callback also makes WebKit defer/replay the
         notification. Routing the callback through rAF coalesces all of
         that into a single pinIfSticky() per frame rather than one per
         streaming tick; forceStickToBottom() below still pins synchronously
         on Send, which is unaffected by this. */
      this.resizeObserver = new ResizeObserver(() => this.scheduleResizePin());
      this.resizeObserver.observe(this.container);
    }
    /* Threshold 0.01 means "any pixel of the sentinel is visible" — that
       counts as being at the bottom. Margin of 80px lets the user be
       slightly off-bottom and still trigger stickiness. */
    this.observeSentinel();

    if (isTouchHost()) {
      /* Mounted on the scrolling wrapper (container's parent), not on
         `container` itself — container is the flex content that grows with
         every message, and an absolutely-positioned child of a growing flex
         item is positioned relative to ITS box, not the visible viewport, so
         the button would drift down the page instead of staying pinned in
         the corner. The wrapper's box is the stable, viewport-sized one. */
      const anchor = this.container.parentElement ?? this.container;
      this.scrollBottomBtn = anchor.createDiv({
        cls: "claudian-scroll-bottom-btn",
        attr: { "aria-label": "Scroll to latest message", title: "Scroll to latest", role: "button", tabindex: "0" },
      });
      platform.setIcon(this.scrollBottomBtn, "chevron-down");
      this.scrollBottomBtn.style.display = "none";
      const jump = () => {
        /* Hide immediately rather than waiting on the IntersectionObserver
           round-trip — scrollIntoView's own scroll re-triggers the observer
           a frame later and confirms the state, but a same-frame hide is
           what makes the tap feel like it did something. */
        if (this.scrollBottomBtn) this.scrollBottomBtn.style.display = "none";
        this.forceStickToBottom();
      };
      this.scrollBottomBtn.addEventListener("click", jump);
      this.scrollBottomBtn.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          jump();
        }
      });
    }
  }

  /* One observer definition for both the constructor and reset(). */
  private observeSentinel() {
    if (typeof IntersectionObserver === "undefined") return;
    this.intersectionObserver = new IntersectionObserver(
      entries => {
        /* A hidden document (the iOS app in the background, an Obsidian tab
           the user switched away from) reports every element as NOT
           intersecting. Reading that as "the user scrolled away" turns
           stickiness off for good, so the reply that streamed in while the
           app was backgrounded ends up below the fold when they come back. */
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
        for (const entry of entries) {
          this.stickToBottom = entry.isIntersecting;
          if (this.scrollBottomBtn) {
            this.scrollBottomBtn.style.display = entry.isIntersecting ? "none" : "";
          }
        }
      },
      { root: null, rootMargin: "0px 0px 80px 0px", threshold: 0.01 }
    );
    this.intersectionObserver.observe(this.bottomSentinel);
  }

  destroy() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.resizeRafHandle !== null) {
      cancelAnimationFrame(this.resizeRafHandle);
      this.resizeRafHandle = null;
    }
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;
    /* Lives outside `container`, so container.empty()/detach() elsewhere in
       the teardown path never reaches it. */
    this.scrollBottomBtn?.detach();
    this.scrollBottomBtn = null;
  }

  setActionCallbacks(cb: MessageActionCallbacks) {
    this.actionCallbacks = cb;
  }

  /* Clicking an agent row in a group card routes here — TabController opens
     the full-pane drill-in view for that spawn tool. */
  public setAgentClickCallback(cb: (toolId: string) => void): void {
    this.agentGroups.setClickCallback(cb);
  }

  reset() {
    this.container.empty();
    this.bottomSentinel = this.container.createDiv({ cls: "claudian-bottom-sentinel" });
    /* A resize notification queued just before reset() would otherwise fire
       its rAF afterward and pin against whatever container state exists at
       that point instead of the freshly-reset one above. Cancel it outright,
       same rationale as the renderChains/streamRenderTimers cleanup below. */
    if (this.resizeRafHandle !== null) {
      cancelAnimationFrame(this.resizeRafHandle);
      this.resizeRafHandle = null;
    }
    this.intersectionObserver?.disconnect();
    this.observeSentinel();
    /* Lives on the wrapper, not `container`, so the empty() above left it
       standing — but a fresh/cleared conversation has nothing above the fold
       to jump back to. */
    if (this.scrollBottomBtn) this.scrollBottomBtn.style.display = "none";
    this.liveEls.clear();
    this.toolEls.clear();
    this.thinkingOpenOverride.clear();
    this.agentGroups.reset();
    /* Clear render chains too: a doUpsert queued behind an in-flight
       MarkdownRenderer.render await would otherwise re-run after reset, miss
       the now-empty liveEls, and re-append a fresh bubble — resurrecting a
       message /clear was meant to remove. Dropping the chain map detaches the
       stale promise so a late render can't re-enter the cleared container. */
    this.renderChains.clear();
    /* Same reasoning as renderChains just above, for the streaming throttle's
       own trailing timers: a scheduled catch-up render captures `generation`
       only when it FIRES (dispatchUpsert reads `this.generation` from inside
       the timer callback), so bumping the counter below is not enough on its
       own to make doUpsert's bail check catch it — the fired call would see
       the already-bumped generation and think it's current, resurrecting a
       bubble into the just-emptied container. Cancelling outright closes
       that gap the counter can't. */
    for (const timer of this.streamRenderTimers.values()) clearTimeout(timer);
    this.streamRenderTimers.clear();
    this.lastStreamRenderAt.clear();
    /* Bump the generation so any doUpsert already scheduled behind an in-flight
       MarkdownRenderer.render await bails on resume instead of re-appending a
       bubble to the freshly-emptied container. Clearing the map above cannot
       cancel that pending microtask; this token can. */
    this.generation++;
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

  /* Coalesces a burst of ResizeObserver notifications (which fire once per
     mutation of the observed subtree, including ones pinIfSticky itself
     causes) into a single pinIfSticky() call per animation frame. */
  private scheduleResizePin() {
    if (this.resizeRafHandle !== null) return;
    this.resizeRafHandle = requestAnimationFrame(() => {
      this.resizeRafHandle = null;
      this.pinIfSticky();
    });
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
    if (msg.streaming) {
      const now = Date.now();
      const last = this.lastStreamRenderAt.get(msg.id);
      if (last !== undefined && now - last < MessageListRenderer.STREAM_THROTTLE_MS) {
        /* Inside the throttle window: fold this call into whichever trailing
           render is already scheduled (or schedule the one that will catch
           up) instead of dispatching a fresh doUpsert of our own. Resolves
           right away rather than waiting on that timer — this call did no
           DOM work, so there is nothing for the caller to legitimately wait
           on, and stalling handleStreamEvent's own await here would only
           slow down how fast it can drain the next buffered delta. */
        if (!this.streamRenderTimers.has(msg.id)) {
          const timer = setTimeout(() => {
            this.streamRenderTimers.delete(msg.id);
            this.lastStreamRenderAt.set(msg.id, Date.now());
            void this.dispatchUpsert(msg);
          }, MessageListRenderer.STREAM_THROTTLE_MS - (now - last));
          this.streamRenderTimers.set(msg.id, timer);
        }
        return;
      }
      this.lastStreamRenderAt.set(msg.id, now);
    } else {
      /* Not streaming: either this message's authoritative final render
         (content_block_stop's owning `assistant` event already flipped
         `streaming` to false before calling here) or a message that was
         never streamed at all. Either way it must land at full fidelity
         right now, so drop a same-id trailing catch-up still pending —
         letting it fire afterward would redundantly re-render a message
         that's already current — and the rate bookkeeping with it. */
      const timer = this.streamRenderTimers.get(msg.id);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.streamRenderTimers.delete(msg.id);
      }
      this.lastStreamRenderAt.delete(msg.id);
    }
    await this.dispatchUpsert(msg);
  }

  private dispatchUpsert(msg: ChatMessage): Promise<void> {
    /* Serialize per-message: queue this upsert behind any in-flight chain for
       the same id so MarkdownRenderer.render's await can never interleave with
       another upsert clearing the same content element. GC the map entry once
       the chain settles so long-lived sessions don't leak. */
    const prev = this.renderChains.get(msg.id) ?? Promise.resolve();
    /* Snapshot the generation now, before the chain resolves: if reset() runs
       while this upsert is queued, doUpsert sees the mismatch and bails. */
    const gen = this.generation;
    const next = prev.then(() => this.doUpsert(msg, gen));
    this.renderChains.set(msg.id, next);
    next.finally(() => {
      if (this.renderChains.get(msg.id) === next) this.renderChains.delete(msg.id);
    });
    return next;
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
      }
    }
    this.agentGroups.removeForMessage(id);
    /* entry.root is the inner .claudian-message; createBubble nests it in a
       .claudian-message-wrapper. Remove the wrapper, or every merge leaves
       an empty wrapper div behind that the flex column's gap renders as a
       phantom blank row. */
    (entry.root.closest(".claudian-message-wrapper") ?? entry.root).remove();
    this.liveEls.delete(id);
    this.thinkingOpenOverride.delete(id);
    this.renderChains.delete(id);
    /* Same gap as reset()'s: a pending trailing render for this id would
       otherwise fire later, find no liveEls entry, and re-create a bubble
       for a message this fold just removed. */
    const timer = this.streamRenderTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.streamRenderTimers.delete(id);
    this.lastStreamRenderAt.delete(id);
  }

  private async doUpsert(msg: ChatMessage, gen: number) {
    /* Bail before createBubble if a reset() ran while this upsert was queued.
       Without this the missing liveEls entry would route us through createBubble
       and re-append a bubble to the cleared container — a zombie message. */
    if (gen !== this.generation) return;
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
      const spawnTools = msg.toolCalls.filter(isSpawnTool);
      let groupPlaced = false;
      for (const tool of msg.toolCalls) {
        if (isSpawnTool(tool)) {
          /* All spawns of a message share one group card, planted at the first
             spawn's position; later spawns fold into the existing card. */
          if (!groupPlaced) {
            groupPlaced = true;
            /* Anchor: the first already-rendered non-spawn row that follows
               this spawn. Appending is right on the normal path (nothing
               after it exists yet), but a card re-created after its DOM was
               detached would otherwise jump to the end of the bubble. */
            let anchor: HTMLElement | null = null;
            for (let i = msg.toolCalls.indexOf(tool) + 1; i < msg.toolCalls.length; i++) {
              const later = this.toolEls.get(msg.toolCalls[i].id);
              if (later && later.parentElement === entry.root) { anchor = later; break; }
            }
            this.agentGroups.upsertGroup(entry.root, msg, spawnTools, anchor);
          }
          continue;
        }
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
      platform.setIcon(icon, this.iconForTool(tool.name));
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

    /* stateKey/stateChanged are computed here (rather than down by the
       expand/collapse rules that also need them) because the status icon
       rebuild right below is the expensive part: renderIcon builds an SVG
       node-by-node via createElementNS, and upsertTool re-runs for every
       tool on every streaming delta of the message. Skipping the rebuild
       when the tool's error/status hasn't actually transitioned avoids that
       allocation at the stream's tick rate. The expand/collapse rules further
       down reuse this same stateChanged rather than recomputing it — recomputing
       after data-state is already written below would always read "unchanged"
       and silently disable those transitions. */
    const stateKey = tool.isError ? "error" : tool.status;
    const stateChanged = toolEl.getAttribute("data-state") !== stateKey;
    toolEl.setAttribute("data-state", stateKey);

    const statusEl = toolEl.querySelector(".claudian-tool-status") as HTMLElement;
    if (stateChanged) {
      statusEl.empty();
      /* Drop any prior status-* class so the color resets between transitions. */
      statusEl.className = "claudian-tool-status";
      statusEl.addClass(`status-${tool.status}`);
      const statusIcon = this.iconForStatus(tool.status, tool.isError);
      if (statusIcon) platform.setIcon(statusEl, statusIcon);
      statusEl.setAttr("aria-label", this.labelForStatus(tool.status));
    }

    /* Auto-expand on first sight while running (so the user sees what's about
       to execute) and on error (so they don't have to click to find what
       failed). Collapse on successful completion. */
    /* Expansion rules must fire on state TRANSITIONS, not on steady state:
       upsertTool re-runs for the whole message every time any sibling tool or
       subagent updates, so an unconditional "collapse when completed" would
       snap a row shut every re-render while the user is trying to read it.
       stateChanged (computed above alongside the status-icon guard) already
       tracks exactly that transition. */
    /* A terminal transition (error or completion) is a fresh system-driven
       state change, so clear the user's running-tool toggle intent and let the
       error/complete rules below decide expansion. On later upserts of the
       same terminal state the user's toggle is theirs to keep. */
    if (stateChanged && (tool.isError || tool.status === "completed")) {
      toolEl.removeClass("is-user-toggled");
    }
    if (tool.isError) {
      if (stateChanged) toolEl.addClass("is-expanded");
    } else if (tool.status === "completed") {
      /* Collapse back to compact form when the tool finishes so the chat
         doesn't get swamped — but only on the transition itself. */
      if (stateChanged) toolEl.removeClass("is-expanded");
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
      resultEl.createSpan({ cls: "claudian-tool-result-text", text: truncateToolResult(tool.result) });
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
      platform.setIcon(iconEl, iconName);
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
    if (msg.role === "user" && msg.attachedNotePaths && msg.attachedNotePaths.length > 0) {
      this.renderAttachedNoteFlags(wrapper, msg.attachedNotePaths);
    }
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
    platform.setIcon(iconEl, "text-cursor");
    const fileName = ctx.filePath.split("/").pop() ?? ctx.filePath;
    const range = ctx.startLine === ctx.endLine
      ? `line ${ctx.startLine}`
      : `lines ${ctx.startLine}–${ctx.endLine}`;
    flag.createSpan({ cls: "claudian-selection-flag-text", text: `Selected from ${fileName} · ${range}` });
    flag.setAttr("title", `${ctx.filePath} · ${range}`);
  }

  /* Note pills rendered above the user's bubble, one per file/folder that was
     pinned in the file-pill bar when the message was sent. Echoes the
     composer's pill (file-text icon, brand tint) so the connection reads as
     "the note I attached rode along with this turn". The bubble itself stays
     clean — only the user's typed text shows inside it. Clicking a pill opens
     the note.

     Once the count reaches NOTE_COLLAPSE_THRESHOLD the row collapses behind a
     single "📎 N notes" summary pill so the header stays compact; clicking it
     toggles the full list. Below the threshold every note shows as its own
     pill. */
  private renderAttachedNoteFlags(parent: HTMLElement, paths: string[]) {
    const row = parent.createDiv({ cls: "claudian-attached-note-flags" });

    if (paths.length < MessageListRenderer.NOTE_COLLAPSE_THRESHOLD) {
      for (const path of paths) this.renderNotePill(row, path);
      return;
    }

    /* Collapsed: a single summary pill that toggles the expanded list below. */
    const summary = row.createDiv({ cls: "claudian-attached-note-summary" });
    const iconEl = summary.createSpan({ cls: "claudian-attached-note-flag-icon" });
    platform.setIcon(iconEl, "paperclip");
    summary.createSpan({ cls: "claudian-attached-note-flag-text", text: `${paths.length} notes` });
    const chevron = summary.createSpan({ cls: "claudian-attached-note-chevron" });
    platform.setIcon(chevron, "chevron-down");

    const expanded = row.createDiv({ cls: "claudian-attached-note-expanded" });
    for (const path of paths) this.renderNotePill(expanded, path);

    const setTitle = (open: boolean) =>
      summary.setAttr("title", `${paths.length} notes attached as context · click to ${open ? "collapse" : "expand"}`);
    setTitle(false);
    summary.addEventListener("click", e => {
      e.stopPropagation();
      const next = !row.hasClass("is-expanded");
      row.toggleClass("is-expanded", next);
      setTitle(next);
      if (next) this.scrollToBottom();
    });
  }

  /* One attached-note pill — file/folder icon + basename, clicking a file
     opens it in a new tab. Shared by the inline (below-threshold) and the
     expanded (collapsed-summary) layouts. */
  private renderNotePill(container: HTMLElement, path: string) {
    const flag = container.createDiv({ cls: "claudian-attached-note-flag" });
    const iconEl = flag.createSpan({ cls: "claudian-attached-note-flag-icon" });
    const isFolder = platform.vaultFeatures?.pathKind(path) === "folder";
    if (isFolder) {
      flag.addClass("is-folder");
      platform.setIcon(iconEl, "folder");
    } else if (isExtractableOffice(path)) {
      flag.addClass("is-office");
      platform.setIcon(iconEl, officeIconName(path));
    } else {
      const ext = path.split(".").pop() ?? "";
      platform.setIcon(iconEl, ext === "canvas" ? "layout-grid" : "file-text");
    }
    const fileName = path.split("/").pop() ?? path;
    flag.createSpan({ cls: "claudian-attached-note-flag-text", text: fileName });
    flag.setAttr("title", `Attached as context: ${path}`);
    flag.addEventListener("click", e => {
      e.stopPropagation();
      if (isFolder) return;
      platform.vaultFeatures?.openPath(path, "tab");
    });
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
    platform.setIcon(forkBtn, "git-branch");
    forkBtn.addEventListener("click", e => {
      e.stopPropagation();
      this.actionCallbacks?.onFork(msg.id);
    });

    const copyBtn = bar.createSpan({
      cls: "claudian-message-action",
      attr: { "aria-label": "Copy message", title: "Copy message text" },
    });
    platform.setIcon(copyBtn, "copy");
    copyBtn.addEventListener("click", e => {
      e.stopPropagation();
      const live = this.container.querySelector(`[data-message-id="${msg.id}"]`);
      const text = (live as HTMLElement | null)?.querySelector(".claudian-text-block")?.textContent ?? msg.content;
      void navigator.clipboard.writeText(text);
      platform.notify("Copied message");
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
        platform.setIcon(iconEl, "image");
        const label = att.filename ?? "Image (data missing)";
        chip.createSpan({ cls: "claudian-message-attachment-label", text: label, attr: { title: label } });
        return;
      }
      /* pdf / text — render as a compact file chip. Same visual treatment for
         both; only the icon differs so the user can scan-distinguish. */
      const chip = parent.createDiv({ cls: "claudian-message-attachment claudian-message-attachment-file" });
      const iconEl = chip.createSpan({ cls: "claudian-message-attachment-icon" });
      platform.setIcon(iconEl, kind === "pdf" ? "file-text" : "file");
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
        await platform.renderMarkdown(msg.content, block, "", this.component);
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
        platform.vaultFeatures?.openPath(linkpath, split ? "split" : "tab");
      });
      a.addEventListener("auxclick", e => {
        if (e.button !== 1) return;
        e.preventDefault();
        platform.vaultFeatures?.openPath(linkpath, "tab");
      });
      a.addEventListener("mouseover", event => {
        platform.vaultFeatures?.triggerHoverLink(event, a, linkpath, this.component);
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
    platform.setIcon(chevron, "chevron-down");
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

  /* Both delegate to nestedEventRender so the main tool rows, the agent group
     card, and the drill-in transcript can't drift apart. */
  private formatDuration(ms: number): string {
    return formatAgentDuration(ms);
  }

  private iconForTool(name: string): string {
    return iconForToolName(name);
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
    if ((tool.name === "Task" || tool.name === "Agent") && typeof input.subagent_type === "string") return truncate(input.subagent_type);
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
    /* Task/Agent tool ("Task" ≤ CLI 2.1.141, "Agent" 2.1.143+): the visible
       summary already shows description + subagent, so use the prompt as the
       expandable preview body. */
    if ((tool.name === "Task" || tool.name === "Agent") && typeof input.prompt === "string") return input.prompt;
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

  /* Explicit scroll trigger from upsertMessage. ResizeObserver handles
     streaming growth automatically; this catches in-place updates that
     don't change the container's size (e.g. tool status badge update). */
  private scrollToBottom() {
    this.pinIfSticky();
  }
}
