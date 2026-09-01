import { FileSystemAdapter, ItemView, WorkspaceLeaf } from "obsidian";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type ClaudeChatPlugin from "../main";
import { renderHeader } from "./Header";
import { TabBar, type TabBadgeState } from "./TabBar";
import { TabController } from "./TabController";
import { StateEmitter } from "../claude/StateEmitter";
import { HistoryModal } from "./HistoryModal";
import { SnippetPicker } from "./SnippetPicker";
import { MCPManagerModal } from "./MCPManagerModal";
import { Notice } from "obsidian";
import { makeTabState, type TabState } from "./state";

export const VIEW_TYPE_CLAUDE_CHAT = "claude-cli-chat-view";

/* Vault-relative path for the multi-window lock file. Each view writes a
   unique instance token (`<pid>:<uuid>`) here on open and removes it on close.
   A second window opening sees the lock, verifies the holder PID is still
   alive, and renders a "already open" notice instead of restoring tabs
   (otherwise both windows would race on the same persisted tab files and each
   other's subprocesses). The token (rather than a bare PID) lets us tell two
   leaves in the SAME renderer process apart, so one leaf's onClose can't
   delete a lock another leaf legitimately holds. */
const WINDOW_LOCK_DIR = ".claude-cli-chat";
const WINDOW_LOCK_PATH = `${WINDOW_LOCK_DIR}/window.lock`;

/* Process-local guard. Obsidian can hold two leaves of this custom view in one
   renderer process (split pane, or a restored workspace layout that contained
   two Claude leaves). Both run onOpen in the same process, so the on-disk
   lock's PID would match itself and provide no protection. Only the first
   ClaudeChatView instance in a process restores tabs and holds the lock; the
   rest render the placeholder. */
let activeChatViewInstance: ClaudeChatView | null = null;

/* 128-bit random id via crypto.randomUUID where available (Obsidian's runtime
   ships with it), falling back to Math.random so the plugin still starts if the
   API is missing. Mirrors state.ts's makeId, kept local to avoid widening that
   module's export surface for a single internal caller. */
function makeInstanceId(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export class ClaudeChatView extends ItemView {
  plugin: ClaudeChatPlugin;
  private tabs: TabController[] = [];
  private activeTabId: string | null = null;
  private tabBar!: TabBar;
  private tabsContainer!: HTMLElement;
  /* True when this view detected another live window already holding the
     vault lock. We render a placeholder and skip tab restore in that case. */
  private holdingLock = false;
  /* Unique per-view lock payload: `<pid>:<uuid>`. Written into the lock file
     so we can distinguish this exact view from any other holder — including a
     second leaf in the same renderer process, where the PID alone collides. */
  private readonly instanceToken = `${process.pid}:${makeInstanceId()}`;

  constructor(leaf: WorkspaceLeaf, plugin: ClaudeChatPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return VIEW_TYPE_CLAUDE_CHAT; }
  getDisplayText(): string { return "Claude"; }
  getIcon(): string { return "claude-asterisk"; }

  async onOpen() {
    const root = this.containerEl.children[1];
    root.empty();
    root.addClass("claudian-container");
    root.setAttribute("data-provider", "claude");

    /* Guard against a SECOND leaf of this view in OUR process (split pane,
       or a restored layout with two Claude leaves) BEFORE touching disk.
       This check-then-set has no await between them, so it can't race
       against another same-process leaf's onOpen. */
    if (activeChatViewInstance && activeChatViewInstance !== this) {
      this.renderAlreadyOpenPlaceholder(root as HTMLElement, process.pid);
      return;
    }
    activeChatViewInstance = this;

    /* Atomically claim the on-disk multi-window lock BEFORE setting up any
       UI. If another live window (a different OS process) holds it, we
       short-circuit with a placeholder. */
    const lockHolder = await this.acquireWindowLock();
    if (lockHolder !== null) {
      /* Lost the race to a foreign process. Undo the singleton claim above
         so it doesn't wrongly block a later leaf in this same process. */
      if (activeChatViewInstance === this) activeChatViewInstance = null;
      this.renderAlreadyOpenPlaceholder(root as HTMLElement, lockHolder);
      return;
    }

    renderHeader(root as HTMLElement, {
      onNewTab: () => this.createTab(),
      onClear: () => this.clearActiveTab(),
      onHistory: () => this.showHistory(),
      onSnippets: () => this.showSnippetPicker(),
      onMcp: () => this.showMcpManager(),
      onToggleRemoteControl: () => this.toggleRemoteControl(),
    });

    const navRow = (root as HTMLElement).createDiv({ cls: "claudian-input-nav-row" });
    this.tabBar = new TabBar(navRow, {
      onSelect: (id) => this.selectTab(id),
      onClose: (id) => void this.closeTab(id),
      onNew: () => this.createTab(),
    });

    this.tabsContainer = (root as HTMLElement).createDiv({ cls: "claudian-tab-content-container" });

    await this.restoreTabs();
  }

  /* Absolute filesystem path of the vault root, or null when the adapter
     isn't filesystem-backed (mirrors main.ts's own getVaultPath guard). */
  private getVaultBasePath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }

  /* Atomically claims the on-disk multi-window lock. Returns the PID of a
     live foreign holder (blocked) or null (claimed — this.holdingLock is
     now true).

     Uses an exclusive create (node fs 'wx' flag) directly on the vault's
     real filesystem path instead of the adapter's separate exists/read/write
     used previously — 'wx' either creates the file or fails atomically, so
     two windows opening together can no longer both observe the lock as
     absent and both proceed (the exact TOCTOU this lock exists to prevent).
     Falls back to the old adapter-based check+write when the vault isn't
     filesystem-backed; that path has no atomicity guarantee but is not
     expected to be reachable on this macOS-only plugin's supported host. */
  private async acquireWindowLock(): Promise<number | null> {
    const basePath = this.getVaultBasePath();
    if (basePath === null) return this.acquireWindowLockViaAdapter();

    const lockDir = join(basePath, WINDOW_LOCK_DIR);
    const lockPath = join(basePath, WINDOW_LOCK_PATH);
    try {
      await fs.mkdir(lockDir, { recursive: true });
    } catch (err) {
      console.warn(`[claude-cli-chat] failed to create window lock dir:`, err);
      return null;
    }

    /* One exclusive-create attempt, plus one retry each time we find and
       clear a stale lock left by a crashed instance. A live foreign holder
       returns immediately without looping. */
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const handle = await fs.open(lockPath, "wx");
        try {
          await handle.writeFile(this.instanceToken);
        } finally {
          await handle.close();
        }
        this.holdingLock = true;
        return null;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") {
          console.warn(`[claude-cli-chat] failed to acquire window lock:`, err);
          return null;
        }
      }
      /* Lost the exclusive create — someone else's lock is already on disk.
         Inspect it exactly like the old checkWindowLock did: our own token
         means this same view is reopening, a live PID is a real foreign
         holder, anything else is stale and safe to clear and retry. */
      let raw = "";
      try {
        raw = (await fs.readFile(lockPath, "utf8")).trim();
      } catch {
        continue; // holder unlinked it between our failed open and this read
      }
      if (raw === this.instanceToken) return null;
      const pid = parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0) {
        if (pid === process.pid) {
          /* Same PID but a different token: a second leaf in our own
             process holds it. The singleton gate already blocks that path,
             but treat it as held here too in case the gate is bypassed. */
          return pid;
        }
        try {
          /* signal 0 doesn't deliver a signal; it tests whether the target
             is still alive and accessible. Throws ESRCH if it's gone. */
          process.kill(pid, 0);
          return pid; // live foreign holder
        } catch {
          /* Stale lock from a crashed prior instance — fall through to
             clear it and retry the exclusive create below. */
        }
      }
      try {
        await fs.unlink(lockPath);
      } catch {
        /* Someone else cleared it first — fine, retry the create. */
      }
    }
    /* Exhausted retries without ever finding a live foreign holder (each
       attempt hit a stale/vanishing lock, not a real contender). Don't spin
       forever — fall back to a best-effort non-exclusive write, matching
       the old code's failure mode for the pathological case. */
    try {
      await fs.writeFile(lockPath, this.instanceToken);
      this.holdingLock = true;
    } catch (err) {
      console.warn(`[claude-cli-chat] failed to acquire window lock after retries:`, err);
    }
    return null;
  }

  /* Fallback used only when the vault isn't filesystem-backed (see
     acquireWindowLock). Same check-then-write shape as the pre-fix code:
     not atomic, but there's no exclusive-create primitive on the adapter to
     do better with. */
  private async acquireWindowLockViaAdapter(): Promise<number | null> {
    const adapter = this.app.vault.adapter;
    try {
      if (await adapter.exists(WINDOW_LOCK_PATH)) {
        const raw = (await adapter.read(WINDOW_LOCK_PATH)).trim();
        if (raw !== this.instanceToken) {
          const pid = parseInt(raw, 10);
          if (Number.isFinite(pid) && pid > 0) {
            if (pid === process.pid) return pid;
            try {
              process.kill(pid, 0);
              return pid;
            } catch {
              /* Stale lock from a crashed prior instance. Safe to overwrite. */
            }
          }
        }
      }
      if (!(await adapter.exists(WINDOW_LOCK_DIR))) {
        await adapter.mkdir(WINDOW_LOCK_DIR);
      }
      await adapter.write(WINDOW_LOCK_PATH, this.instanceToken);
      this.holdingLock = true;
      return null;
    } catch (err) {
      console.warn(`[claude-cli-chat] failed to acquire window lock:`, err);
      return null;
    }
  }

  private async releaseWindowLock(): Promise<void> {
    if (!this.holdingLock) return;
    this.holdingLock = false;
    const adapter = this.app.vault.adapter;
    try {
      if (await adapter.exists(WINDOW_LOCK_PATH)) {
        const raw = (await adapter.read(WINDOW_LOCK_PATH)).trim();
        /* Only remove the lock if the stored token is EXACTLY ours —
           otherwise we'd be clobbering a lock another holder legitimately
           took after we dropped ours (a window in another process, or a
           second leaf in this process). A bare PID check would match a
           same-process sibling's lock and delete it. */
        if (raw === this.instanceToken) {
          await adapter.remove(WINDOW_LOCK_PATH);
        }
      }
    } catch (err) {
      console.warn(`[claude-cli-chat] failed to release window lock:`, err);
    }
  }

  private renderAlreadyOpenPlaceholder(root: HTMLElement, holderPid: number): void {
    const wrap = root.createDiv({ cls: "claudian-multi-window-block" });
    wrap.style.padding = "2em";
    wrap.style.textAlign = "center";
    wrap.createEl("h3", { text: "Claude is already open in another window" });
    wrap.createEl("p", {
      text: `Another Obsidian window (pid ${holderPid}) is currently running this plugin. ` +
            "Open the existing window to continue your conversations. Running two windows " +
            "at once would race on the same persisted tabs and subprocesses.",
    });
  }

  private async restoreTabs() {
    const index = await this.plugin.persistence.loadIndex();
    if (!index || index.tabs.length === 0) {
      this.createTab();
      return;
    }
    /* Bypass per-tab saveIndex writes during the restore loop — each
       createTab + selectTab pair would otherwise trigger TWO index writes
       per restored tab. We do one write at the very end instead. */
    for (const entry of index.tabs) {
      const state = await this.plugin.persistence.loadTab(entry.id);
      this.createTab(state ?? undefined, { skipSave: true });
    }
    if (index.activeTabId && this.tabs.some(t => t.state.id === index.activeTabId)) {
      this.selectTab(index.activeTabId, { skipSave: true });
    }
    this.saveIndex();
  }

  private saveIndex() {
    /* Don't let an incognito tab's id leak into the index as activeTabId —
       it isn't in the persisted tabs list, so persist it as null rather than
       a dangling reference. */
    const activeTab = this.tabs.find(t => t.state.id === this.activeTabId);
    const activeTabId = activeTab && !activeTab.state.incognito ? this.activeTabId : null;
    const index = {
      activeTabId,
      /* Incognito tabs are excluded from the index so they never get written
         to tabs.json and thus never restore on reload. */
      tabs: this.tabs
        .filter(t => !t.state.incognito)
        .map(t => ({
          id: t.state.id,
          title: t.state.title,
          sessionId: t.state.sessionId,
        })),
    };
    /* Dedupe against per-streaming-delta calls happens inside
       persistence.saveIndex (content compare on the serialized payload).
       A second view-level cache here used to shadow it, but it never
       reverted on write failure — a transient EACCES/disk-full/iCloud
       hiccup poisoned it with the failed payload, and every retry with
       identical content short-circuited before reaching persistence. The
       persistence-level cache handles failure correctly (reverts to null),
       so it is the only one. */
    return this.plugin.persistence.saveIndex(index).catch(err => {
      console.warn(`[claude-cli-chat] index write failed`, err);
    });
  }

  async onClose() {
    /* Await every tab's destroy() so any in-flight SIGTERM → process-exit
       handshake completes before Obsidian moves on. Without the await, the
       plugin can unload while `claude --remote-control` children are still
       in the middle of shutting down, leaking them as PPID=1 orphans. */
    await Promise.all(this.tabs.map(t => t.destroy()));
    this.tabs = [];
    /* Surrender the process-local slot first, but only if WE own it. A
       placeholder leaf (blocked by the singleton at onOpen) never owned it, so
       this guard stops its close from nulling out the live owner's slot and
       letting another same-process leaf restore. */
    if (activeChatViewInstance === this) activeChatViewInstance = null;
    /* Release the multi-window lock so another window opened later (or the
       same window reopened) can start cleanly. releaseWindowLock is a no-op
       for placeholder leaves (holdingLock stays false). */
    await this.releaseWindowLock();
  }

  newTab() {
    this.createTab();
  }

  private createTab(state?: TabState, opts: { skipSave?: boolean; incognito?: boolean } = {}) {
    const controller = new TabController(
      this.plugin,
      this.tabsContainer,
      this,
      state ?? makeTabState({ incognito: opts.incognito }),
      () => {
        /* Late async continuations (title-gen, renderer chains) can fire this
           after closeTab destroyed the controller and deleted its files —
           writing here would resurrect them. */
        if (controller.isDestroyed()) return;
        this.renderTabBar();
        /* Incognito tabs never touch the vault. saveIndex() self-filters them,
           so it stays safe to call unconditionally. */
        if (!controller.state.incognito) {
          this.plugin.persistence.scheduleSaveTab(controller.state);
        }
        this.saveIndex();
      }
    );
    controller.onForkRequest = (src, messageId) => this.forkFromMessage(src, messageId);
    controller.onIncognitoToggle = (tabId, incognito) => this.onIncognitoToggle(tabId, incognito);
    this.tabs.push(controller);
    this.selectTab(controller.state.id, { skipSave: true });
    if (!opts.skipSave) {
      this.saveIndex();
      /* Tabs created with pre-populated history (fork, History-modal reopen)
         carry messages that no streaming event will reproduce. saveIndex only
         writes the index entry; without an explicit body write the conversation
         file isn't created until the user interacts. A reload before that drops
         the carried history (loadTab returns null, so restore replaces the
         entry with a blank tab). Persist the body now. Empty new tabs and
         incognito tabs are skipped; flush() on unload covers the debounce. */
      if (!controller.state.incognito && controller.state.messages.length > 0) {
        this.plugin.persistence.scheduleSaveTab(controller.state);
      }
      /* User-initiated new tab (or fork). Reset the TC001 to "ready" so a
         lingering "thinking" / "needs_permission" from another tab doesn't
         carry over. skipSave is set during plugin-load tab restore, where we
         want to leave the device on whatever StateEmitter already emitted. */
      StateEmitter.setState("ready");
    }
  }

  /* Create a new tab whose state is the source tab's history truncated at
     and including `messageId`. The fork gets a fresh tab id and *no*
     sessionId — when the user sends a new message, the CLI spawns a brand
     new session, so the fork is independent of the source from then on. */
  private forkFromMessage(source: TabController, messageId: string) {
    const idx = source.state.messages.findIndex(m => m.id === messageId);
    if (idx === -1) {
      new Notice("Couldn't find message to fork from.");
      return;
    }
    /* Deep-clone the carried history: slice() alone aliases the live message
       and toolCall objects, so a source turn still streaming would keep
       mutating the fork's state (and what it persists) after the branch.
       Clear streaming flags and settle any still-running tools — no stream
       feeds the fork, so those would otherwise shimmer/spin forever. */
    const truncated = structuredClone(source.state.messages.slice(0, idx + 1));
    for (const m of truncated) {
      delete m.streaming;
      delete m.thinkingStreaming;
      for (const t of m.toolCalls ?? []) {
        if (t.status === "pending" || t.status === "approved" || t.status === "running") {
          t.status = "completed";
        }
      }
    }
    const forkState: TabState = {
      ...makeTabState(),
      title: `Fork: ${source.state.title}`,
      messages: truncated,
      /* Carry over the model/effort/mode/snippet so the fork starts in the
         same context as where it branched. Incognito MUST carry too — a
         plain fork of an incognito tab would persist the whole private
         conversation to disk and respawn without --no-session-persistence. */
      incognito: source.state.incognito,
      model: source.state.model,
      effort: source.state.effort,
      permissionMode: source.state.permissionMode,
      envSnippetId: source.state.envSnippetId,
      voiceEnabled: source.state.voiceEnabled,
    };
    this.createTab(forkState);
    /* Be explicit about the semantics: the UI carries history but the new
       tab spawns a fresh Claude session (no --resume), so the model itself
       has no memory of the prior conversation. The displayed messages are a
       reference, not Claude's working context. */
    new Notice(
      `Forked into new tab. ${truncated.length} messages carried for reference — the new session starts fresh.`,
      6000
    );
  }

  private selectTab(tabId: string, opts: { skipSave?: boolean } = {}) {
    this.activeTabId = tabId;
    for (const tab of this.tabs) {
      if (tab.state.id === tabId) tab.show();
      else tab.hide();
    }
    const active = this.tabs.find(t => t.state.id === tabId);
    if (active) active.focusInput();
    this.renderTabBar();
    if (!opts.skipSave) this.saveIndex();
  }

  private async closeTab(tabId: string): Promise<void> {
    const idx = this.tabs.findIndex(t => t.state.id === tabId);
    if (idx === -1) return;
    const [removed] = this.tabs.splice(idx, 1);
    /* Snapshot busy state before destroy(): a tab closed mid-stream left
       StateEmitter asserting "thinking" (it never reached the result event
       that resets to "ready"), orphaning the TC001 heartbeat. */
    const wasBusy = removed.isBusy();
    /* Await destroy() before splicing out — otherwise the subprocess SIGTERM
       handshake races against onClose-like cleanup and we can leak children
       as PPID=1 orphans (same failure mode that onClose's await pattern
       fixed for the bulk path). */
    await removed.destroy();
    /* Incognito tabs have nothing on disk — skip the delete entirely.
       Order matters for the rest: drop the index entry FIRST, then remove
       the files, and await both. A crash between the two leaves an orphaned
       conversation file (harmless — listConversations tolerates it) instead
       of a dangling index entry that restores as a phantom blank tab. The
       tab is already spliced out above, so saveIndex writes the index
       without it. */
    if (!removed.state.incognito) {
      await this.saveIndex();
      await this.plugin.persistence.deleteTab(tabId);
    }
    /* Clear the orphaned "thinking" heartbeat back to "ready" — but only when
       no surviving tab is itself busy, so closing one streaming tab doesn't
       blank the device while another is still working. */
    if (wasBusy && !this.tabs.some(t => t.isBusy())) {
      StateEmitter.setState("ready");
    }
    if (this.tabs.length === 0) {
      this.createTab();
    } else if (this.activeTabId === tabId) {
      /* `idx` was captured before the await above; another close finishing
         during destroy() can shrink the array, so clamp before indexing —
         a raw tabs[idx-1] here could dereference undefined and strand the
         pane with no active tab. */
      const fallback = this.tabs[Math.min(Math.max(0, idx - 1), this.tabs.length - 1)];
      if (fallback) this.selectTab(fallback.state.id);
    } else {
      this.renderTabBar();
    }
    this.saveIndex();
  }

  private renderTabBar() {
    const badges: TabBadgeState[] = this.tabs.map(t => ({
      id: t.state.id,
      busy: t.isBusy(),
      hasPendingApproval: t.hasPendingApprovals(),
      isIncognito: !!t.state.incognito,
    }));
    this.tabBar.render(badges, this.activeTabId);
  }

  /* Reconcile disk when a still-empty tab toggles incognito. Turning ON deletes
     any file written while it was a normal empty tab (createTab wrote an index
     entry; a debounced body write may also be in flight). Turning OFF resumes
     normal persistence. saveIndex() re-derives the filtered index either way. */
  private async onIncognitoToggle(tabId: string, incognito: boolean) {
    const tab = this.tabs.find(t => t.state.id === tabId);
    this.renderTabBar();
    if (incognito) {
      /* Same ordering as closeTab: rewrite the index (which now filters
         this tab out) BEFORE removing its files, so a crash between the
         two can't leave a dangling index entry. */
      await this.saveIndex();
      await this.plugin.persistence.deleteTab(tabId);
    } else {
      if (tab) this.plugin.persistence.scheduleSaveTab(tab.state);
      await this.saveIndex();
    }
  }

  private clearActiveTab() {
    const active = this.tabs.find(t => t.state.id === this.activeTabId);
    if (active) void active.clear();
  }

  private showMcpManager() {
    new MCPManagerModal(this.app, this.plugin, () => {
      /* When the modal closes, the active tab's cost-surface pill may be
         stale (servers toggled on/off). Trigger a refresh so the count
         reflects the current per-vault enabled set without a tab restart. */
      const active = this.tabs.find(t => t.state.id === this.activeTabId);
      if (active) void active.refreshCostSurface();
    }).open();
  }

  private showSnippetPicker() {
    const active = this.tabs.find(t => t.state.id === this.activeTabId);
    if (!active) return;
    const snippets = this.plugin.settings.envSnippets;
    if (snippets.length === 0) {
      new Notice("No environment snippets yet. Add one in plugin settings.");
      return;
    }
    new SnippetPicker(this.app, snippets, active.getAppliedSnippetId(), choice => {
      if (choice === "__clear__") {
        active.clearSnippet();
        new Notice("Cleared environment snippet from this tab.");
      } else {
        active.applySnippet(choice);
        new Notice(`Applied snippet: ${choice.name}`);
      }
    }).open();
  }

  private showHistory() {
    new HistoryModal(this.app, this.plugin.persistence, async (conversationId) => {
      const existing = this.tabs.find(t => t.state.id === conversationId);
      if (existing) {
        this.selectTab(existing.state.id);
        return;
      }
      const state = await this.plugin.persistence.loadTab(conversationId);
      if (state) this.createTab(state);
    }).open();
  }

  private toggleRemoteControl() {
    const active = this.tabs.find(t => t.state.id === this.activeTabId);
    if (!active) return;
    const next = active.mode === "local" ? "remote" : "local";
    void active.switchMode(next);
  }

  /* Public command targets — used by plugin.addCommand registrations. */
  closeActiveTab() {
    if (this.activeTabId) void this.closeTab(this.activeTabId);
  }
  nextTab() {
    if (this.tabs.length < 2) return;
    const idx = this.tabs.findIndex(t => t.state.id === this.activeTabId);
    const next = this.tabs[(idx + 1) % this.tabs.length];
    this.selectTab(next.state.id);
  }
  prevTab() {
    if (this.tabs.length < 2) return;
    const idx = this.tabs.findIndex(t => t.state.id === this.activeTabId);
    const prev = this.tabs[(idx - 1 + this.tabs.length) % this.tabs.length];
    this.selectTab(prev.state.id);
  }
}
