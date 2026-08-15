/* Toast, context menu, modal and suggest-modal built out of plain DOM.

   These stand in for obsidian.Notice / Menu / Modal / SuggestModal. Two
   naming rules run through the file:

   - Anything shared code can see keeps Obsidian's structural class names
     (modal-container, modal-bg, modal, modal-close-button, modal-title,
     modal-content, prompt, prompt-input, prompt-results, suggestion-item,
     is-selected), because styles.css and the shared modals were written
     against them.
   - Anything with no Obsidian counterpart is namespaced claudesk-*.

   Positioning that has to be computed at runtime (a menu at the cursor, the
   toast stack) is set inline; everything a stylesheet can own is left to
   desktop.css. */

import type {
  MenuItemSpec,
  ModalDelegate,
  ModalHost,
  SuggestModalDelegate,
  SuggestModalHost,
} from "../../src/platform/types";
import { renderIcon } from "./desktop-icons";

const DEFAULT_TOAST_MS = 4000;

/* ----- toast ------------------------------------------------------------ */

let toastContainer: HTMLElement | null = null;

function getToastContainer(): HTMLElement {
  if (toastContainer && toastContainer.isConnected) return toastContainer;
  const el = document.body.createDiv({ cls: "claudesk-toast-container" });
  /* Inline because the container is this module's private scaffolding and
     desktop.css only owns the toast's own appearance (.claudesk-toast).
     pointer-events:none keeps the stack from eating clicks on the panel
     behind it; individual toasts re-enable it if they ever need to. */
  Object.assign(el.style, {
    position: "fixed",
    left: "0",
    right: "0",
    bottom: "12px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "6px",
    pointerEvents: "none",
    zIndex: "1000",
  });
  toastContainer = el;
  return el;
}

export function showToast(message: string, timeoutMs?: number): void {
  const toast = getToastContainer().createDiv({ cls: "claudesk-toast", text: message });
  window.setTimeout(() => toast.detach(), timeoutMs ?? DEFAULT_TOAST_MS);
}

/* ----- context menu ----------------------------------------------------- */

let openMenu: HTMLElement | null = null;
let dismissMenu: (() => void) | null = null;

export function showContextMenuAt(evt: MouseEvent, items: MenuItemSpec[]): void {
  dismissMenu?.();

  const menu = document.body.createDiv({ cls: "claudesk-menu" });
  /* Measured below, so keep it out of the layout flow and invisible until
     the final coordinates are known. */
  menu.style.position = "fixed";
  menu.style.visibility = "hidden";

  const dismiss = () => {
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", dismiss);
    window.removeEventListener("resize", dismiss);
    menu.detach();
    if (openMenu === menu) {
      openMenu = null;
      dismissMenu = null;
    }
  };
  const onOutside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) dismiss();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    dismiss();
  };

  for (const spec of items) {
    const row = menu.createDiv({ cls: "claudesk-menu-item" });
    const iconEl = row.createSpan({ cls: "claudesk-menu-item-icon" });
    if (spec.icon) renderIcon(iconEl, spec.icon);
    row.createSpan({ cls: "claudesk-menu-item-title", text: spec.title });
    row.addEventListener("click", () => {
      dismiss();
      spec.onClick();
    });
  }

  const rect = menu.getBoundingClientRect();
  const margin = 6;
  const left = Math.max(margin, Math.min(evt.clientX, window.innerWidth - rect.width - margin));
  const top = Math.max(margin, Math.min(evt.clientY, window.innerHeight - rect.height - margin));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = "";

  /* Registered after the current event has already been dispatched, so the
     click that opened the menu cannot immediately close it. */
  document.addEventListener("mousedown", onOutside, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", dismiss);
  window.addEventListener("resize", dismiss);

  openMenu = menu;
  dismissMenu = dismiss;
}

/* ----- shared overlay plumbing ------------------------------------------ */

/* Where focus goes when an overlay closes and the element it was taken from
   is unusable — which is the common case here, not the exception: the
   settings modal is usually opened from the tray with the panel freshly
   shown, so document.activeElement was already <body>. Set once by
   renderer.ts to the shell's composer. Obsidian's Modal/SuggestModal restore
   focus themselves and the user lands back in an editor either way; in the
   standalone panel the composer IS the app, and a dropped focus makes the
   whole keyboard-first surface go dead until the user reaches for the mouse. */
let overlayFocusFallback: (() => void) | null = null;

export function setOverlayFocusFallback(fn: (() => void) | null): void {
  overlayFocusFallback = fn;
}

/* Hand focus back after `containerEl` is torn down. `prevFocus` wins when it
   is still usable; otherwise the fallback. A chooser that already moved focus
   somewhere real (SuggestModal.choose closes BEFORE calling the chooser, and
   SubagentPicker's submit() focuses the composer) is left alone. */
function restoreFocusAfterClose(containerEl: HTMLElement, prevFocus: HTMLElement | null): void {
  const active = document.activeElement;
  const focusIsLoose = active === null || active === document.body || containerEl.contains(active);
  if (!focusIsLoose) return;
  if (prevFocus && prevFocus.isConnected && prevFocus !== document.body) {
    prevFocus.focus();
    return;
  }
  overlayFocusFallback?.();
}

function currentFocus(): HTMLElement | null {
  const active = document.activeElement;
  return active instanceof HTMLElement ? active : null;
}

/* Esc must only reach the topmost overlay: MCPManagerModal opens an edit
   modal over itself, and closing both on one keypress would lose the edit.
   `.modal-container` is also the marker the renderer's own Esc handler
   checks before hiding the panel, so the class has to stay on the outermost
   element. */
function isTopmostOverlay(containerEl: HTMLElement): boolean {
  const all = document.body.querySelectorAll(":scope > .modal-container");
  return all.length === 0 || all[all.length - 1] === containerEl;
}

function buildOverlayContainer(): { containerEl: HTMLElement; bgEl: HTMLElement } {
  /* Detached until open(); mod-dim matches the class Obsidian puts on a
     dimming backdrop so the same rules apply. */
  const containerEl = document.createElement("div");
  containerEl.addClass("modal-container", "mod-dim");
  const bgEl = containerEl.createDiv({ cls: "modal-bg" });
  return { containerEl, bgEl };
}

/* ----- modal ------------------------------------------------------------ */

export class DomModalHost implements ModalHost {
  private readonly containerEl: HTMLElement;
  private readonly modalEl: HTMLElement;
  readonly titleEl: HTMLElement;
  readonly contentEl: HTMLElement;
  private isOpen = false;
  /* Whatever had focus when we took it, so close() can give it back. */
  private prevFocus: HTMLElement | null = null;

  constructor(private readonly delegate: ModalDelegate) {
    /* obsidian.Modal builds its DOM in the constructor and subclasses touch
       contentEl/titleEl before open(), so the tree exists from here on. */
    const { containerEl, bgEl } = buildOverlayContainer();
    this.containerEl = containerEl;
    bgEl.addEventListener("click", () => this.close());

    this.modalEl = containerEl.createDiv({ cls: "modal" });
    /* Focusable so keystrokes land on the modal rather than whatever the
       panel had focused; -1 keeps it out of the tab order. */
    this.modalEl.setAttr("tabindex", "-1");
    const closeEl = this.modalEl.createDiv({ cls: "modal-close-button" });
    closeEl.addEventListener("click", () => this.close());
    this.titleEl = this.modalEl.createDiv({ cls: "modal-title" });
    this.contentEl = this.modalEl.createDiv({ cls: "modal-content" });
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !isTopmostOverlay(this.containerEl)) return;
    e.preventDefault();
    e.stopPropagation();
    this.close();
  };

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.prevFocus = currentFocus();
    document.body.appendChild(this.containerEl);
    document.addEventListener("keydown", this.onKeyDown, true);
    this.modalEl.focus();
    /* Fire-and-forget, exactly how obsidian.Modal treats an `async onOpen`
       (MCPManagerModal and HistoryModal both declare one). */
    void this.delegate.onOpen?.();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    document.removeEventListener("keydown", this.onKeyDown, true);
    this.containerEl.detach();
    /* contentEl is NOT emptied here — subclasses do it in their own
       onClose(), same as under Obsidian. */
    this.delegate.onClose?.();
    /* After onClose, so a delegate that deliberately focuses something wins. */
    const prev = this.prevFocus;
    this.prevFocus = null;
    restoreFocusAfterClose(this.containerEl, prev);
  }
}

/* ----- suggest modal ---------------------------------------------------- */

export class DomSuggestModalHost<T> implements SuggestModalHost {
  private readonly containerEl: HTMLElement;
  private readonly inputEl: HTMLInputElement;
  private readonly resultsEl: HTMLElement;
  private isOpen = false;
  private items: T[] = [];
  private selected = 0;
  /* Whatever had focus when we took it, so close() can give it back. */
  private prevFocus: HTMLElement | null = null;
  /* Monotonic token so a slow getSuggestions() promise can't overwrite the
     results of a query the user has already typed past. */
  private queryToken = 0;

  constructor(private readonly delegate: SuggestModalDelegate<T>) {
    const { containerEl, bgEl } = buildOverlayContainer();
    this.containerEl = containerEl;
    bgEl.addEventListener("click", () => this.close());

    const promptEl = containerEl.createDiv({ cls: "prompt" });
    const inputContainer = promptEl.createDiv({ cls: "prompt-input-container" });
    this.inputEl = inputContainer.createEl("input", {
      cls: "prompt-input",
      attr: { type: "text", enterkeyhint: "done" },
    });
    this.resultsEl = promptEl.createDiv({ cls: "prompt-results" });

    this.inputEl.addEventListener("input", () => void this.runQuery());
    this.inputEl.addEventListener("keydown", this.onKeyDown);
  }

  setPlaceholder(text: string): void {
    this.inputEl.placeholder = text;
  }

  open(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    this.prevFocus = currentFocus();
    document.body.appendChild(this.containerEl);
    document.addEventListener("keydown", this.onEscape, true);
    this.inputEl.value = "";
    this.inputEl.focus();
    void this.runQuery();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    document.removeEventListener("keydown", this.onEscape, true);
    this.containerEl.detach();
    this.resultsEl.empty();
    this.items = [];
    const prev = this.prevFocus;
    this.prevFocus = null;
    restoreFocusAfterClose(this.containerEl, prev);
  }

  /* Esc is caught at the document so it works even if focus wandered out of
     the input (a renderSuggestion callback can create focusable content). */
  private onEscape = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || !isTopmostOverlay(this.containerEl)) return;
    e.preventDefault();
    e.stopPropagation();
    this.close();
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.moveSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.moveSelection(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = this.items[this.selected];
      if (item !== undefined) this.choose(item, e);
    }
  };

  private async runQuery(): Promise<void> {
    const token = ++this.queryToken;
    const results = await Promise.resolve(this.delegate.getSuggestions(this.inputEl.value));
    if (token !== this.queryToken || !this.isOpen) return;
    this.items = results;
    this.selected = 0;
    this.renderResults();
  }

  private renderResults(): void {
    this.resultsEl.empty();
    this.items.forEach((item, idx) => {
      const el = this.resultsEl.createDiv({ cls: "suggestion-item" });
      this.delegate.renderSuggestion(item, el);
      if (idx === this.selected) el.addClass("is-selected");
      /* scroll:false — the row is under the cursor by definition. Scrolling on
         hover moves a DIFFERENT row under a stationary pointer, which fires
         another mousemove and makes the selection skitter. Obsidian's
         SuggestModal makes the same distinction. */
      el.addEventListener("mousemove", () => this.setSelection(idx, false));
      /* mousedown, not click: the input still has focus and a click would
         first blur it, which some renderSuggestion trees intercept. */
      el.addEventListener("mousedown", e => {
        e.preventDefault();
        this.choose(item, e);
      });
    });
  }

  private moveSelection(delta: number): void {
    if (this.items.length === 0) return;
    const next = (this.selected + delta + this.items.length) % this.items.length;
    this.setSelection(next);
  }

  /* `scroll` is only correct for keyboard navigation, where the target may be
     off-screen. */
  private setSelection(index: number, scroll = true): void {
    if (index === this.selected) return;
    const rows = this.resultsEl.children;
    rows[this.selected]?.removeClass("is-selected");
    this.selected = index;
    const el = rows[index];
    if (el) {
      el.addClass("is-selected");
      if (scroll) el.scrollIntoView({ block: "nearest" });
    }
  }

  /* Close BEFORE handing the item over: the chooser typically refocuses the
     composer (SubagentPicker -> launchSubagent -> submit), and tearing the
     overlay down afterwards would steal that focus back. */
  private choose(item: T, evt: MouseEvent | KeyboardEvent): void {
    this.close();
    this.delegate.onChooseSuggestion(item, evt);
  }
}
