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

export class ClaudeChatView extends ItemView {
  plugin: ClaudeChatPlugin;
  private tabs: TabController[] = [];
  private activeTabId: string | null = null;
  private tabBar!: TabBar;
  private tabsContainer!: HTMLElement;

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
      onClose: (id) => this.closeTab(id),
      onNew: () => this.createTab(),
    });

    this.tabsContainer = (root as HTMLElement).createDiv({ cls: "claudian-tab-content-container" });

    await this.restoreTabs();
  }

  private async restoreTabs() {
    const index = await this.plugin.persistence.loadIndex();
    if (!index || index.tabs.length === 0) {
      this.createTab();
      return;
    }
    for (const entry of index.tabs) {
      const state = await this.plugin.persistence.loadTab(entry.id);
      this.createTab(state ?? undefined);
    }
    if (index.activeTabId && this.tabs.some(t => t.state.id === index.activeTabId)) {
      this.selectTab(index.activeTabId);
    }
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
  }

  newTab() {
    this.createTab();
  }

  private createTab(state?: TabState) {
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
    this.selectTab(controller.state.id);
    this.saveIndex();
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

  private selectTab(tabId: string) {
    this.activeTabId = tabId;
    for (const tab of this.tabs) {
      if (tab.state.id === tabId) tab.show();
      else tab.hide();
    }
    const active = this.tabs.find(t => t.state.id === tabId);
    if (active) active.focusInput();
    this.renderTabBar();
    this.saveIndex();
  }

  private closeTab(tabId: string) {
    const idx = this.tabs.findIndex(t => t.state.id === tabId);
    if (idx === -1) return;
    const [removed] = this.tabs.splice(idx, 1);
    removed.destroy();
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
    if (active) active.clear();
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
    if (this.activeTabId) this.closeTab(this.activeTabId);
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
