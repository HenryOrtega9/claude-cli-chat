import { ItemView, WorkspaceLeaf } from "obsidian";
import type ClaudeChatPlugin from "../main";
import { renderHeader } from "./Header";
import { TabBar, type TabBadgeState } from "./TabBar";
import { TabController } from "./TabController";
import { HistoryModal } from "./HistoryModal";
import { SnippetPicker } from "./SnippetPicker";
import { MCPManagerModal } from "./MCPManagerModal";
import { Notice } from "obsidian";
import { makeTabState, type TabState } from "./state";

export const VIEW_TYPE_CLAUDE_CHAT = "claude-cli-chat-view";

/* Vault-relative path for the multi-window lock file. Each window writes its
   PID here on open and removes it on close. A second window opening sees the
   lock, verifies the PID is still alive, and renders a "already open" notice
   instead of restoring tabs (otherwise both windows would race on the same
   persisted tab files and each other's subprocesses). */
const WINDOW_LOCK_DIR = ".claude-cli-chat";
const WINDOW_LOCK_PATH = `${WINDOW_LOCK_DIR}/window.lock`;

export class ClaudeChatView extends ItemView {
  plugin: ClaudeChatPlugin;
  private tabs: TabController[] = [];
  private activeTabId: string | null = null;
  private tabBar!: TabBar;
  private tabsContainer!: HTMLElement;
  /* True when this view detected another live window already holding the
     vault lock. We render a placeholder and skip tab restore in that case. */
  private holdingLock = false;

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

    /* Check the multi-window lock BEFORE setting up any UI. If another live
       window holds it, we short-circuit with a placeholder. */
    const lockHolder = await this.checkWindowLock();
    if (lockHolder !== null) {
      this.renderAlreadyOpenPlaceholder(root as HTMLElement, lockHolder);
      return;
    }
    await this.acquireWindowLock();

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

  /* Returns the PID of the live window currently holding the lock, or null
     if no live holder exists (lock missing, stale, or unreadable). */
  private async checkWindowLock(): Promise<number | null> {
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(WINDOW_LOCK_PATH))) return null;
      const raw = (await adapter.read(WINDOW_LOCK_PATH)).trim();
      const pid = parseInt(raw, 10);
      if (!Number.isFinite(pid) || pid <= 0) return null;
      /* PID equality with our own process means we're reopening the view in
         the same window (tab close/reopen) — treat as no foreign holder. */
      if (pid === process.pid) return null;
      try {
        /* signal 0 doesn't deliver a signal; it tests whether the target is
           still alive and accessible. Throws ESRCH if the process is gone. */
        process.kill(pid, 0);
        return pid;
      } catch {
        /* Stale lock from a crashed prior instance. Safe to overwrite. */
        return null;
      }
    } catch {
      return null;
    }
  }

  private async acquireWindowLock(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(WINDOW_LOCK_DIR))) {
        await adapter.mkdir(WINDOW_LOCK_DIR);
      }
      await adapter.write(WINDOW_LOCK_PATH, String(process.pid));
      this.holdingLock = true;
    } catch (err) {
      console.warn(`[claude-cli-chat] failed to acquire window lock:`, err);
    }
  }

  private async releaseWindowLock(): Promise<void> {
    if (!this.holdingLock) return;
    this.holdingLock = false;
    const adapter = this.app.vault.adapter;
    try {
      if (await adapter.exists(WINDOW_LOCK_PATH)) {
        const raw = (await adapter.read(WINDOW_LOCK_PATH)).trim();
        const pid = parseInt(raw, 10);
        /* Only remove the lock if it's still ours — otherwise we'd be
           clobbering a lock another window legitimately took after we
           dropped ours (e.g. during onClose of this view). */
        if (pid === process.pid) {
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
    void this.plugin.persistence.saveIndex({
      activeTabId: this.activeTabId,
      tabs: this.tabs.map(t => ({
        id: t.state.id,
        title: t.state.title,
        sessionId: t.state.sessionId,
      })),
    });
  }

  async onClose() {
    /* Await every tab's destroy() so any in-flight SIGTERM → process-exit
       handshake completes before Obsidian moves on. Without the await, the
       plugin can unload while `claude --remote-control` children are still
       in the middle of shutting down, leaking them as PPID=1 orphans. */
    await Promise.all(this.tabs.map(t => t.destroy()));
    this.tabs = [];
    /* Release the multi-window lock so another window opened later (or the
       same window reopened) can start cleanly. */
    await this.releaseWindowLock();
  }

  newTab() {
    this.createTab();
  }

  private createTab(state?: TabState, opts: { skipSave?: boolean } = {}) {
    const controller = new TabController(
      this.plugin,
      this.tabsContainer,
      this,
      state ?? makeTabState(),
      () => {
        this.renderTabBar();
        this.plugin.persistence.scheduleSaveTab(controller.state);
        this.saveIndex();
      }
    );
    controller.onForkRequest = (src, messageId) => this.forkFromMessage(src, messageId);
    this.tabs.push(controller);
    this.selectTab(controller.state.id, { skipSave: true });
    if (!opts.skipSave) this.saveIndex();
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
    const truncated = source.state.messages.slice(0, idx + 1);
    const forkState: TabState = {
      ...makeTabState(),
      title: `Fork: ${source.state.title}`,
      messages: truncated,
      /* Carry over the model/effort/mode/snippet so the fork starts in the
         same context as where it branched. */
      model: source.state.model,
      effort: source.state.effort,
      permissionMode: source.state.permissionMode,
      envSnippetId: source.state.envSnippetId,
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
    /* Await destroy() before splicing out — otherwise the subprocess SIGTERM
       handshake races against onClose-like cleanup and we can leak children
       as PPID=1 orphans (same failure mode that onClose's await pattern
       fixed for the bulk path). */
    await removed.destroy();
    void this.plugin.persistence.deleteTab(tabId);
    if (this.tabs.length === 0) {
      this.createTab();
    } else if (this.activeTabId === tabId) {
      this.selectTab(this.tabs[Math.max(0, idx - 1)].state.id);
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
    }));
    this.tabBar.render(badges, this.activeTabId);
  }

  private clearActiveTab() {
    const active = this.tabs.find(t => t.state.id === this.activeTabId);
    if (active) void active.clear();
  }

  private showMcpManager() {
    new MCPManagerModal(this.app, this.plugin.settings.claudePath).open();
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
