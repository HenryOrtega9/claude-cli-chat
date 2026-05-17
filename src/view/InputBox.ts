import { setIcon } from "obsidian";
import {
  MODEL_LABELS,
  EFFORT_LABELS,
  effortLevelsForModel,
  contextWindowForModel,
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODE_DESCRIPTIONS,
  nextPermissionMode,
  type ClaudeChatSettings,
  type ModelKey,
  type EffortLevel,
  type PermissionMode,
} from "../settings";
import type { UsageSnapshot } from "../claude/Events";
import { CLAUDE_ASTERISK_DATA_URI } from "./Welcome";
import type { Attachment } from "./state";
import type { ActiveSelection } from "./SelectionTracker";

export type SubmitPayload = {
  text: string;
  attachments: Attachment[];
  /* If set, the user had this editor selection pinned at submit time. The
     tab controller inlines it into the prompt before sending to Claude. */
  selection?: ActiveSelection;
};

/* Suggestion shown in the @-mention or /-command popup. */
export type Suggestion = {
  id: string;
  primary: string;     // main label
  secondary?: string;  // muted subtitle (path, hint, etc.)
  icon?: string;       // Obsidian icon name
  insert: string;      // text to insert at the trigger position
};

export type InputBoxCallbacks = {
  onSubmit: (payload: SubmitPayload) => void;
  onModelChange: (model: ModelKey) => void;
  onEffortChange: (effort: EffortLevel) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
  /* Return vault file matches for an @-mention query. Caller (TabController)
     reads from app.vault and ranks. Limit to ~20 results. */
  onMentionQuery: (query: string) => Suggestion[];
  /* Return slash-command matches. Static list curated by the plugin. */
  onSlashQuery: (query: string) => Suggestion[];
  /* Fired when the user presses Esc while Claude is streaming (busy=true).
     Caller is expected to interrupt the in-flight turn. */
  onCancel: () => void;
  /* Fired when the user dismisses the selection chip via its (×) button.
     CONTRACT (consumed by Agent C / TabController): wire this to
     SelectionTracker.clear() so the next selectionchange refresh doesn't
     re-push the same selection back into the chip. Optional — InputBox
     keeps working without it but the chip will reappear on the next cursor
     move in the source editor. */
  onSelectionDismissed?: () => void;
};

/* Map a raw Anthropic model id ("claude-opus-4-7", "claude-sonnet-4-6",
   "claude-haiku-4-5-20251001") to the short family label used in the pill
   "via" badge. Unknown ids return null so the badge stays hidden rather
   than printing a useless raw id. */
function friendlySubModelLabel(modelId: string): "Opus" | "Sonnet" | "Haiku" | null {
  const id = modelId.toLowerCase();
  if (id.includes("opus")) return "Opus";
  if (id.includes("sonnet")) return "Sonnet";
  if (id.includes("haiku")) return "Haiku";
  return null;
}

export class InputBox {
  private root: HTMLElement;
  private wrapper: HTMLElement;
  private contextRow: HTMLElement;
  private textarea: HTMLTextAreaElement;
  /* Two-row layout: topToolbar frames the input from above with the
     mode + model pills (the "what's running" pair); bottomToolbar carries
     effort + usage + send (the "knobs + action" row). Split makes mode
     read as the primary risk control rather than buried mid-row. */
  private topToolbar: HTMLElement;
  private bottomToolbar: HTMLElement;
  private modelPill: HTMLElement;
  private modelPillLabel: HTMLElement;
  private modelPillVia: HTMLElement;
  private effortPill: HTMLElement;
  private effortPillValue: HTMLElement;
  private modePill: HTMLElement;
  private modePillValue: HTMLElement;
  private usageChip: HTMLElement;
  private usageDonutCircle: SVGCircleElement;
  private usagePercentEl: HTMLElement;
  private usagePill: HTMLElement;
  private sendBtn: HTMLElement;
  private callbacks: InputBoxCallbacks;
  private currentModel: ModelKey;
  private currentEffort: EffortLevel;
  private currentMode: PermissionMode;
  private busy = false;
  private attachments: Attachment[] = [];
  /* The active editor selection captured by SelectionTracker. Lives across
     keystrokes so the user can type a question without losing context. */
  private currentSelection: ActiveSelection | null = null;
  private openPopup: { el: HTMLElement; outsideHandler: (e: MouseEvent) => void; keyHandler: (e: KeyboardEvent) => void } | null = null;
  /* Active @ / slash suggestion popup. Tracked separately from `openPopup`
     (which handles the model/effort/mode pill popups) because suggestions are
     keyboard-driven by the textarea, not by clicks on a pill. */
  private suggestion: {
    el: HTMLElement;
    trigger: "@" | "/";
    triggerStart: number;  // index in textarea.value where the trigger char sits
    items: Suggestion[];
    activeIndex: number;
  } | null = null;
  /* destroy() flips this so late-firing callbacks (FileReader.onload after a
     tab close, deferred setTimeout handlers, etc.) can no-op safely. */
  private destroyed = false;

  constructor(
    container: HTMLElement,
    settings: ClaudeChatSettings,
    callbacks: InputBoxCallbacks,
    initial?: { model?: ModelKey; effort?: EffortLevel; permissionMode?: PermissionMode }
  ) {
    this.callbacks = callbacks;
    this.currentModel = initial?.model ?? settings.defaultModel;
    this.currentEffort = initial?.effort ?? settings.defaultEffort;
    this.currentMode = initial?.permissionMode ?? settings.permissionMode;

    this.root = container.createDiv({ cls: "claudian-input-container" });
    this.wrapper = this.root.createDiv({ cls: "claudian-input-wrapper" });

    /* Top toolbar — mode pill (left) + model pill (right). Created BEFORE
       the textarea so DOM order matches visual order. mountTopBar still
       prepends the active-file indicator above this row. */
    this.topToolbar = this.wrapper.createDiv({ cls: "claudian-input-toolbar claudian-input-toolbar-top" });

    this.contextRow = this.wrapper.createDiv({ cls: "claudian-context-row" });

    this.textarea = this.wrapper.createEl("textarea", {
      cls: "claudian-input",
      attr: { placeholder: "How can I help you today?", rows: "3", dir: "auto" },
    });
    this.textarea.addEventListener("keydown", e => this.handleKeydown(e));
    this.textarea.addEventListener("input", () => {
      this.autoResize();
      this.updateSuggestion();
    });
    this.textarea.addEventListener("click", () => this.updateSuggestion());
    this.textarea.addEventListener("blur", () => {
      /* Defer so a click on a suggestion row can still register. */
      window.setTimeout(() => this.hideSuggestion(), 150);
    });
    this.textarea.addEventListener("paste", e => this.handlePaste(e));

    /* Drop handler on the wrapper covers both the textarea and the chip row. */
    this.wrapper.addEventListener("dragover", e => {
      if (e.dataTransfer?.types?.length) e.preventDefault();
    });
    this.wrapper.addEventListener("drop", e => this.handleDrop(e));

    /* Floating "42k / 1000k" chip — positioned absolutely just above the
       toolbar, right side. Hidden until the first usage snapshot arrives. */
    this.usageChip = this.wrapper.createDiv({ cls: "claudian-context-window-chip" });
    this.usageChip.style.display = "none";

    this.bottomToolbar = this.wrapper.createDiv({ cls: "claudian-input-toolbar claudian-input-toolbar-bottom" });

    /* ---- TOP ROW: mode (left) + model (right) ---------------------- */

    /* Permission-mode pill is loud on purpose — it's the runtime control
       with the highest blast radius (controls whether tools fire). Sits
       leftmost so the eye lands on it first. Cycle with Shift+Tab from
       the textarea or click to open a popup with all options. */
    this.modePill = this.topToolbar.createSpan({
      cls: "claudian-toolbar-pill claudian-mode-pill",
      attr: { "aria-label": "Permission mode (Shift+Tab to cycle)", title: "Permission mode — Shift+Tab to cycle" },
    });
    this.modePillValue = this.modePill.createSpan({ cls: "claudian-toolbar-pill-value" });
    this.modePill.createSpan({ cls: "claudian-toolbar-pill-label", text: "Mode" });
    this.modePill.addEventListener("click", e => {
      e.stopPropagation();
      this.toggleModePopup();
    });

    this.topToolbar.createDiv({ cls: "claudian-input-toolbar-spacer" });

    /* Model pill — Claude logo popup on click. Sits at the right edge of
       the top row. The optional "via" badge to the right surfaces the
       actual model resolved for the most recent assistant turn — only
       diverges from the pill label when Opus Plan is selected (Opus in
       plan mode, Sonnet elsewhere). */
    this.modelPill = this.topToolbar.createSpan({
      cls: "claudian-toolbar-pill claudian-model-pill",
      attr: { "aria-label": "Choose model", title: "Choose model" },
    });
    this.modelPillLabel = this.modelPill.createSpan({ cls: "claudian-toolbar-pill-value" });
    this.modelPillVia = this.modelPill.createSpan({ cls: "claudian-model-pill-via" });
    this.modelPillVia.style.display = "none";
    this.modelPill.addEventListener("click", e => {
      e.stopPropagation();
      this.toggleModelPopup();
    });

    /* ---- BOTTOM ROW: effort + usage + spacer + send ---------------- */

    /* Effort pill — "Effort: <Value>" with the label muted and value orange. */
    this.effortPill = this.bottomToolbar.createSpan({
      cls: "claudian-toolbar-pill claudian-effort-pill",
      attr: { "aria-label": "Reasoning effort", title: "Reasoning effort" },
    });
    this.effortPill.createSpan({ cls: "claudian-toolbar-pill-label", text: "Effort" });
    this.effortPillValue = this.effortPill.createSpan({ cls: "claudian-toolbar-pill-value" });
    this.effortPill.addEventListener("click", e => {
      e.stopPropagation();
      this.toggleEffortPopup();
    });

    this.refreshModelPill();
    this.refreshEffortPill();
    this.refreshModePill();

    /* Usage donut + percentage — inline in the bottom toolbar. Hidden
       until the first usage snapshot lands. */
    this.usagePill = this.bottomToolbar.createSpan({
      cls: "claudian-toolbar-pill claudian-usage-pill",
      attr: { "aria-label": "Context window usage", title: "Context window usage" },
    });
    this.usagePill.style.display = "none";
    const svgNS = "http://www.w3.org/2000/svg";
    const donut = document.createElementNS(svgNS, "svg");
    donut.setAttribute("class", "claudian-usage-donut");
    donut.setAttribute("viewBox", "0 0 16 16");
    donut.setAttribute("width", "14");
    donut.setAttribute("height", "14");
    const track = document.createElementNS(svgNS, "circle");
    track.setAttribute("cx", "8");
    track.setAttribute("cy", "8");
    track.setAttribute("r", "6");
    track.setAttribute("fill", "none");
    track.setAttribute("stroke", "currentColor");
    track.setAttribute("stroke-opacity", "0.2");
    track.setAttribute("stroke-width", "2.5");
    donut.appendChild(track);
    this.usageDonutCircle = document.createElementNS(svgNS, "circle");
    this.usageDonutCircle.setAttribute("cx", "8");
    this.usageDonutCircle.setAttribute("cy", "8");
    this.usageDonutCircle.setAttribute("r", "6");
    this.usageDonutCircle.setAttribute("fill", "none");
    this.usageDonutCircle.setAttribute("stroke", "currentColor");
    this.usageDonutCircle.setAttribute("stroke-width", "2.5");
    this.usageDonutCircle.setAttribute("stroke-linecap", "round");
    this.usageDonutCircle.setAttribute("pathLength", "100");
    this.usageDonutCircle.setAttribute("stroke-dasharray", "0 100");
    this.usageDonutCircle.setAttribute("transform", "rotate(-90 8 8)");
    donut.appendChild(this.usageDonutCircle);
    this.usagePill.appendChild(donut);
    this.usagePercentEl = this.usagePill.createSpan({ cls: "claudian-toolbar-pill-value claudian-usage-percent", text: "0%" });

    /* The "Nk / Mk" chip is a hover-revealed tooltip on the donut pill, not
       a permanent label. Show it only while the cursor is over the pill, and
       only if we have actual usage data to display. */
    this.usagePill.addEventListener("mouseenter", () => {
      if (this.usageChip.textContent && this.usageChip.textContent.length > 0) {
        this.usageChip.style.display = "";
      }
    });
    this.usagePill.addEventListener("mouseleave", () => {
      this.usageChip.style.display = "none";
    });

    this.bottomToolbar.createDiv({ cls: "claudian-input-toolbar-spacer" });

    this.sendBtn = this.bottomToolbar.createSpan({
      cls: "claudian-send-button",
      attr: { "aria-label": "Send", title: "Send (Enter)" },
    });
    setIcon(this.sendBtn, "send");
    this.sendBtn.addEventListener("click", () => this.submit());
  }

  setBusy(busy: boolean) {
    this.busy = busy;
    this.sendBtn.toggleClass("is-disabled", busy);
  }

  /* Tear down the InputBox cleanly. Removes any document-level listeners that
     popups installed, closes any visible popup/suggestion (which also pulls
     their listeners), and flips `destroyed` so late callbacks (deferred
     setTimeout-installed listeners, FileReader.onload after a paste while the
     tab is being closed) short-circuit instead of touching detached DOM.
     CONTRACT (consumed by Agent C / TabController): call on tab close BEFORE
     the parent DOM is removed so the global document.removeEventListener
     handles in closePopup/hideSuggestion are still wired to live references. */
  public destroy(): void {
    this.destroyed = true;
    if (this.openPopup) this.closePopup();
    if (this.suggestion) this.hideSuggestion();
  }

  /* Mounts an external element (e.g. the active-file pill bar) just
     above the textarea, inside the framed input box but below the top
     toolbar. Sits between contextRow and the textarea for two reasons:
     (1) it visually groups with the input itself ("these are the files
     the upcoming message will reference") rather than reading as part of
     the toolbar; (2) keeps the mode/model pills as the very first row,
     which is what the layout decision optimized for. */
  mountTopBar(el: HTMLElement) {
    this.wrapper.insertBefore(el, this.contextRow);
  }

  setVisible(visible: boolean) {
    this.root.style.display = visible ? "" : "none";
  }

  setModel(model: ModelKey) {
    this.currentModel = model;
    /* Switching to a non-opus-plan model clears the "via" badge — the badge
       only carries meaning when the user-selected model is the opusplan alias. */
    if (model !== "opus-plan") this.clearActiveSubModel();
    this.refreshModelPill();
  }

  /* Called with the `model` field from each assistant event. When the user
     picked Opus Plan, the CLI resolves to Opus (in plan mode) or Sonnet
     (otherwise) and reports the chosen model on every assistant message —
     surfacing it here makes the mid-turn swap visible.

     For any other selected model the actual model always equals the selected
     one, so the badge stays hidden to avoid visual noise. */
  setActiveSubModel(actualModelId: string | undefined) {
    if (!actualModelId || this.currentModel !== "opus-plan") {
      this.clearActiveSubModel();
      return;
    }
    const label = friendlySubModelLabel(actualModelId);
    if (!label) {
      this.clearActiveSubModel();
      return;
    }
    this.modelPillVia.setText(`→ ${label}`);
    this.modelPillVia.style.display = "";
    /* Tone the badge so the swap is obvious at a glance: Opus = brand orange,
       Sonnet = muted blue. */
    this.modelPillVia.removeClass("is-opus");
    this.modelPillVia.removeClass("is-sonnet");
    if (label === "Opus") this.modelPillVia.addClass("is-opus");
    else if (label === "Sonnet") this.modelPillVia.addClass("is-sonnet");
  }

  private clearActiveSubModel() {
    this.modelPillVia.setText("");
    this.modelPillVia.style.display = "none";
  }

  setEffort(effort: EffortLevel) {
    this.currentEffort = effort;
    this.refreshEffortPill();
  }

  setPermissionMode(mode: PermissionMode) {
    this.currentMode = mode;
    this.refreshModePill();
  }

  /* Update the context-window indicators from a usage snapshot. Reads either
     snake_case (raw stream-json) or camelCase (Agent SDK normalized) token
     fields, sums them for the "context tokens" numerator, and uses the
     model's default window as the denominator unless the snapshot includes
     an explicit contextWindow. */
  setUsage(usage: UsageSnapshot | undefined) {
    if (!usage) {
      this.usageChip.style.display = "none";
      this.usagePill.style.display = "none";
      return;
    }
    const inputTokens      = usage.input_tokens                 ?? usage.inputTokens               ?? 0;
    const outputTokens     = usage.output_tokens                ?? usage.outputTokens              ?? 0;
    const cacheReadTokens  = usage.cache_read_input_tokens      ?? usage.cacheReadInputTokens      ?? 0;
    const cacheCreateTokens = usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens  ?? 0;

    const window = usage.contextWindow ?? contextWindowForModel(this.currentModel);
    /* Tokens currently loaded in context = input + cached + output of the
       last turn (the output becomes context for the next turn). */
    const contextTokens = usage.contextTokens ?? (inputTokens + cacheReadTokens + cacheCreateTokens + outputTokens);

    if (contextTokens <= 0 || window <= 0) {
      this.usageChip.style.display = "none";
      this.usageChip.setText("");
      this.usagePill.style.display = "none";
      return;
    }
    const percent = Math.min(100, Math.max(0, (contextTokens / window) * 100));
    /* Refresh the chip text but don't toggle its visibility — the donut
       pill's mouseenter handler shows it on hover only. */
    this.usageChip.setText(`${this.formatTokens(contextTokens)} / ${this.formatTokens(window)}`);
    this.usagePill.style.display = "";
    this.usageDonutCircle.setAttribute("stroke-dasharray", `${percent.toFixed(2)} 100`);
    this.usagePercentEl.setText(percent < 1 ? "<1%" : `${Math.round(percent)}%`);
    /* Heat-tone the donut + percentage as the window fills. Stays brand
       orange until 75%, then amber, then red past 90%. */
    this.usagePill.removeClass("warn");
    this.usagePill.removeClass("danger");
    if (percent >= 90) this.usagePill.addClass("danger");
    else if (percent >= 75) this.usagePill.addClass("warn");
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
    return `${n}`;
  }

  focus() {
    this.textarea.focus();
  }

  insertAtCursor(text: string) {
    const start = this.textarea.selectionStart ?? this.textarea.value.length;
    const end = this.textarea.selectionEnd ?? this.textarea.value.length;
    const before = this.textarea.value.slice(0, start);
    const after = this.textarea.value.slice(end);
    this.textarea.value = before + text + after;
    const cursor = start + text.length;
    this.textarea.selectionStart = this.textarea.selectionEnd = cursor;
    this.textarea.focus();
    this.autoResize();
  }

  private refreshModelPill() {
    this.modelPillLabel.setText(MODEL_LABELS[this.currentModel]);
  }

  private refreshEffortPill() {
    this.effortPillValue.setText(EFFORT_LABELS[this.currentEffort]);
  }

  private refreshModePill() {
    this.modePillValue.setText(PERMISSION_MODE_LABELS[this.currentMode]);
    /* Drop any prior mode-tone classes so the warning state turns off when
       cycling back to safer modes. */
    this.modePill.removeClass("mode-plan");
    this.modePill.removeClass("mode-bypass");
    this.modePill.removeClass("mode-auto");
    if (this.currentMode === "plan") this.modePill.addClass("mode-plan");
    else if (this.currentMode === "bypassPermissions") this.modePill.addClass("mode-bypass");
    else if (this.currentMode === "auto") this.modePill.addClass("mode-auto");
  }

  private toggleModePopup() {
    if (this.openPopup) {
      const wasMode = this.openPopup.el.classList.contains("claudian-popup-mode");
      this.closePopup();
      if (wasMode) return;
    }
    const popup = this.createPopup("claudian-popup-mode");
    popup.createDiv({ cls: "claudian-popup-header", text: "PERMISSION MODE" });
    for (const key of PERMISSION_MODE_ORDER) {
      const row = popup.createDiv({
        cls: "claudian-popup-row claudian-popup-row-stacked" + (key === this.currentMode ? " is-selected" : ""),
      });
      row.createDiv({ cls: "claudian-popup-row-label", text: PERMISSION_MODE_LABELS[key] });
      row.createDiv({ cls: "claudian-popup-row-sublabel", text: PERMISSION_MODE_DESCRIPTIONS[key] });
      row.addEventListener("click", e => {
        e.stopPropagation();
        this.setModeAndNotify(key);
        this.closePopup();
      });
    }
    this.anchorPopup(popup, this.modePill);
  }

  /* Advance one step through PERMISSION_MODE_ORDER. Bound to Shift+Tab. */
  private cyclePermissionMode() {
    this.setModeAndNotify(nextPermissionMode(this.currentMode));
  }

  private setModeAndNotify(mode: PermissionMode) {
    if (mode === this.currentMode) return;
    this.currentMode = mode;
    this.refreshModePill();
    this.callbacks.onPermissionModeChange(mode);
  }

  private toggleModelPopup() {
    if (this.openPopup) {
      const wasModel = this.openPopup.el.classList.contains("claudian-popup-model");
      this.closePopup();
      if (wasModel) return;
    }
    const popup = this.createPopup("claudian-popup-model");
    popup.createDiv({ cls: "claudian-popup-header", text: "CLAUDE" });
    for (const key of Object.keys(MODEL_LABELS) as ModelKey[]) {
      const row = popup.createDiv({
        cls: "claudian-popup-row" + (key === this.currentModel ? " is-selected" : ""),
      });
      const icon = row.createSpan({ cls: "claudian-popup-row-icon" });
      const img = icon.createEl("img");
      img.src = CLAUDE_ASTERISK_DATA_URI;
      img.alt = "";
      row.createSpan({ cls: "claudian-popup-row-label", text: MODEL_LABELS[key] });
      row.addEventListener("click", e => {
        e.stopPropagation();
        this.selectModel(key);
        this.closePopup();
      });
    }
    this.anchorPopup(popup, this.modelPill);
  }

  /* Switching off Opus while X-High is selected would leave an effort the
     new model doesn't expose in the UI — silently demote to High so the
     pill and the spawned subprocess stay in sync. */
  private selectModel(model: ModelKey) {
    const allowed = effortLevelsForModel(model);
    if (!allowed.includes(this.currentEffort)) {
      this.currentEffort = "high";
      this.refreshEffortPill();
      this.callbacks.onEffortChange("high");
    }
    this.currentModel = model;
    this.refreshModelPill();
    this.callbacks.onModelChange(model);
  }

  private toggleEffortPopup() {
    if (this.openPopup) {
      const wasEffort = this.openPopup.el.classList.contains("claudian-popup-effort");
      this.closePopup();
      if (wasEffort) return;
    }
    const popup = this.createPopup("claudian-popup-effort");
    for (const key of effortLevelsForModel(this.currentModel)) {
      const row = popup.createDiv({
        cls: "claudian-popup-row" + (key === this.currentEffort ? " is-selected" : ""),
        text: EFFORT_LABELS[key],
      });
      row.addEventListener("click", e => {
        e.stopPropagation();
        this.currentEffort = key;
        this.refreshEffortPill();
        this.callbacks.onEffortChange(key);
        this.closePopup();
      });
    }
    this.anchorPopup(popup, this.effortPill);
  }

  private createPopup(extraClass: string): HTMLElement {
    const popup = this.wrapper.createDiv({ cls: `claudian-popup ${extraClass}` });
    /* Stop clicks inside the popup from being treated as "outside" clicks. */
    popup.addEventListener("click", e => e.stopPropagation());
    return popup;
  }

  /* Position the popup so it sits just above its trigger, growing upward.
     The vertical anchor is `wrapperBottom - triggerTop`, which places the
     popup's bottom edge 4px above the trigger's top:
       - For TOP-row triggers (mode/model), that puts the popup above the
         wrapper itself, floating into the chat scroll area.
       - For BOTTOM-row triggers (effort), it puts the popup just above the
         effort button, overlapping the textarea — close to the click target
         like a normal dropdown rather than floating against the chat.

     Horizontal anchor flips based on which half of the wrapper the trigger
     sits in: triggers in the left half pin the popup's LEFT edge to the
     trigger's left; triggers in the right half pin the popup's RIGHT edge
     to the trigger's right. Without this flip the model pill (top-right)
     extends rightward off-screen. */
  private anchorPopup(popup: HTMLElement, trigger: HTMLElement) {
    const triggerRect = trigger.getBoundingClientRect();
    const wrapperRect = this.wrapper.getBoundingClientRect();
    popup.style.position = "absolute";

    const wrapperMidX = (wrapperRect.left + wrapperRect.right) / 2;
    const triggerMidX = (triggerRect.left + triggerRect.right) / 2;
    if (triggerMidX > wrapperMidX) {
      popup.style.right = `${wrapperRect.right - triggerRect.right}px`;
      popup.style.left = "";
    } else {
      popup.style.left = `${triggerRect.left - wrapperRect.left}px`;
      popup.style.right = "";
    }

    popup.style.bottom = `${wrapperRect.bottom - triggerRect.top + 4}px`;
    popup.style.top = "";

    /* outsideHandler closes the popup when the user clicks anywhere else
       on the page — EXCEPT on a toolbar pill, which has its own click
       handler that runs after this one. Letting the pill click bubble
       through without closing here keeps the toggle behavior correct:
         - Click the SAME pill again → its toggle handler sees openPopup
           still set and closes it (true toggle).
         - Click a DIFFERENT pill → its toggle handler closes this popup
           and opens the new one in one frame.
       Without the skip, the mousedown here would close the popup BEFORE
       the pill's click handler runs, and the click handler would then
       see openPopup as null and pop the same popup right back open. */
    const outsideHandler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popup.contains(target)) return;
      const el = e.target as HTMLElement;
      if (el && typeof el.closest === "function" && el.closest(".claudian-toolbar-pill")) return;
      this.closePopup();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.closePopup();
    };
    /* Defer attaching so the click that opened the popup doesn't immediately
       close it via the document listener firing in the same tick. */
    window.setTimeout(() => {
      document.addEventListener("mousedown", outsideHandler);
      document.addEventListener("keydown", keyHandler);
    }, 0);
    this.openPopup = { el: popup, outsideHandler, keyHandler };
  }

  private closePopup() {
    if (!this.openPopup) return;
    document.removeEventListener("mousedown", this.openPopup.outsideHandler);
    document.removeEventListener("keydown", this.openPopup.keyHandler);
    this.openPopup.el.remove();
    this.openPopup = null;
  }

  private handleKeydown(e: KeyboardEvent) {
    /* When the suggestion popup is open, arrow keys + Enter/Tab navigate it.
       Esc closes it. Everything else falls through to normal typing. */
    if (this.suggestion) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.moveSuggestion(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this.moveSuggestion(-1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (e.isComposing) return;
        e.preventDefault();
        e.stopPropagation();
        this.acceptSuggestion();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.hideSuggestion();
        return;
      }
    }

    /* Esc while Claude is streaming = cancel the current turn. Only fires
       when busy so a stray Esc on an idle input doesn't fire a no-op.
       During IME composition Escape is the user dismissing the candidate
       window — never an interrupt request — so bail before we'd otherwise
       kill the turn behind their back. */
    if (e.key === "Escape" && this.busy) {
      if (e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      this.callbacks.onCancel();
      return;
    }

    /* Shift+Tab cycles through permission modes — matches the Claude Code
       terminal's Normal → Accept Edits → Plan → Auto → Bypass cycle.
       stopPropagation prevents Obsidian's focus-cycling from stealing the key. */
    if (e.key === "Tab" && e.shiftKey && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      this.cyclePermissionMode();
      return;
    }
    if (e.key !== "Enter") return;
    if (e.isComposing) return;
    if (e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    this.submit();
  }

  /* Scan the text up to the cursor for an active `@` or `/` trigger and show
     the matching suggestion popup, or hide if no trigger is active. */
  private updateSuggestion() {
    const cursor = this.textarea.selectionStart ?? 0;
    const before = this.textarea.value.slice(0, cursor);

    /* `@` trigger: preceded by start-of-text or whitespace, followed by chars
       that could plausibly be part of a vault path (alphanumerics, `_.-/`).
       Restricted from `[^\s@]*` to avoid firing on things like email handles
       (`user@host.com`) or other non-path tokens, and to cut down on stray
       vault-index lookups for queries that can never resolve. */
    const atMatch = before.match(/(?:^|\s)@([A-Za-z0-9_.\-\/]*)$/);
    if (atMatch) {
      const query = atMatch[1];
      const triggerStart = cursor - query.length - 1;  // index of "@"
      const items = this.callbacks.onMentionQuery(query);
      this.showSuggestion("@", triggerStart, items);
      return;
    }

    /* `/` trigger: only at the very start of the textarea (slash commands
       are first-token). */
    const slashMatch = before.match(/^\/([\w-]*)$/);
    if (slashMatch) {
      const query = slashMatch[1];
      const items = this.callbacks.onSlashQuery(query);
      this.showSuggestion("/", 0, items);
      return;
    }

    this.hideSuggestion();
  }

  private showSuggestion(trigger: "@" | "/", triggerStart: number, items: Suggestion[]) {
    if (items.length === 0) {
      this.hideSuggestion();
      return;
    }
    /* If we already have an open popup of the same trigger, just update items
       in place — avoids tearing down and rebuilding on each keystroke. */
    if (this.suggestion && this.suggestion.trigger === trigger) {
      this.suggestion.triggerStart = triggerStart;
      this.suggestion.items = items;
      this.suggestion.activeIndex = Math.min(this.suggestion.activeIndex, items.length - 1);
      this.renderSuggestionRows();
      return;
    }
    this.hideSuggestion();
    const el = this.wrapper.createDiv({ cls: `claudian-suggestion-popup claudian-suggestion-${trigger === "@" ? "mention" : "slash"}` });
    this.suggestion = { el, trigger, triggerStart, items, activeIndex: 0 };
    this.renderSuggestionRows();
  }

  private renderSuggestionRows() {
    if (!this.suggestion) return;
    const { el, items, activeIndex } = this.suggestion;
    el.empty();
    let activeRow: HTMLElement | null = null;
    items.forEach((item, i) => {
      const row = el.createDiv({
        cls: "claudian-suggestion-row" + (i === activeIndex ? " is-active" : ""),
      });
      if (i === activeIndex) activeRow = row;
      if (item.icon) {
        const iconEl = row.createSpan({ cls: "claudian-suggestion-icon" });
        setIcon(iconEl, item.icon);
      }
      const labels = row.createDiv({ cls: "claudian-suggestion-labels" });
      labels.createDiv({ cls: "claudian-suggestion-primary", text: item.primary });
      if (item.secondary) {
        labels.createDiv({ cls: "claudian-suggestion-secondary", text: item.secondary });
      }
      /* mousedown not click — by the time click fires the textarea's blur
         handler has already torn down the popup. */
      row.addEventListener("mousedown", e => {
        e.preventDefault();
        if (!this.suggestion) return;
        this.suggestion.activeIndex = i;
        this.acceptSuggestion();
      });
    });
    /* Keep the active row visible when the user arrow-keys past the fold.
       `nearest` block avoids jumpiness when the row is already on-screen. */
    if (activeRow) (activeRow as HTMLElement).scrollIntoView({ block: "nearest" });
  }

  private moveSuggestion(delta: number) {
    if (!this.suggestion) return;
    const len = this.suggestion.items.length;
    this.suggestion.activeIndex = (this.suggestion.activeIndex + delta + len) % len;
    this.renderSuggestionRows();
  }

  private acceptSuggestion() {
    if (!this.suggestion) return;
    const item = this.suggestion.items[this.suggestion.activeIndex];
    if (!item) return;
    const cursor = this.textarea.selectionStart ?? this.textarea.value.length;
    const before = this.textarea.value.slice(0, this.suggestion.triggerStart);
    const after = this.textarea.value.slice(cursor);
    const insert = item.insert + " ";
    this.textarea.value = before + insert + after;
    const newCursor = before.length + insert.length;
    this.textarea.selectionStart = this.textarea.selectionEnd = newCursor;
    this.hideSuggestion();
    this.autoResize();
    this.textarea.focus();
  }

  private hideSuggestion() {
    if (!this.suggestion) return;
    this.suggestion.el.remove();
    this.suggestion = null;
  }

  private handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItems = Array.from(items).filter(it => it.kind === "file" && it.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    /* Many sources (screenshot tools, browsers copying images with alt text,
       rich editors) populate the clipboard with BOTH a text payload and an
       image. Previous behavior preventDefault()'d unconditionally on image
       presence, silently dropping the text. Instead: only preventDefault when
       the clipboard is image-only. When text is also present, let the browser
       handle the text paste normally and process the image asynchronously into
       the attachment list (FileReader is already async, so the text paste
       lands first regardless). */
    const hasText = Array.from(items).some(it => it.kind === "string" && it.type === "text/plain");
    if (!hasText) e.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      const reader = new FileReader();
      reader.onload = () => {
        if (this.destroyed) return;
        const result = reader.result as string;
        const comma = result.indexOf(",");
        const data = comma >= 0 ? result.slice(comma + 1) : result;
        this.attachments.push({ mediaType: file.type, data });
        this.renderAttachmentChips();
      };
      reader.readAsDataURL(file);
    }
  }

  private handleDrop(e: DragEvent) {
    const dt = e.dataTransfer;
    if (!dt) return;
    const text = dt.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    const sel = this.textarea.selectionStart ?? this.textarea.value.length;
    const prevChar = this.textarea.value.charAt(sel - 1);
    const needsSpace = sel > 0 && prevChar && !/\s/.test(prevChar);
    this.insertAtCursor((needsSpace ? " " : "") + text + " ");
  }

  /* Push the active editor selection into the input as a pinned chip.
     `null` clears the chip. Selection text and line range are remembered
     across keystrokes so the user can type a question without it dropping. */
  setSelection(selection: ActiveSelection | null) {
    this.currentSelection = selection;
    this.renderContextRow();
  }

  getSelection(): ActiveSelection | null { return this.currentSelection; }

  /* Renders both the editor-selection chip (if any) and the attachment
     chips. Single entry point so the row's visual state always matches what
     the user is actually carrying. */
  private renderContextRow() {
    this.contextRow.empty();
    const hasAny = this.attachments.length > 0 || this.currentSelection !== null;
    this.contextRow.toggleClass("has-content", hasAny);

    if (this.currentSelection) {
      const sel = this.currentSelection;
      const chip = this.contextRow.createDiv({ cls: "claudian-context-chip claudian-context-chip-selection" });
      const iconEl = chip.createSpan({ cls: "claudian-context-chip-icon" });
      setIcon(iconEl, "text-cursor");
      const fileName = sel.filePath.split("/").pop() ?? sel.filePath;
      const rangeLabel = sel.startLine === sel.endLine
        ? `line ${sel.startLine}`
        : `lines ${sel.startLine}–${sel.endLine}`;
      chip.createSpan({
        cls: "claudian-context-chip-label",
        text: `${fileName} · ${rangeLabel}`,
        attr: { title: sel.filePath },
      });
      const remove = chip.createSpan({
        cls: "claudian-context-chip-remove",
        attr: { "aria-label": "Detach selection", title: "Detach selection" },
      });
      setIcon(remove, "x");
      remove.addEventListener("click", e => {
        e.stopPropagation();
        this.currentSelection = null;
        this.renderContextRow();
        /* Notify the caller so SelectionTracker can be cleared in lockstep.
           Without this, the next refresh() in SelectionTracker re-emits the
           same selection and the chip pops back into view. See
           InputBoxCallbacks.onSelectionDismissed for the contract. */
        this.callbacks.onSelectionDismissed?.();
      });
    }

    this.attachments.forEach((att, i) => {
      const chip = this.contextRow.createDiv({ cls: "claudian-context-chip" });
      const iconEl = chip.createSpan({ cls: "claudian-context-chip-icon" });
      setIcon(iconEl, "image");
      const subtype = att.mediaType.split("/")[1] || "image";
      chip.createSpan({ cls: "claudian-context-chip-label", text: `${subtype.toUpperCase()} attachment` });
      const remove = chip.createSpan({ cls: "claudian-context-chip-remove", attr: { "aria-label": "Remove", title: "Remove" } });
      setIcon(remove, "x");
      remove.addEventListener("click", e => {
        e.stopPropagation();
        this.attachments.splice(i, 1);
        this.renderContextRow();
      });
    });
  }

  /* Back-compat shim — earlier callers still reference renderAttachmentChips.
     Both attachments and selection chips render through renderContextRow now. */
  private renderAttachmentChips() {
    this.renderContextRow();
  }

  private submit() {
    if (this.busy) return;
    const text = this.textarea.value.trim();
    if (!text && this.attachments.length === 0 && !this.currentSelection) return;
    this.textarea.value = "";
    this.autoResize();
    const attachments = this.attachments;
    const selection = this.currentSelection ?? undefined;
    this.attachments = [];
    this.currentSelection = null;
    this.renderContextRow();
    this.callbacks.onSubmit({ text, attachments, selection });
  }

  private autoResize() {
    this.textarea.style.height = "auto";
    const max = Math.floor(window.innerHeight * 0.45);
    /* Add a 4px buffer so the last wrapped line's descenders (j, g, y, p)
       have room to clear the textarea's bottom padding. Browsers' textarea
       scrollHeight is computed against line-height alone — it ignores the
       extra pixels glyph descenders need below the baseline. Capped
       against max (45% of viewport) so a very long message still scrolls. */
    const desired = this.textarea.scrollHeight + 4;
    const newHeight = Math.min(desired, max);
    this.textarea.style.height = newHeight + "px";
    /* Always anchor scroll to the bottom. Two reasons:
       1. Browsers' textarea scrollHeight can be a few pixels short of
          what's actually needed (descender-clip bug). Pinning scrollTop
          to scrollHeight pushes the last line to the bottom of the
          content area, where the padding-bottom of the textarea frame
          is always visually present below it — so the gap survives even
          when our height calculation is a hair too small.
       2. The user is typing at the end of text in a chat composer, so
          the caret is at the bottom anyway — keeping the textarea
          scrolled to the bottom matches caret position. */
    this.textarea.scrollTop = this.textarea.scrollHeight;
  }
}
