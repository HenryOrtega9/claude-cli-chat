import { setIcon, TFile, TFolder, type App, type EventRef } from "obsidian";
import { VIEW_TYPE_CLAUDE_CHAT } from "./ClaudeChatView";
import { isExtractableOffice, officeIconName } from "../util/officeExtract";

/* Renders a row of file pills above the input box. The currently-active
   Obsidian file always shows; previously-pinned files persist as pills
   even after the user switches away. Click a pill to toggle its pinned
   state — pinned pills light up brand-orange, unpinned stay gray.

   On submit, the TabController reads `getPinnedPaths()` and prepends them
   as `@<path>` references in the wire text Claude receives.

   Pin lifecycle:
   - Plain click toggles pinned/unpinned. A new pin defaults to one-shot
     (non-sticky) so TabController drops it after submit (file content is
     already in the conversation history from the first turn).
   - Shift+click toggles the "sticky" flag on a pinned file (stays pinned
     across submits). On an unpinned file, shift+click pins it as sticky.
   - Tooltip and an `is-sticky` class make the two states visually
     distinct. */

export type FilePillCallbacks = {
  /* Fires whenever the pinned OR sticky set changes so callers can
     persist both. stickyPaths is always a subset of pinnedPaths. */
  onPinChange: (pinnedPaths: string[], stickyPaths: string[]) => void;
};

export class ActiveFileIndicator {
  private app: App;
  /* Public so the owner (TabController) can reparent the pill bar — currently
     mounted inside the input wrapper via InputBox.mountTopBar(). */
  readonly root: HTMLElement;
  private callbacks: FilePillCallbacks;
  private pinnedPaths: Set<string>;
  /* Subset of pinnedPaths flagged sticky (won't be auto-dropped after
     submit). Tracked separately so the click handler can mutate the two
     bits independently. */
  private stickyPaths: Set<string>;
  /* Paths currently mid-fade from "pinned" styling back to plain. Only
     populated when setPinnedPaths() drops a pin whose pill stays on
     screen (i.e., the dropped path is also the active editor file).
     Drives the .is-fading-pin class, which extends the default 100ms
     pill transition into a slow ease so the unpin reads as visible
     feedback instead of a snap. Cleared by a timer set during the same
     setPinnedPaths call. */
  private fadingPaths: Set<string> = new Set();
  /* Pending fade timers (one per fading path). Tracked so destroy() can
     cancel them; otherwise a timer scheduled within 850ms of teardown
     fires after the root is detached and runs renderPills() on a dead
     element. */
  private fadeTimers = new Map<string, number>();
  private currentActiveFile: TFile | null = null;
  private eventRef: EventRef | null = null;
  private deleteRef: EventRef | null = null;
  private renameRef: EventRef | null = null;
  /* Per-path pill element cache. Surgical class updates against these
     existing elements (instead of empty()+recreate) preserve click handlers
     across refreshes, so an in-flight click can't be lost to a concurrent
     active-leaf-change rebuilding the DOM. */
  private pillElements = new Map<string, HTMLElement>();

  constructor(
    parent: HTMLElement,
    app: App,
    initialPinned: string[],
    initialSticky: string[],
    callbacks: FilePillCallbacks
  ) {
    this.app = app;
    this.callbacks = callbacks;
    this.pinnedPaths = new Set(initialPinned);
    /* Defensive: sticky paths must be a subset of pinned paths. Filter to
       prevent a corrupt persisted state from claiming a sticky on an
       unpinned file. */
    this.stickyPaths = new Set(initialSticky.filter(p => this.pinnedPaths.has(p)));
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

    /* When a pinned file is deleted or renamed outside this view, the
       persisted path becomes a phantom: clicking the pill would resolve to a
       missing file, and the pill keeps rendering as if nothing happened.
       Drop the path on delete and rewrite it on rename so the pill bar always
       reflects vault truth. Persist via the same onPinChange callback the
       click handler uses so the controller's saved state stays in sync. */
    this.deleteRef = this.app.vault.on("delete", (file) => {
      if (!this.pinnedPaths.has(file.path)) return;
      this.pinnedPaths.delete(file.path);
      this.stickyPaths.delete(file.path);
      this.renderPills();
      this.emitChange();
    });
    this.renameRef = this.app.vault.on("rename", (file, oldPath) => {
      if (!this.pinnedPaths.has(oldPath)) return;
      this.pinnedPaths.delete(oldPath);
      this.pinnedPaths.add(file.path);
      /* Carry sticky flag across the rename so a sticky pin stays sticky. */
      if (this.stickyPaths.has(oldPath)) {
        this.stickyPaths.delete(oldPath);
        this.stickyPaths.add(file.path);
      }
      /* Drop the cached pill element keyed by the old path so renderPills
         creates a fresh one with the new label and click handler. */
      const stale = this.pillElements.get(oldPath);
      if (stale) {
        stale.remove();
        this.pillElements.delete(oldPath);
      }
      this.renderPills();
      this.emitChange();
    });
  }

  destroy() {
    if (this.eventRef) {
      this.app.workspace.offref(this.eventRef);
      this.eventRef = null;
    }
    if (this.deleteRef) {
      this.app.vault.offref(this.deleteRef);
      this.deleteRef = null;
    }
    if (this.renameRef) {
      this.app.vault.offref(this.renameRef);
      this.renameRef = null;
    }
    /* Cancel any in-flight pin-fade timers so their callbacks don't run
       renderPills() against the detached root after teardown. */
    for (const timer of this.fadeTimers.values()) window.clearTimeout(timer);
    this.fadeTimers.clear();
    this.fadingPaths.clear();
    this.root.remove();
  }

  /* Returns the list of paths currently pinned. Read at submit time by
     TabController to build the @-context prefix. */
  getPinnedPaths(): string[] {
    return [...this.pinnedPaths];
  }

  /* Returns the list of paths currently flagged sticky. Always a subset
     of getPinnedPaths(). Read by TabController after submit to decide
     which pins survive vs. get auto-dropped. */
  getStickyPaths(): string[] {
    return [...this.stickyPaths];
  }

  /* Add a single path to the pinned set (no-op if already pinned). Used by
     external triggers like the @-mention popup picking a folder, where we
     want to *append* rather than *replace* (setPinnedPaths replaces). Defaults
     the new pin to non-sticky like the click handler does. */
  addPinnedPath(path: string): void {
    if (this.pinnedPaths.has(path)) return;
    this.pinnedPaths.add(path);
    this.renderPills();
    this.emitChange();
  }

  /* Externally-driven pin clear, used by TabController after submit to
     drop all non-sticky pins. Pass the post-submit set of paths that
     should remain. Both pinned and sticky sets are reset; the new sticky
     set is whatever survived (kept entries that were sticky stay sticky;
     anything dropped is gone from both). Idempotent: re-render only fires
     when the set actually changed. */
  setPinnedPaths(nextPinned: string[]) {
    const nextSet = new Set(nextPinned);
    /* No-op when nothing changed (avoids spurious renders + callback). */
    if (nextSet.size === this.pinnedPaths.size && [...nextSet].every(p => this.pinnedPaths.has(p))) {
      return;
    }
    /* For each path that's being dropped: if it's the active editor
       file, the pill stays on the bar (active file always renders),
       just transitioning back to plain styling. Queue it for a slow
       fade so the unpin is a visible cue rather than a snap. Paths
       that aren't the active file get removed from the bar entirely
       by renderPills — no fade needed since the pill leaves the DOM. */
    const activePath = this.currentActiveFile?.path;
    for (const oldPath of this.pinnedPaths) {
      if (nextSet.has(oldPath)) continue;
      if (oldPath !== activePath) continue;
      this.fadingPaths.add(oldPath);
      /* 850ms = the 800ms CSS transition + a 50ms buffer to ensure the
         class removal happens after the property animation completes,
         so the pill doesn't get yanked back to fast-transition mode
         mid-fade if anything else re-renders it. */
      const timer = window.setTimeout(() => {
        this.fadeTimers.delete(oldPath);
        if (!this.fadingPaths.has(oldPath)) return;
        this.fadingPaths.delete(oldPath);
        this.renderPills();
      }, 850);
      this.fadeTimers.set(oldPath, timer);
    }
    this.pinnedPaths = nextSet;
    /* Intersect sticky with the new pinned set so we never carry a
       sticky flag on a path that's no longer pinned. */
    for (const p of [...this.stickyPaths]) {
      if (!this.pinnedPaths.has(p)) this.stickyPaths.delete(p);
    }
    this.renderPills();
    this.emitChange();
  }

  private emitChange() {
    this.callbacks.onPinChange([...this.pinnedPaths], [...this.stickyPaths]);
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
    const visible = new Map<string, { path: string; isActive: boolean; pinned: boolean; sticky: boolean; fading: boolean }>();
    if (this.currentActiveFile) {
      visible.set(this.currentActiveFile.path, {
        path: this.currentActiveFile.path,
        isActive: true,
        pinned: this.pinnedPaths.has(this.currentActiveFile.path),
        sticky: this.stickyPaths.has(this.currentActiveFile.path),
        fading: this.fadingPaths.has(this.currentActiveFile.path),
      });
    }
    for (const p of this.pinnedPaths) {
      if (visible.has(p)) continue;
      visible.set(p, { path: p, isActive: false, pinned: true, sticky: this.stickyPaths.has(p), fading: false });
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
    for (const { path, isActive, pinned, sticky, fading } of visible.values()) {
      let pill = this.pillElements.get(path);
      if (pill) {
        this.updatePillState(pill, path, isActive, pinned, sticky, fading);
      } else {
        pill = this.createPill(path, isActive, pinned, sticky, fading);
        this.pillElements.set(path, pill);
      }
      const expected: ChildNode | null = prevPill ? prevPill.nextSibling : this.root.firstChild;
      if (pill !== expected) {
        this.root.insertBefore(pill, expected);
      }
      prevPill = pill;
    }
  }

  private createPill(path: string, isActive: boolean, pinned: boolean, sticky: boolean, fading: boolean): HTMLElement {
    /* Obsidian augments HTMLElement.prototype with createSpan/createDiv etc.,
       so detached elements get the same DOM helpers as Obsidian-created ones. */
    const pill = document.createElement("div");
    this.updatePillState(pill, path, isActive, pinned, sticky, fading);
    const iconEl = pill.createSpan({ cls: "claudian-file-pill-icon" });
    /* Vault lookup distinguishes folder pins from file pins. Folders get the
       folder icon + a `.is-folder` class that styles them in Claude blue
       instead of the brand orange. Office binaries (.docx/.xlsx/.pptx) get
       their own `.is-office` color + a type-specific icon so they stand
       out from a plain .md pin — they go through a separate, lossier
       text-extraction path (see officeExtract.ts) that's worth flagging
       visually. */
    const node = this.app.vault.getAbstractFileByPath(path);
    if (node instanceof TFolder) {
      pill.addClass("is-folder");
      setIcon(iconEl, "folder");
    } else if (isExtractableOffice(path)) {
      pill.addClass("is-office");
      setIcon(iconEl, officeIconName(path));
    } else {
      const ext = path.split(".").pop() ?? "";
      setIcon(iconEl, ext === "canvas" ? "layout-grid" : "file-text");
    }
    const fileName = path.split("/").pop() ?? path;
    pill.createSpan({ cls: "claudian-file-pill-label", text: fileName });
    /* Sticky badge: a small pin glyph appended to the label so sticky pins
       are visually distinct from one-shot pins at a glance. The .is-sticky
       class on the root pill drives styling for the badge + a heavier
       border. Always created so updatePillState can toggle visibility via
       CSS rather than DOM thrash. */
    const stickyBadge = pill.createSpan({ cls: "claudian-file-pill-sticky-badge" });
    setIcon(stickyBadge, "pin");
    pill.addEventListener("click", (e) => this.handlePillClick(path, e));
    return pill;
  }

  private updatePillState(pill: HTMLElement, path: string, isActive: boolean, pinned: boolean, sticky: boolean, fading: boolean) {
    /* Vault check each refresh so a path that gets renamed file→folder (rare
       but possible) ends up with the correct styling without DOM thrash. */
    const isFolder = this.app.vault.getAbstractFileByPath(path) instanceof TFolder;
    pill.className = "claudian-file-pill"
      + (pinned ? " is-pinned" : "")
      + (sticky ? " is-sticky" : "")
      + (isActive ? " is-active-file" : "")
      + (fading ? " is-fading-pin" : "")
      + (isFolder ? " is-folder" : "")
      + (!isFolder && isExtractableOffice(path) ? " is-office" : "");
    /* Tooltip surfaces the next click's behavior since shift-click is a
       hidden interaction without a keyboard hint. Three states match the
       three branches in handlePillClick: unpinned, pinned-one-shot,
       pinned-sticky. */
    let title: string;
    if (!pinned) {
      title = `${path} · click to pin (one-shot) · shift+click to pin sticky`;
    } else if (sticky) {
      title = `${path} · pinned sticky (click to unpin · shift+click to make one-shot)`;
    } else {
      title = `${path} · pinned one-shot, drops after submit (click to unpin · shift+click to make sticky)`;
    }
    pill.setAttribute("title", title);
  }

  /* Click semantics:
     - plain click: toggle pinned (unpin always clears sticky too).
     - shift+click on unpinned: pin AND mark sticky.
     - shift+click on pinned: toggle sticky bit, leave pinned alone.
     This keeps "click = visibility, shift = persistence" as a clean
     mental model: the modifier never causes a hidden unpin. */
  private handlePillClick(path: string, e: MouseEvent) {
    const shift = e.shiftKey;
    if (!this.pinnedPaths.has(path)) {
      this.pinnedPaths.add(path);
      if (shift) this.stickyPaths.add(path);
    } else if (shift) {
      if (this.stickyPaths.has(path)) this.stickyPaths.delete(path);
      else this.stickyPaths.add(path);
    } else {
      this.pinnedPaths.delete(path);
      this.stickyPaths.delete(path);
    }
    this.renderPills();
    this.emitChange();
  }
}
