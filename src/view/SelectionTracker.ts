import { MarkdownView, type App, type EventRef } from "obsidian";

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
    if (this.current !== null) {
      this.current = null;
      this.onChange(null);
    }
  }

  private refresh() {
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
    if (!text || text.trim().length === 0) return this.emit(null);
    const from = editor.getCursor("from");
    const to = editor.getCursor("to");
    this.emit({
      filePath: view.file.path,
      text,
      startLine: from.line + 1,
      endLine: to.line + 1,
    });
  }

  private emit(sel: ActiveSelection | null) {
    if (selectionEquals(this.current, sel)) return;
    this.current = sel;
    this.onChange(sel);
  }
}

function selectionEquals(a: ActiveSelection | null, b: ActiveSelection | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.filePath === b.filePath
    && a.text === b.text
    && a.startLine === b.startLine
    && a.endLine === b.endLine;
}
