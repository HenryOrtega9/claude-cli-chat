import { Menu, setIcon } from "obsidian";

export type TabBarCallbacks = {
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
};

export type TabBadgeState = {
  id: string;
  busy: boolean;
  hasPendingApproval: boolean;
};

export class TabBar {
  private container: HTMLElement;
  private callbacks: TabBarCallbacks;
  private root: HTMLElement;
  private badgesEl: HTMLElement;
  private newBtn: HTMLElement;

  constructor(container: HTMLElement, callbacks: TabBarCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.root = this.container.createDiv({ cls: "claudian-tab-bar-container" });
    this.badgesEl = this.root.createDiv({ cls: "claudian-tab-badges" });
    this.newBtn = this.root.createSpan({
      cls: "claudian-tab-badge claudian-tab-badge-new",
      attr: { "aria-label": "New tab", title: "New tab" },
    });
    setIcon(this.newBtn, "plus");
    this.newBtn.addEventListener("click", () => this.callbacks.onNew());
  }

  render(tabs: TabBadgeState[], activeTabId: string | null) {
    this.badgesEl.empty();
    tabs.forEach((tab, idx) => {
      const badge = this.badgesEl.createSpan({
        cls: this.badgeClass(tab, tab.id === activeTabId),
        text: String(idx + 1),
        attr: { "data-tab-id": tab.id, title: `Tab ${idx + 1}` },
      });
      badge.addEventListener("click", () => this.callbacks.onSelect(tab.id));
      badge.addEventListener("auxclick", e => {
        const mouse = e as MouseEvent;
        if (mouse.button === 1) {
          mouse.preventDefault();
          this.callbacks.onClose(tab.id);
        }
      });
      badge.addEventListener("contextmenu", e => {
        e.preventDefault();
        /* Right-click used to close silently — easy to fire by accident on
           a trackpad two-finger tap, losing the user's tab without a confirm
           step. Now opens a tiny one-item menu; middle-click still closes
           instantly via the auxclick handler above for users who want the
           old behavior. */
        const menu = new Menu();
        menu.addItem(item =>
          item.setTitle("Close tab")
            .setIcon("x")
            .onClick(() => this.callbacks.onClose(tab.id))
        );
        menu.showAtMouseEvent(e);
      });
    });
  }

  private badgeClass(tab: TabBadgeState, active: boolean): string {
    const parts = ["claudian-tab-badge"];
    if (active) parts.push("claudian-tab-badge-active");
    if (tab.busy) parts.push("claudian-tab-badge-streaming");
    if (tab.hasPendingApproval) parts.push("claudian-tab-badge-attention");
    return parts.join(" ");
  }
}
