import { setIcon, TFile, type App, type EventRef } from "obsidian";

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
  private root: HTMLElement;
  private callbacks: FilePillCallbacks;
  private pinnedPaths: Set<string>;
  private currentActiveFile: TFile | null = null;
  private eventRef: EventRef | null = null;

  constructor(parent: HTMLElement, app: App, initialPinned: string[], callbacks: FilePillCallbacks) {
    this.app = app;
    this.callbacks = callbacks;
    this.pinnedPaths = new Set(initialPinned);
    this.root = parent.createDiv({ cls: "claudian-file-pill-bar" });
    /* Hidden by default — only shown when there's at least one pill to
       render (active file or a pinned file). */
    this.root.style.display = "none";

    this.refresh();
    this.eventRef = this.app.workspace.on("active-leaf-change", () => this.refresh());
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
    this.root.empty();
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
      return;
    }
    this.root.style.display = "";
    for (const { path, isActive, pinned } of visible.values()) {
      this.renderPill(path, isActive, pinned);
    }
  }

  private renderPill(path: string, isActive: boolean, pinned: boolean) {
    const pill = this.root.createDiv({
      cls: "claudian-file-pill"
        + (pinned ? " is-pinned" : "")
        + (isActive ? " is-active-file" : ""),
      attr: { title: pinned ? `${path} · pinned (click to unpin)` : `${path} · click to pin` },
    });
    const iconEl = pill.createSpan({ cls: "claudian-file-pill-icon" });
    const ext = path.split(".").pop() ?? "";
    setIcon(iconEl, ext === "canvas" ? "layout-grid" : "file-text");
    const fileName = path.split("/").pop() ?? path;
    pill.createSpan({ cls: "claudian-file-pill-label", text: fileName });
    pill.addEventListener("click", () => this.togglePin(path));
  }

  private togglePin(path: string) {
    if (this.pinnedPaths.has(path)) this.pinnedPaths.delete(path);
    else this.pinnedPaths.add(path);
    this.renderPills();
    this.callbacks.onPinChange([...this.pinnedPaths]);
  }
}
