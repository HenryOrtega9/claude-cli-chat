import { platform } from "../platform";

export type TabBarCallbacks = {
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
};

export type TabBadgeState = {
  id: string;
  busy: boolean;
  hasPendingApproval: boolean;
  isIncognito?: boolean;
};

/* Both desktop close gestures — middle-click and right-click — are mouse-only,
   so on the phone a tab could be created but never removed. Two touch-only
   affordances stand in, gated on the host actually being a touch one so the
   Obsidian and Electron builds keep exactly the DOM and behavior they had:

     - press-and-hold on ANY badge opens the same one-item "Close tab" menu
       the right-click path opens, which doubles as the deliberate-gesture
       confirmation (there is no separate confirm dialog, matching desktop);
     - the ACTIVE badge additionally carries a visible x, so closing the tab
       you are looking at is one tap and needs no discovery.

   Hold duration matches iOS's own long-press (~0.5 s) and cancels on any
   real movement, so a flick that scrolls the tab strip never arms it. */
const HOLD_MS = 500;
const HOLD_SLOP_PX = 10;

function isTouchHost(): boolean {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/* The shared context menu dismisses on a capture-phase document `mousedown`.
   WebKit only synthesizes mouse events for taps it decides are clickable, so a
   tap on plain page chrome can leave the menu stranded with no way out — and a
   menu opened by a hold has to be cancellable by tapping away or it is a trap.
   Replaying the first outside tap as a `mousedown` runs the overlay's own
   dismiss path rather than reaching into its private state. Touch only, and
   self-removing once no menu is on screen. */
function armTouchMenuDismiss(): void {
  const onPointerDown = (e: PointerEvent) => {
    const target = e.target;
    if (!document.querySelector(".claudesk-menu")) {
      document.removeEventListener("pointerdown", onPointerDown, true);
      return;
    }
    if (target instanceof Element && target.closest(".claudesk-menu")) return;
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      clientX: e.clientX,
      clientY: e.clientY,
    }));
  };
  document.addEventListener("pointerdown", onPointerDown, true);
}

export class TabBar {
  private container: HTMLElement;
  private callbacks: TabBarCallbacks;
  private root: HTMLElement;
  private badgesEl: HTMLElement;
  private newBtn: HTMLElement;
  private readonly touch: boolean;
  /* Live badge elements, and the tab-id list they were built from. See
     render(). */
  private badgeEls = new Map<string, HTMLElement>();
  private renderedKey: string | null = null;
  /* One press at a time, so the hold bookkeeping lives on the bar rather than
     per badge — a per-badge scroll listener on the (persistent) root would
     accumulate across rebuilds. */
  private holdTimer: number | null = null;
  private holdOrigin: { x: number; y: number } | null = null;
  /* A hold fires with the finger still down, and the lift that follows still
     dispatches a click. That click belongs to the hold and must not also
     switch tabs. Cleared by whichever comes first, the click itself or the
     pointerdown that starts the next gesture, so a hold WebKit never followed
     with a click cannot swallow a later tap. */
  private swallowNextClick = false;

  constructor(container: HTMLElement, callbacks: TabBarCallbacks) {
    this.container = container;
    this.callbacks = callbacks;
    this.touch = isTouchHost();
    this.root = this.container.createDiv({ cls: "claudian-tab-bar-container" });
    this.badgesEl = this.root.createDiv({ cls: "claudian-tab-badges" });
    this.newBtn = this.root.createSpan({
      cls: "claudian-tab-badge claudian-tab-badge-new",
      attr: { "aria-label": "New tab", title: "New tab" },
    });
    platform.setIcon(this.newBtn, "plus");
    this.newBtn.addEventListener("click", () => this.callbacks.onNew());
    /* A scroll of the strip is a flick, not a press: drop any armed hold. */
    if (this.touch) this.root.addEventListener("scroll", () => this.cancelHold(), { passive: true });
  }

  /* render() runs on EVERY state change, which during a turn means once per
     streaming chunk. Rebuilding the strip each time is invisible with a mouse
     but fatal to a finger: the element under the fingertip is detached
     mid-press, so the hold's pointerup never lands and the x on a busy tab —
     exactly the tab a user most wants to close — could not be tapped at all.
     So the badges are only rebuilt when the tab SET itself changes; a
     same-shape render just repaints classes. */
  render(tabs: TabBadgeState[], activeTabId: string | null) {
    const key = tabs.map(t => t.id).join(",");
    if (key !== this.renderedKey) {
      this.rebuild(tabs);
      this.renderedKey = key;
    }
    tabs.forEach((tab, idx) => {
      const badge = this.badgeEls.get(tab.id);
      if (!badge) return;
      const active = tab.id === activeTabId;
      const cls = this.badgeClass(tab, active);
      if (badge.className !== cls) badge.className = cls;
      if (!this.touch) return;
      const close = badge.querySelector<HTMLElement>(".claudian-tab-badge-close");
      if (active && !close) this.addCloseButton(badge, tab.id, idx);
      else if (!active && close) close.detach();
    });
  }

  private rebuild(tabs: TabBadgeState[]): void {
    this.cancelHold();
    this.badgesEl.empty();
    this.badgeEls.clear();
    tabs.forEach((tab, idx) => {
      const badge = this.badgesEl.createSpan({
        cls: "claudian-tab-badge",
        text: String(idx + 1),
        attr: { "data-tab-id": tab.id, title: tab.isIncognito ? `Tab ${idx + 1} · Incognito` : `Tab ${idx + 1}` },
      });
      this.badgeEls.set(tab.id, badge);
      badge.addEventListener("click", () => {
        if (this.swallowNextClick) {
          this.swallowNextClick = false;
          return;
        }
        this.callbacks.onSelect(tab.id);
      });
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
        this.showCloseMenu(e as MouseEvent, tab.id);
      });
      if (this.touch) this.wireHoldToClose(badge, tab.id);
    });
  }

  private showCloseMenu(evt: MouseEvent, tabId: string, touch = false): void {
    platform.showContextMenu(evt, [
      { title: "Close tab", icon: "x", onClick: () => this.callbacks.onClose(tabId) },
    ]);
    if (touch) armTouchMenuDismiss();
  }

  /* Touch only. `pointerdown` rather than `touchstart` so the same code covers
     an Apple Pencil or a trackpad-less iPad; a mouse pointer is skipped
     outright because the desktop gestures already own that case. */
  private wireHoldToClose(badge: HTMLElement, tabId: string): void {
    badge.addEventListener("pointerdown", e => {
      this.swallowNextClick = false;
      if (e.pointerType === "mouse") return;
      this.cancelHold();
      this.holdOrigin = { x: e.clientX, y: e.clientY };
      /* The event outlives its dispatch, so the menu can still be positioned
         at the finger half a second later. */
      const at = e;
      this.holdTimer = window.setTimeout(() => {
        this.holdTimer = null;
        this.holdOrigin = null;
        this.swallowNextClick = true;
        this.showCloseMenu(at, tabId, true);
      }, HOLD_MS);
    });
    badge.addEventListener("pointermove", e => {
      const origin = this.holdOrigin;
      if (!origin) return;
      if (Math.abs(e.clientX - origin.x) > HOLD_SLOP_PX || Math.abs(e.clientY - origin.y) > HOLD_SLOP_PX) {
        this.cancelHold();
      }
    });
    badge.addEventListener("pointerup", () => this.cancelHold());
    badge.addEventListener("pointercancel", () => this.cancelHold());
  }

  /* Touch only. Lives inside the badge so the strip keeps one flex item per
     tab and the x rides along when the strip scrolls. */
  private addCloseButton(badge: HTMLElement, tabId: string, idx: number): void {
    const close = badge.createSpan({
      cls: "claudian-tab-badge-close",
      attr: { "aria-label": `Close tab ${idx + 1}`, title: "Close tab", role: "button" },
    });
    platform.setIcon(close, "x");
    /* Pressing the x must not arm the badge's hold, and lifting off it must
       not fall through to the badge's select handler. */
    close.addEventListener("pointerdown", e => e.stopPropagation());
    close.addEventListener("click", e => {
      e.preventDefault();
      e.stopPropagation();
      this.cancelHold();
      this.callbacks.onClose(tabId);
    });
  }

  private cancelHold(): void {
    if (this.holdTimer !== null) {
      window.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    this.holdOrigin = null;
  }

  private badgeClass(tab: TabBadgeState, active: boolean): string {
    const parts = ["claudian-tab-badge"];
    if (active) parts.push("claudian-tab-badge-active");
    if (tab.busy) parts.push("claudian-tab-badge-streaming");
    if (tab.hasPendingApproval) parts.push("claudian-tab-badge-attention");
    if (tab.isIncognito) parts.push("claudian-tab-badge-incognito");
    return parts.join(" ");
  }
}
