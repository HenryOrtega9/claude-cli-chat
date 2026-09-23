import { MarkdownView, type App, type EventRef } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { clearKeptSelection, setKeptSelection } from "./SelectionHighlight";

export type ActiveSelection = {
  filePath: string;
  text: string;
  /* 1-indexed for display in chips and prompts (Obsidian editors are 0-indexed
     internally — we convert). */
  startLine: number;
  endLine: number;
};

/* Watches the currently-active markdown editor's selection and notifies
   callers whenever it changes. Uses the DOM `selectionchange` event because
   Obsidian's workspace API doesn't expose a direct selection signal — that
   event fires on every cursor move + selection change, so we coalesce
   via microtask to avoid one notification per character of motion.

   Cleanup is critical: every tab spawns its own tracker, so a stale listener
   could pile up across tab churn. `destroy()` removes both DOM and workspace
   subscriptions. */
export class SelectionTracker {
  private app: App;
  private onChange: (sel: ActiveSelection | null) => void;
  private current: ActiveSelection | null = null;
  private workspaceRef: EventRef | null = null;
  private selectionListener: (() => void) | null = null;
  private refreshScheduled = false;
  /* Timestamp of the last explicit clear(). A microtask refresh queued just
     before clear() lands will still fire after it; without this guard, that
     refresh re-emits the same selection and the chip the user just dismissed
     immediately reappears. Refreshes within 100ms of a clear are dropped. */
  private clearedAt = 0;
  /* Editor currently painting the kept-selection highlight (see
     SelectionHighlight). Tracked so a clear or a move to another note
     removes the mark from the editor that actually has it. */
  private highlightView: EditorView | null = null;

  constructor(app: App, onChange: (sel: ActiveSelection | null) => void) {
    this.app = app;
    this.onChange = onChange;

    /* DOM selectionchange fires on every cursor move + drag, so coalesce
       through a microtask. selectionchange is global (fires for our own
       textarea too); the refresh() check ignores cases where there isn't an
       active markdown view OR where the selection is collapsed. */
    this.selectionListener = () => {
      if (this.refreshScheduled) return;
      this.refreshScheduled = true;
      Promise.resolve().then(() => {
        this.refreshScheduled = false;
        this.refresh();
      });
    };
    document.addEventListener("selectionchange", this.selectionListener);

    /* Switching files clears the prior editor's selection but doesn't fire
       a selectionchange. Refresh manually on leaf change. */
    this.workspaceRef = app.workspace.on("active-leaf-change", () => this.refresh());

    /* Initial pass in case the user already had a selection when the tab
       was opened. */
    this.refresh();
  }

  destroy() {
    this.clearHighlight();
    if (this.workspaceRef) {
      this.app.workspace.offref(this.workspaceRef);
      this.workspaceRef = null;
    }
    if (this.selectionListener) {
      document.removeEventListener("selectionchange", this.selectionListener);
      this.selectionListener = null;
    }
  }

  getCurrent(): ActiveSelection | null { return this.current; }

  /* Force-clear the tracked selection — used after the user dismisses the
     chip manually or after a submit consumed it. */
  clear() {
    this.clearedAt = Date.now();
    this.clearHighlight();
    if (this.current !== null) {
      this.current = null;
      this.onChange(null);
    }
  }

  private refresh() {
    /* Drop refreshes scheduled around a clear() — the underlying editor
       selection is still live, so a refresh here would re-emit it and undo
       the user's dismissal. 100ms covers the microtask-coalesced batch plus
       any selectionchange that fires as Obsidian processes the click. */
    if (Date.now() - this.clearedAt < 100) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    /* No markdown view in the workspace's active leaf usually means the
       user moved focus to our chat textarea (or to a non-markdown view).
       The selection in their editor is still visually present — CM6
       preserves selection state across focus changes — so we DON'T clear
       the tracked selection here. Only updates happen on this code path;
       clearing only happens below when an editor IS active and its
       selection is genuinely empty. */
    if (!view || !view.file) return;

    const editor = view.editor;
    const text = editor.getSelection();
    if (!text || text.trim().length === 0) {
      this.clearHighlight();
      return this.emit(null);
    }
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    this.paintHighlight(editorViewOf(view), editor.posToOffset(from), editor.posToOffset(to));
    this.emit({
      filePath: view.file.path,
      text,
      startLine: from.line + 1,
      endLine: to.line + 1,
    });
  }

  private paintHighlight(cm: EditorView | null, from: number, to: number) {
    if (this.highlightView && this.highlightView !== cm) this.clearHighlight();
    if (!cm) return;
    setKeptSelection(cm, from, to);
    this.highlightView = cm;
  }

  private clearHighlight() {
    if (!this.highlightView) return;
    clearKeptSelection(this.highlightView);
    this.highlightView = null;
  }

  private emit(sel: ActiveSelection | null) {
    if (selectionEquals(this.current, sel)) return;
    this.current = sel;
    this.onChange(sel);
  }
}

/* Obsidian's Editor wraps a CM6 EditorView on `.cm`. Not in the public
   typings, so read it defensively: a missing view just means no highlight. */
function editorViewOf(view: MarkdownView): EditorView | null {
  const cm = (view.editor as unknown as { cm?: EditorView }).cm;
  return cm && typeof cm.dispatch === "function" ? cm : null;
}

function selectionEquals(a: ActiveSelection | null, b: ActiveSelection | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.filePath === b.filePath
    && a.text === b.text
    && a.startLine === b.startLine
    && a.endLine === b.endLine;
}
