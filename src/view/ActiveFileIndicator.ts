import { setIcon, TFile, type App, type EventRef } from "obsidian";
import { VIEW_TYPE_CLAUDE_CHAT } from "./ClaudeChatView";

/* Renders a row of file pills above the input box. The currently-active
   Obsidian file always shows; previously-pinned files persist as pills
   even after the user switches away. Click a pill to toggle its pinned
   state — pinned pills light up brand-orange, unpinned stay gray.

   On submit, the TabController reads `getPinnedPaths()` and prepends them
   as `@<path>` references in the wire text Claude receives. */

export type FilePillCallbacks = {
  /* Fires whenever the pinned set changes so callers can persist it. */
  onPinChange: (pinnedPaths: string[]) => void;
};

export class ActiveFileIndicator {
  private app: App;
  /* Public so the owner (TabController) can reparent the pill bar — currently
     mounted inside the input wrapper via InputBox.mountTopBar(). */
  readonly root: HTMLElement;
  private callbacks: FilePillCallbacks;
  private pinnedPaths: Set<string>;
  private currentActiveFile: TFile | null = null;
  private eventRef: EventRef | null = null;
  /* Per-path pill element cache. Surgical class updates against these
     existing elements (instead of empty()+recreate) preserve click handlers
     across refreshes, so an in-flight click can't be lost to a concurrent
     active-leaf-change rebuilding the DOM. */
  private pillElements = new Map<string, HTMLElement>();

  constructor(parent: HTMLElement, app: App, initialPinned: string[], callbacks: FilePillCallbacks) {
    this.app = app;
    this.callbacks = callbacks;
    this.pinnedPaths = new Set(initialPinned);
    this.root = parent.createDiv({ cls: "claudian-file-pill-bar" });
    /* Hidden by default — only shown when there's at least one pill to
       render (active file or a pinned file). */
    this.root.style.display = "none";

    this.refresh();
    /* Skip refreshes when the new active leaf is our own chat view. Clicking
       a pill in the chat panel (while a markdown leaf was previously active)
       fires active-leaf-change synchronously between mousedown and mouseup;
       running refresh() there would destroy the click target before the click
       event resolves, losing the pin. The user's underlying intent has not
       changed when focus moves to our own view, so the right behavior is to
       keep showing whatever file was active before. */
    this.eventRef = this.app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf?.view.getViewType() === VIEW_TYPE_CLAUDE_CHAT) return;
      this.refresh();
    });
  }

  destroy() {
    if (this.eventRef) {
      this.app.workspace.offref(this.eventRef);
      this.eventRef = null;
    }
    this.root.remove();
  }

  /* Returns the list of paths currently pinned. Read at submit time by
     TabController to build the @-context prefix. */
  getPinnedPaths(): string[] {
    return [...this.pinnedPaths];
  }

  private refresh() {
    const file = this.app.workspace.getActiveFile();
    /* Skip non-vault files and the plugin's own state files. */
    if (file && !file.path.startsWith(".claude-cli-chat/")) {
      this.currentActiveFile = file;
    } else {
      this.currentActiveFile = null;
    }
    this.renderPills();
  }

  private renderPills() {
    /* Build the visible set: active file + all pinned. De-duplicated by path
       so the active file is rendered once even if it's also pinned. */
    const visible = new Map<string, { path: string; isActive: boolean; pinned: boolean }>();
    if (this.currentActiveFile) {
      visible.set(this.currentActiveFile.path, {
        path: this.currentActiveFile.path,
        isActive: true,
        pinned: this.pinnedPaths.has(this.currentActiveFile.path),
      });
    }
    for (const p of this.pinnedPaths) {
      if (visible.has(p)) continue;
      visible.set(p, { path: p, isActive: false, pinned: true });
    }
    if (visible.size === 0) {
      this.root.style.display = "none";
      for (const el of this.pillElements.values()) el.remove();
      this.pillElements.clear();
      return;
    }
    this.root.style.display = "";

    /* Remove pills no longer in the visible set. Done before re-ordering so
       the position loop below sees only pills that should exist. */
    for (const [path, el] of [...this.pillElements]) {
      if (!visible.has(path)) {
        el.remove();
        this.pillElements.delete(path);
      }
    }

    /* Reuse existing pills when present, only updating their class state and
       title. Create + cache new ones for paths that didn't have a pill yet.
       After each pill is placed, walk it into the correct position so the
       DOM order matches the visible map's insertion order. */
    let prevPill: HTMLElement | null = null;
    for (const { path, isActive, pinned } of visible.values()) {
      let pill = this.pillElements.get(path);
      if (pill) {
        this.updatePillState(pill, path, isActive, pinned);
      } else {
        pill = this.createPill(path, isActive, pinned);
        this.pillElements.set(path, pill);
      }
      const expected: ChildNode | null = prevPill ? prevPill.nextSibling : this.root.firstChild;
      if (pill !== expected) {
        this.root.insertBefore(pill, expected);
      }
      prevPill = pill;
    }
  }

  private createPill(path: string, isActive: boolean, pinned: boolean): HTMLElement {
    /* Obsidian augments HTMLElement.prototype with createSpan/createDiv etc.,
       so detached elements get the same DOM helpers as Obsidian-created ones. */
    const pill = document.createElement("div");
    this.updatePillState(pill, path, isActive, pinned);
    const iconEl = pill.createSpan({ cls: "claudian-file-pill-icon" });
    const ext = path.split(".").pop() ?? "";
    setIcon(iconEl, ext === "canvas" ? "layout-grid" : "file-text");
    const fileName = path.split("/").pop() ?? path;
    pill.createSpan({ cls: "claudian-file-pill-label", text: fileName });
    pill.addEventListener("click", () => this.togglePin(path));
    return pill;
  }

  private updatePillState(pill: HTMLElement, path: string, isActive: boolean, pinned: boolean) {
    pill.className = "claudian-file-pill"
      + (pinned ? " is-pinned" : "")
      + (isActive ? " is-active-file" : "");
    pill.setAttribute("title", pinned ? `${path} · pinned (click to unpin)` : `${path} · click to pin`);
  }

  private togglePin(path: string) {
    if (this.pinnedPaths.has(path)) this.pinnedPaths.delete(path);
    else this.pinnedPaths.add(path);
    this.renderPills();
    this.callbacks.onPinChange([...this.pinnedPaths]);
  }
}
