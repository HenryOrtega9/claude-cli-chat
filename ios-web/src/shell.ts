/* IosChatShell — the gateway client's port of DesktopChatShell.

   Same composition as the Electron shell and the Obsidian view: header ->
   tab bar -> one TabController per tab. The divergences are all forced by the
   fact that the tab store lives on the Mac and the tab IDS ARE MINTED THERE:

   - createTab() is async and POSTs /tabs FIRST, then builds local state around
     the id the daemon returned. Nothing may invent a tab id here — the whole
     replay/seq/session-id machinery is keyed on the daemon's.
   - closeTab() DELETEs the tab. The daemon owns the conversation file and the
     event spill, so a local-only delete would leak both.
   - "New chat" (the header's clear button) POSTs /tabs/:id/clear and only then
     calls TabController.clear() locally. A purely local clear would wipe the UI
     while the daemon kept the messages, the replay ring and the session id, so
     the chat came back on the next restore and the next turn `--resume`d a
     conversation the user believed they had discarded. Closing and recreating
     the tab was the earlier workaround: it churned the tab id, dropped the chat
     out of History, and did not even yield a fresh chat when other tabs were
     open, because closeTab falls back to selecting a neighbour.
   - There is no window lock. The daemon is the single writer of its own store,
     and two phones talking to it is a supported case (each gets the same
     frames), not a corruption risk — which is exactly what the lock existed to
     prevent on a shared filesystem.
   - Remote Control and Center-window are gone: one is a macOS PTY flow, the
     other is an Electron window affordance.

   Boot ordering note: `window.__vaultgw.dispatch` must exist before anything
   else, because native can call it the moment the WebView finishes loading.
   That definition lives in renderer.ts, which then hands the handlers here. */

import { platform } from "../../src/platform";
import { renderHeader } from "../../src/view/Header";
import { TabBar, type TabBadgeState } from "../../src/view/TabBar";
import { TabController } from "../../src/view/TabController";
import { HistoryModal } from "../../src/view/HistoryModal";
import { MCPManagerModal } from "../../src/view/MCPManagerModal";
import { makeTabState, type TabState } from "../../src/view/state";
import {
  EFFORT_ORDER,
  MODEL_IDS,
  PERMISSION_MODE_ORDER,
  effortLevelsForModel,
  type ModelKey,
} from "../../src/settings-data";
import type { Persistence } from "../../src/storage/Persistence";
import type { GatewayConnection, LinkState } from "../../src/platform/remote/GatewayConnection";
import { isNativeHost } from "./native";
import type { RemoteHost } from "../../src/platform/remote/RemoteHost";
import type { RemoteFileStorage } from "../../src/platform/remote/RemoteFileStorage";
import type { GatewayTransport } from "../../src/platform/remote/transport";

export type ConnectivityPayload = { state?: string; message?: string };

/* Header affordances the phone does not offer. Environment snippets are
   authored in a settings file on the Mac; Remote Control is a PTY flow that
   only runs there. Both are removed from the shared header by aria-label
   rather than by forking src/view/Header.ts. */
const HIDDEN_HEADER_BUTTONS = ["Environment snippets", "Toggle Remote Control"];

/* The daemon's tab store is not exclusively ours: the smoke test posts
   `model: "haiku"`, a curl one-liner can PATCH anything, and older tabs may
   hold a raw CLI model id. TabController validates these before SPAWNING but
   hands `state.model` to InputBox unvalidated, where an unknown key has no
   label and the model pill throws while it is being built — taking the whole
   boot with it. Sanitizing on the way in keeps a foreign value from turning
   into a blank screen: an unrecognized field is dropped, and the controller's
   own fallback to the configured default takes over. */
function sanitizeRestoredTab(state: TabState): TabState {
  const model = state.model;
  if (model !== undefined && !Object.prototype.hasOwnProperty.call(MODEL_IDS, model)) {
    /* A resolved CLI id round-trips back to its picker key; anything else is
       dropped rather than guessed at. */
    const key = (Object.keys(MODEL_IDS) as ModelKey[]).find(k => MODEL_IDS[k] === model);
    state.model = key;
  }
  if (state.effort !== undefined && !(EFFORT_ORDER as readonly string[]).includes(state.effort)) {
    state.effort = undefined;
  }
  /* Effort has to be legal FOR the surviving model, not just legal in general:
     xhigh only exists on the 1M variants, and the pill would render a level
     the CLI rejects. Mirrors TabController's own clamp target. */
  if (state.model !== undefined && state.effort !== undefined
    && !effortLevelsForModel(state.model as ModelKey).includes(state.effort as never)) {
    state.effort = "high";
  }
  if (state.permissionMode !== undefined
    && !(PERMISSION_MODE_ORDER as readonly string[]).includes(state.permissionMode)) {
    state.permissionMode = undefined;
  }
  /* A phone tab may never run unprompted tools. */
  if (state.permissionMode === "bypassPermissions") state.permissionMode = "acceptEdits";
  return state;
}

/* How long a tab we cleared ourselves ignores the daemon's `resync` for that
   clear. Generous on purpose: the frame travels over the WebSocket while the
   answer came back over HTTP, so it can land either side of the response, and
   the only cost of a wide window is that a genuine buffer_evicted resync for
   the same tab in the same second is skipped. */
const SELF_CLEAR_GRACE_MS = 10_000;

const CONNECTIVITY_TEXT: Record<string, string> = {
  ok: "",
  starting: "Mac is waking the gateway…",
  tailscale_off: "Tailscale is off",
  mac_asleep: "Mac is asleep",
  gateway_down: "Gateway not responding",
  unauthorized: "Gateway rejected the token",
};

export class IosChatShell {
  private readonly tabs: TabController[] = [];
  private activeTabId: string | null = null;
  private tabBar!: TabBar;
  private tabsContainer!: HTMLElement;
  private stateStrip!: HTMLElement;
  private torndown = false;
  /* Set while restoreTabs() runs so a resync frame arriving mid-restore does
     not tear down a controller that is still being built. */
  private restoring = false;
  /* tab id -> the model/effort/mode triple last accepted by the daemon, so the
     per-token onStateChange flood does not become a PATCH flood. */
  private readonly pushedConfig = new Map<string, string>();
  /* Tabs this client just cleared, so the daemon's own `resync` for that clear
     is not answered with a rebuild we have already done in place. */
  private readonly selfCleared = new Set<string>();

  constructor(
    private readonly root: HTMLElement,
    private readonly host: RemoteHost,
    private readonly conn: GatewayConnection,
    private readonly persistence: Persistence,
    private readonly storage: RemoteFileStorage,
    private readonly transport: GatewayTransport,
  ) {}

  async mount(): Promise<void> {
    this.root.empty();
    this.root.addClass("claudian-container");
    this.root.setAttribute("data-provider", "claude");

    const header = renderHeader(this.root, {
      onNewTab: () => void this.createTab(),
      onClear: () => void this.newChat(),
      onHistory: () => this.showHistory(),
      onSnippets: () => { /* removed below */ },
      onMcp: () => this.showMcpManager(),
      onToggleRemoteControl: () => { /* removed below */ },
    });
    this.trimHeader(header);

    this.stateStrip = this.root.createDiv({ cls: "vaultgw-state-strip" });
    this.stateStrip.style.display = "none";

    const navRow = this.root.createDiv({ cls: "claudian-input-nav-row" });
    this.tabBar = new TabBar(navRow, {
      onSelect: (id) => this.selectTab(id),
      onClose: (id) => void this.closeTab(id),
      onNew: () => void this.createTab(),
    });

    this.tabsContainer = this.root.createDiv({ cls: "claudian-tab-content-container" });

    /* See RemoteHost.generateTitle: it needs to map a TitleGenOptions with no
       tab id back to a tab, and the first user message is the one identifying
       value available at the moment the controller fires it. */
    this.host.setTabResolver(userMessage => {
      const match = this.tabs.find(t => t.state.messages.find(m => m.role === "user")?.content === userMessage);
      return match?.state.id ?? null;
    });
    this.installBypassModeGuard();
    this.conn.onLinkState(state => this.renderLinkState(state));
    this.conn.onResync((tabId, reason) => void this.resyncTab(tabId, reason));

    await this.restoreTabs();
  }

  /* The shared header is fixed (src/ is not this change's to edit), so the two
     buttons the phone does not offer are removed after the fact and the
     settings gear is appended — same element shape and classes, so styles.css
     covers it. */
  private trimHeader(header: HTMLElement): void {
    const actions = header.querySelector<HTMLElement>(".claudian-header-actions");
    if (!actions) return;
    for (const label of HIDDEN_HEADER_BUTTONS) {
      actions.querySelector<HTMLElement>(`[aria-label="${label}"]`)?.remove();
    }
    const settings = actions.createSpan({
      cls: "claudian-header-btn",
      attr: { "aria-label": "Settings", title: "Settings" },
    });
    platform.setIcon(settings, "settings");
    settings.addEventListener("click", () => {
      this.transport.haptic("selection");
      this.transport.openSettings();
    });
  }

  /* The composer's permission-mode popup is built from PERMISSION_MODE_ORDER,
     which includes bypassPermissions. A phone tab may NEVER run in it
     (CONTRACTS.md: /catalog omits it, the daemon coerces it on create and
     ignores it on patch) — so leaving the row in place would offer a choice
     that silently does nothing while the pill claims it took effect. The row
     is removed as each popup is built, located by its index in the same order
     the popup iterates rather than by its label text.

     A MutationObserver rather than a fork of InputBox: src/view is not this
     change's to edit, and the popup is created fresh on every open. */
  private installBypassModeGuard(): void {
    const index = (PERMISSION_MODE_ORDER as readonly string[]).indexOf("bypassPermissions");
    if (index === -1) return;
    const strip = (popup: Element) => {
      const rows = popup.querySelectorAll(".claudian-popup-row");
      rows[index]?.remove();
    };
    for (const popup of Array.from(document.querySelectorAll(".claudian-popup-mode"))) strip(popup);
    new MutationObserver(records => {
      for (const record of records) {
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof Element)) continue;
          if (node.classList.contains("claudian-popup-mode")) strip(node);
          else for (const popup of Array.from(node.querySelectorAll?.(".claudian-popup-mode") ?? [])) strip(popup);
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  /* ----- tab lifecycle ---------------------------------------------------- */

  private async restoreTabs(): Promise<void> {
    this.restoring = true;
    try {
      const index = await this.persistence.loadIndex();
      if (!index || index.tabs.length === 0) {
        await this.createTab();
        return;
      }
      for (const entry of index.tabs) {
        const state = await this.persistence.loadTab(entry.id);
        if (!state) continue;
        this.mountTab(state, { silent: true });
      }
      if (this.tabs.length === 0) {
        await this.createTab();
        return;
      }
      const wanted = index.activeTabId && this.tabs.some(t => t.state.id === index.activeTabId)
        ? index.activeTabId
        : this.tabs[0].state.id;
      this.selectTab(wanted, { skipSave: true });
    } finally {
      this.restoring = false;
    }
  }

  /* Creates the tab ON THE DAEMON first, then mounts a controller around the
     id it returned. Everything downstream (replay cursors, session id,
     `--resume`) is keyed on that id, so there is no path where the phone picks
     one. */
  async createTab(seed?: Partial<TabState>, opts: { incognito?: boolean } = {}): Promise<TabController | null> {
    const res = await this.conn.rpc("POST", "/tabs", {
      title: seed?.title ?? "New chat",
      model: seed?.model ?? this.host.settings.defaultModel,
      effort: seed?.effort ?? this.host.settings.defaultEffort,
      permissionMode: seed?.permissionMode ?? this.host.settings.permissionMode,
      ...(opts.incognito ? { incognito: true } : {}),
    });
    const created = res.json as { id?: unknown; sessionId?: unknown } | undefined;
    if (res.status !== 200 || typeof created?.id !== "string") {
      platform.notify(
        res.status === 0
          ? "Can't reach the gateway — no new chat was created."
          : `Gateway refused a new chat (HTTP ${res.status}).`,
        6000,
      );
      return null;
    }
    this.storage.invalidate();
    const state: TabState = {
      ...makeTabState({ incognito: opts.incognito }),
      ...seed,
      id: created.id,
      sessionId: typeof created.sessionId === "string" ? created.sessionId : null,
      pendingApprovals: new Map(),
      busy: false,
    };
    const controller = this.mountTab(state, { silent: false });
    this.selectTab(state.id);
    return controller;
  }

  /* Model / effort / permission-mode changes reach the daemon on the NEXT
     turn's spawn (RemoteTabSession.ensureTabConfig), which is correct for the
     ENGINE — the contract says engine-affecting patches take effect on
     respawn. It is wrong for the STORE: until a turn happens the daemon still
     holds the old value, so a reload (or the phone's own background restore)
     would silently revert the pill the user just moved. Pushing the choice as
     soon as it changes keeps the two in step without touching the running
     child, because PATCH does not restart one. */
  private pushTabConfig(controller: TabController): void {
    const state = controller.state;
    const signature = `${state.model ?? ""}|${state.effort ?? ""}|${state.permissionMode ?? ""}`;
    if (this.pushedConfig.get(state.id) === signature) return;
    this.pushedConfig.set(state.id, signature);
    const body: Record<string, unknown> = {};
    if (state.model) body.model = state.model;
    if (state.effort) body.effort = state.effort;
    if (state.permissionMode) body.permissionMode = state.permissionMode;
    if (Object.keys(body).length === 0) return;
    void this.conn.rpc("PATCH", `/tabs/${encodeURIComponent(state.id)}`, body).then(res => {
      /* Let a failed push retry on the next state change rather than
         pretending the daemon agrees with the pill. */
      if (res.status !== 200) this.pushedConfig.delete(state.id);
      else this.storage.invalidateTab(state.id);
    });
  }

  private mountTab(rawState: TabState, opts: { silent: boolean }): TabController {
    const state = sanitizeRestoredTab(rawState);
    const controller = new TabController(
      this.host,
      this.tabsContainer,
      /* Opaque RenderLifecycle. IosPlatform.renderMarkdown ignores it; passing
         the shell keeps the "the mounting surface owns the render" story. */
      this,
      state,
      () => {
        if (controller.isDestroyed()) return;
        this.renderTabBar();
        this.conn.setTabTitle(controller.state.id, controller.state.title);
        this.conn.setTabBusy(controller.state.id, controller.isBusy());
        this.pushTabConfig(controller);
        /* The daemon projects and persists the conversation itself; what the
           phone still owns is the tab INDEX (title, active tab), which
           RemoteFileStorage maps to PATCH /tabs/:id. */
        this.saveIndex();
      },
    );
    controller.onForkRequest = (src, messageId) => void this.forkFromMessage(src, messageId);
    controller.onIncognitoToggle = (tabId, incognito) => void this.onIncognitoToggle(tabId, incognito);
    /* Seed from what the daemon just told us so mounting a tab does not
       immediately PATCH back the value it was read from. */
    this.pushedConfig.set(
      state.id,
      `${state.model ?? ""}|${state.effort ?? ""}|${state.permissionMode ?? ""}`,
    );
    this.tabs.push(controller);
    if (!opts.silent) this.renderTabBar();
    return controller;
  }

  private saveIndex(): Promise<void> {
    const activeTab = this.tabs.find(t => t.state.id === this.activeTabId);
    const activeTabId = activeTab && !activeTab.state.incognito ? this.activeTabId : null;
    return this.persistence.saveIndex({
      activeTabId,
      tabs: this.tabs
        .filter(t => !t.state.incognito)
        .map(t => ({ id: t.state.id, title: t.state.title, sessionId: t.state.sessionId })),
    }).catch(err => {
      console.warn("[vaultgw] index write failed", err);
    });
  }

  private selectTab(tabId: string, opts: { skipSave?: boolean } = {}): void {
    this.activeTabId = tabId;
    for (const tab of this.tabs) {
      if (tab.state.id === tabId) tab.show();
      else tab.hide();
    }
    this.conn.setActiveTab(tabId);
    this.renderTabBar();
    /* Deliberately NOT focusing the composer: on iOS focusing a textarea
       raises the keyboard, and a tab switch that shoves half the conversation
       off-screen is the wrong default. The user taps to type. */
    if (!opts.skipSave) void this.saveIndex();
  }

  async closeTab(tabId: string): Promise<void> {
    const idx = this.tabs.findIndex(t => t.state.id === tabId);
    if (idx === -1) return;
    await this.conn.rpc("DELETE", `/tabs/${encodeURIComponent(tabId)}`);
    await this.removeLocalTab(idx, tabId);
  }

  /* The daemon told us (over the socket, `resync{reason:"gone"}`) that this
     tab no longer exists on its side at all — most likely DELETEd from
     another device while this one was disconnected. Unlike closeTab() there
     is nothing left to delete server-side, and unlike a plain resync there is
     nothing to reload from (GET /tabs/:id 404s too), so this just tears down
     the local half and says why. */
  private async dropGoneTab(idx: number, tabId: string): Promise<void> {
    await this.removeLocalTab(idx, tabId);
    platform.notify("This chat was removed on the Mac.", 5000);
  }

  /* Shared teardown: destroy the controller, forget the tab everywhere on
     this client, and pick a sensible new active tab. Callers differ only in
     whether the daemon still needs telling (closeTab) or already knows
     (dropGoneTab). */
  private async removeLocalTab(idx: number, tabId: string): Promise<void> {
    const [removed] = this.tabs.splice(idx, 1);
    await removed.destroy();
    this.conn.forgetTab(tabId);
    this.pushedConfig.delete(tabId);
    this.storage.invalidate();
    if (this.tabs.length === 0) {
      await this.createTab();
      return;
    }
    if (this.activeTabId === tabId) {
      const fallback = this.tabs[Math.min(Math.max(0, idx - 1), this.tabs.length - 1)];
      if (fallback) this.selectTab(fallback.state.id);
    } else {
      this.renderTabBar();
    }
    void this.saveIndex();
  }

  /* The header's "new chat" button: reset the ACTIVE tab in place, keeping its
     id, its slot in the tab bar and its model / effort / mode. See the class
     header for why the daemon has to be told first. */
  private async newChat(): Promise<void> {
    const active = this.tabs.find(t => t.state.id === this.activeTabId);
    if (!active) {
      await this.createTab();
      return;
    }
    if (active.state.messages.length === 0 && !active.isBusy()) {
      /* Already empty — nothing to discard, and a round trip would only churn
         the session id of a chat that has not started. */
      active.focusInput();
      return;
    }
    const tabId = active.state.id;
    /* Suppress the `resync` the daemon broadcasts for this clear: it is meant
       for OTHER clients, and letting it rebuild the controller we are about to
       reset ourselves would tear down and remount the tab for nothing. */
    this.selfCleared.add(tabId);
    window.setTimeout(() => this.selfCleared.delete(tabId), SELF_CLEAR_GRACE_MS);
    const res = await this.conn.rpc("POST", `/tabs/${encodeURIComponent(tabId)}/clear`);
    if (res.status !== 200) {
      this.selfCleared.delete(tabId);
      platform.notify(
        res.status === 0
          ? "Can't reach the gateway — the chat was not cleared."
          : `Gateway refused to clear the chat (HTTP ${res.status}).`,
        6000,
      );
      return;
    }
    /* Jump the cursor past the wiped history. Without this the next reconnect
       subscribes with a `since` below the ring's new floor, the daemon answers
       `resync`, and the tab rebuilds itself for no reason. */
    const lastSeq = (res.json as { lastSeq?: unknown } | undefined)?.lastSeq;
    if (typeof lastSeq === "number") this.conn.seedSeq(tabId, lastSeq);
    this.storage.invalidateTab(tabId);
    /* The shared reset: kills this client's session handle, empties the
       messages, restores the welcome screen. The daemon has already minted the
       new session id, and the next `tab_status` carries it. */
    await active.clear();
    this.renderTabBar();
    void this.saveIndex();
    active.focusInput();
  }

  private async forkFromMessage(source: TabController, messageId: string): Promise<void> {
    const idx = source.state.messages.findIndex(m => m.id === messageId);
    if (idx === -1) {
      platform.notify("Couldn't find message to fork from.");
      return;
    }
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
    const controller = await this.createTab({
      title: `Fork: ${source.state.title}`,
      messages: truncated,
      model: source.state.model,
      effort: source.state.effort,
      permissionMode: source.state.permissionMode,
      voiceEnabled: source.state.voiceEnabled,
    });
    if (!controller) return;
    platform.notify(
      `Forked into a new chat. ${truncated.length} messages carried for reference — the new session starts fresh.`,
      6000,
    );
  }

  /* Incognito flips only on a still-empty tab (the pill locks the moment a
     session exists), so the daemon's tab can be swapped wholesale: delete the
     old one, create an incognito one, and repoint the controller's state at
     the new id. Nothing is keyed on the old id yet. */
  private async onIncognitoToggle(tabId: string, incognito: boolean): Promise<void> {
    const controller = this.tabs.find(t => t.state.id === tabId);
    if (!controller) return;
    const res = await this.conn.rpc("POST", "/tabs", {
      title: controller.state.title,
      model: controller.state.model ?? this.host.settings.defaultModel,
      effort: controller.state.effort ?? this.host.settings.defaultEffort,
      permissionMode: controller.state.permissionMode ?? this.host.settings.permissionMode,
      ...(incognito ? { incognito: true } : {}),
    });
    const created = res.json as { id?: unknown; sessionId?: unknown } | undefined;
    if (res.status !== 200 || typeof created?.id !== "string") {
      platform.notify("Couldn't switch incognito on the gateway.", 5000);
      return;
    }
    await this.conn.rpc("DELETE", `/tabs/${encodeURIComponent(tabId)}`);
    this.conn.forgetTab(tabId);
    controller.state.id = created.id;
    controller.state.sessionId = typeof created.sessionId === "string" ? created.sessionId : null;
    if (this.activeTabId === tabId) this.activeTabId = created.id;
    this.storage.invalidate();
    this.renderTabBar();
    void this.saveIndex();
  }

  /* The daemon's replay ring no longer reaches back to our cursor — either it
     rolled over, or someone cleared the tab and the old history is gone.
     Rebuilding from GET /tabs/:id is the contract's prescribed answer in both
     cases: the daemon's own projection is authoritative, and the controller
     re-renders from it. */
  private async resyncTab(tabId: string, reason = "buffer_evicted"): Promise<void> {
    if (this.restoring) return;
    if (this.selfCleared.has(tabId)) return;
    const idx = this.tabs.findIndex(t => t.state.id === tabId);
    if (idx === -1) return;
    /* "gone" (server.ts handleSubscribe): the daemon has no engine at all for
       this id — deleted from another device, most likely. Unlike a plain
       buffer eviction there is nothing to rebuild from (GET /tabs/:id 404s
       too), so this is a removal, not a resync. */
    if (reason === "gone") return this.dropGoneTab(idx, tabId);
    this.storage.invalidateTab(tabId);
    const fresh = await this.persistence.loadTab(tabId);
    if (!fresh) return;
    const [old] = this.tabs.splice(idx, 1);
    const wasActive = this.activeTabId === tabId;
    await old.destroy();
    const controller = this.mountTab(fresh, { silent: true });
    /* Keep tab order stable so the bar doesn't jump under the user. */
    this.tabs.splice(this.tabs.indexOf(controller), 1);
    this.tabs.splice(idx, 0, controller);
    if (wasActive) this.selectTab(tabId, { skipSave: true });
    else controller.hide();
    this.renderTabBar();
    platform.notify(
      reason === "cleared"
        ? "This chat was cleared on another device."
        : "Reloaded this chat from the Mac (the replay buffer had rolled over).",
      5000,
    );
  }

  private renderTabBar(): void {
    const badges: TabBadgeState[] = this.tabs.map(t => ({
      id: t.state.id,
      busy: t.isBusy(),
      hasPendingApproval: t.hasPendingApprovals(),
      isIncognito: !!t.state.incognito,
    }));
    this.tabBar.render(badges, this.activeTabId);
  }

  /* ----- header actions --------------------------------------------------- */

  private showMcpManager(): void {
    new MCPManagerModal(null, this.host, () => {
      this.storage.invalidate();
      const active = this.tabs.find(t => t.state.id === this.activeTabId);
      if (active) void active.refreshCostSurface();
    }).open();
  }

  private showHistory(): void {
    new HistoryModal(null, this.persistence, async (conversationId) => {
      const existing = this.tabs.find(t => t.state.id === conversationId);
      if (existing) {
        this.selectTab(existing.state.id);
        return;
      }
      const state = await this.persistence.loadTab(conversationId);
      /* A history row IS a daemon tab (the daemon keeps every tab addressable
         forever), so reopening one mounts it directly rather than creating a
         new tab and copying its messages across. */
      if (!state) {
        platform.notify("That chat is no longer on the gateway.");
        return;
      }
      this.mountTab(state, { silent: false });
      this.selectTab(state.id);
    }).open();
  }

  /* ----- native dispatch targets ------------------------------------------ */

  /* `share` — text arriving from the iOS share sheet. Goes into the active
     composer rather than being sent, so the user still frames the question. */
  insertIntoComposer(text: string): void {
    const composer = this.activeComposer();
    if (!composer) return;
    const existing = composer.value;
    composer.value = existing ? `${existing.replace(/\s*$/, "")}\n\n${text}` : text;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    composer.focus();
  }

  /* Native's connectivity dispatch. Inside the app this is the same sentence
     the native banner is already showing in a view the page cannot cover, and
     printing it twice, stacked, reads as a bug rather than as emphasis. The
     dev browser has no native banner, so there the strip stays the only
     indicator. Socket-level states that native does not know about still go
     through showStrip(); see renderLinkState. */
  setConnectivity(payload: ConnectivityPayload): void {
    const state = typeof payload.state === "string" ? payload.state : "ok";
    if (state === "ok" || isNativeHost()) return this.hideStrip();
    const text = payload.message || CONNECTIVITY_TEXT[state] || state;
    this.showStrip(text, state === "unauthorized" || state === "gateway_down");
  }

  private showStrip(text: string, isError: boolean): void {
    this.stateStrip.setText(text);
    this.stateStrip.style.display = "";
    this.stateStrip.toggleClass("is-error", isError);
  }

  private hideStrip(): void {
    this.stateStrip.style.display = "none";
  }

  /* The socket's own view of the link, which is finer-grained than native's
     reachability check: a reconnecting socket is worth showing even when the
     tunnel is technically up. Native's banner stays the primary indicator. */
  private renderLinkState(state: LinkState): void {
    switch (state) {
      case "open":
        this.hideStrip();
        return;
      case "unauthorized":
        this.setConnectivity({ state: "unauthorized" });
        return;
      case "reconnecting":
        /* Native's /health probe cannot see this (the tunnel is up and the
           socket is not), so the strip shows it even under the app. */
        this.showStrip("Reconnecting to the Mac…", false);
        return;
      default:
        return;
    }
  }

  activeComposer(): HTMLTextAreaElement | null {
    const scope: HTMLElement = this.tabsContainer ?? this.root;
    const contents = Array.from(scope.querySelectorAll<HTMLElement>(".claudian-tab-content"));
    const visible = contents.find(el => el.style.display !== "none") ?? null;
    return visible?.querySelector<HTMLTextAreaElement>("textarea.claudian-input") ?? null;
  }

  /* ----- teardown ---------------------------------------------------------- */

  async destroy(): Promise<void> {
    if (this.torndown) return;
    this.torndown = true;
    await Promise.all(this.tabs.map(t => t.destroy()));
    this.tabs.length = 0;
  }
}
