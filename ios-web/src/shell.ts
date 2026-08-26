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
import { isNativeHost, onSwitchTab, type PendingTabSwitch } from "./native";
import type { RemoteHost } from "../../src/platform/remote/RemoteHost";
import type { RemoteFileStorage } from "../../src/platform/remote/RemoteFileStorage";
import type { GatewayTransport } from "../../src/platform/remote/transport";
import type { InputBox } from "../../src/view/InputBox";

export type ConnectivityPayload = { state?: string; message?: string };

/* The `share` dispatch's payload shape — native.ts's ShareInbox hand-off
   (iOS Share Extension) and DebugLaunchEnvironment's VAULTGW_AUTOSEND both
   land here through the same `case "share"` in renderer.ts. */
export type SharePayload = {
  text?: string;
  images?: { mediaType: string; dataUri: string }[];
};

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
  /* tab id -> the last `draft` value onStateChange actually scheduled a save
     for. Every OTHER field a remote save touches (messages, tool results...)
     is a no-op on this host — the daemon already projects and persists the
     conversation itself, see RemoteFileStorage's class header — so on a long
     streaming turn, calling scheduleSaveTab() on every token would debounce
     into a doSaveTab() that JSON.stringifies the whole (possibly
     multi-message) conversation, RemoteFileStorage.write() JSON.parses it
     right back, and then throws away everything but `draft` — two full
     passes over a growing string, twice a second, purely to move a few bytes
     of composer text that almost never changed. Comparing against this map
     skips scheduling entirely when the draft didn't move, so streaming
     tokens cost nothing here; a real composer edit still schedules exactly
     the same debounced write as before. */
  private readonly pushedDraft = new Map<string, string>();
  /* Tabs this client just cleared, so the daemon's own `resync` for that clear
     is not answered with a rebuild we have already done in place. */
  private readonly selfCleared = new Set<string>();
  /* True once mount() has finished restoreTabs(). Guards switchTab deep
     links: one arriving before this is true would find `this.tabs` empty
     (or mid-build) and either no-op or race restoreTabs' own mounting, so it
     is parked in `pendingSwitchTab` and replayed at the end of mount()
     instead. */
  private mounted = false;
  /* A switchTab deep link (notification tap) received before mount()
     finishes. restoreTabs() also peeks this (without consuming it) so the
     INITIAL active tab can already be the right one — avoiding a flash of
     whatever was active before the app was killed — when the deep link's
     target is among the tabs being restored. mount()'s own consumption,
     after restoreTabs(), is what actually applies it (select + scroll),
     which also covers the case where the target isn't a locally-known tab at
     all (closed elsewhere, needs a server fetch — see switchTab()). */
  private pendingSwitchTab: PendingTabSwitch | null = null;
  /* A `share` dispatch (iOS Share Extension hand-off, or VAULTGW_AUTOSEND —
     both go through renderer.ts's `case "share"` -> handleShare) that
     arrived before mount() built the composer DOM. Same shape of bug as
     pendingSwitchTab and the same fix: activeComposer() is a plain DOM
     query with no retry, so a share landing during boot() (always true on a
     cold launch — the WebKit IPC round-trip for evaluateJavaScript is far
     faster than boot()'s network calls that precede installHandler) would
     otherwise silently no-op. Buffered here, applied at the end of mount(). */
  private pendingShare: SharePayload | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly host: RemoteHost,
    private readonly conn: GatewayConnection,
    private readonly persistence: Persistence,
    private readonly storage: RemoteFileStorage,
    private readonly transport: GatewayTransport,
  ) {
    /* Registered here, synchronously, at construction — before any of
       mount()'s awaits — so a deep link that raced the cold-launch boot
       sequence (see native.ts's __vaultgwSwitchTab) is captured as early as
       this class can possibly capture it. */
    onSwitchTab(pending => this.handleSwitchTab(pending));
  }

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
    this.mounted = true;
    if (this.pendingSwitchTab) {
      const pending = this.pendingSwitchTab;
      this.pendingSwitchTab = null;
      void this.switchTab(pending.tabId, pending.requestId);
    }
    if (this.pendingShare) {
      const pending = this.pendingShare;
      this.pendingShare = null;
      this.applyShare(pending);
    }
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
      /* A pending switchTab deep link wins over the persisted active tab, so
         the first render already shows the notification's target instead of
         flashing whatever was active before the app was killed and then
         flipping over once mount()'s post-restore consumption runs. Peeked,
         not consumed: mount() still does the actual select + scroll-to-card
         pass after this returns, which is also what handles a target that
         isn't among these restored (open) tabs at all. */
      const pendingTarget = this.pendingSwitchTab?.tabId;
      const wanted = pendingTarget && this.tabs.some(t => t.state.id === pendingTarget)
        ? pendingTarget
        : index.activeTabId && this.tabs.some(t => t.state.id === index.activeTabId)
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
        /* The daemon projects and persists the conversation itself — except
           for `draft` (unsent composer text), which it has no way to learn
           on its own. Route it through the normal Persistence save path like
           the plugin/desktop already do: RemoteFileStorage's write() maps a
           conversation-body write's `draft` field to PATCH /tabs/:id. Gated
           on `pushedDraft` (see its own comment) so a token-streaming state
           change that left `draft` untouched never even arms the debounce —
           only an actual composer edit schedules a save. */
        if (!controller.state.incognito) {
          const draftSig = controller.state.draft ?? "";
          if (this.pushedDraft.get(controller.state.id) !== draftSig) {
            this.pushedDraft.set(controller.state.id, draftSig);
            void this.persistence.scheduleSaveTab(controller.state);
          }
        }
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
    /* Same seeding, for the same reason: mounting a tab already carries
       whatever `draft` it was loaded with, so that value must not look like
       a fresh edit the first time onStateChange fires. */
    this.pushedDraft.set(state.id, state.draft ?? "");
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
    if (!this.tabs.some(t => t.state.id === tabId)) return;
    await this.conn.rpc("DELETE", `/tabs/${encodeURIComponent(tabId)}`);
    await this.removeLocalTab(tabId);
  }

  /* The daemon told us (over the socket, `resync{reason:"gone"}`) that this
     tab no longer exists on its side at all — most likely DELETEd from
     another device while this one was disconnected. Unlike closeTab() there
     is nothing left to delete server-side, and unlike a plain resync there is
     nothing to reload from (GET /tabs/:id 404s too), so this just tears down
     the local half and says why. */
  private async dropGoneTab(tabId: string): Promise<void> {
    await this.removeLocalTab(tabId);
    platform.notify("This chat was removed on the Mac.", 5000);
  }

  /* Shared teardown: destroy the controller, forget the tab everywhere on
     this client, and pick a sensible new active tab. Callers differ only in
     whether the daemon still needs telling (closeTab) or already knows
     (dropGoneTab).

     Takes only the id, not an index a caller resolved before its own await —
     `this.tabs` can be mutated by an interleaved close/resync while that
     await was in flight (a slow tailnet lets two closes or two buffer_evicted
     resyncs race), and splicing a stale index destroys whichever controller
     now happens to sit there instead of the intended one. Re-resolving here,
     with no await between the lookup and the splice, is the fix. */
  private async removeLocalTab(tabId: string): Promise<void> {
    const idx = this.tabs.findIndex(t => t.state.id === tabId);
    if (idx === -1) return;
    const [removed] = this.tabs.splice(idx, 1);
    await removed.destroy();
    this.conn.forgetTab(tabId);
    this.pushedConfig.delete(tabId);
    this.pushedDraft.delete(tabId);
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
    if (!this.tabs.some(t => t.state.id === tabId)) return;
    /* "gone" (server.ts handleSubscribe): the daemon has no engine at all for
       this id — deleted from another device, most likely. Unlike a plain
       buffer eviction there is nothing to rebuild from (GET /tabs/:id 404s
       too), so this is normally a removal, not a resync.

       BUT: the daemon also answers "gone" for every open tab while it is
       still warming up (main.ts calls server.listen() before awaiting
       registry.restore(), and /health answers "starting" for that whole
       window — measured up to ~33s for a cold iCloud vault read). A socket
       reconnect racing that window (launchd restart, Mac wake) would
       otherwise get "gone" for every tab this client watches and destroy
       them all. A fresh /health read distinguishes the two: only a "ready"
       answer makes this frame trustworthy. A "starting" (or unreachable)
       answer means it's the warm-up false positive, so it's discarded — the
       daemon will say so again, correctly, once it's actually ready and the
       tab is truly gone. */
    if (reason === "gone") {
      const health = await this.conn.rpc("GET", "/health");
      const state = (health.json as { state?: unknown } | undefined)?.state;
      if (health.status !== 200 || state !== "ready") return;
      /* Re-check existence: the tab may have been closed locally, or already
         resynced away, while the /health round trip was in flight. */
      if (!this.tabs.some(t => t.state.id === tabId)) return;
      return this.dropGoneTab(tabId);
    }
    this.storage.invalidateTab(tabId);
    /* loadTab (GET /tabs/:id) happens BEFORE old.destroy() below, so even a
       flush right before destroy would already be too late to make this
       GET's response reflect it — flushing here would still race the
       server round-trip. Instead capture the live text straight off the
       DOM (same textarea.claudian-input selector activeComposer() uses,
       just scoped to THIS tab's root rather than the visible one) and
       reapply it after mountTab below if it differs from what the GET came
       back with. Read via the DOM rather than InputBox's own draft API:
       InputBox.flushDraft()/a value getter would need a change to
       InputBox.ts beyond the addImageAttachments method this pass owns
       there, and the DOM already holds the ground truth. */
    const fresh = await this.persistence.loadTab(tabId);
    if (!fresh) return;
    /* Resolved fresh, not reused from before the loadTab await: `this.tabs`
       can be mutated by an interleaved close/resync while that GET was in
       flight, and splicing a stale index would destroy whichever controller
       now happens to sit there. Also doubles as the "did this tab disappear
       while we were fetching it" guard. */
    const idx = this.tabs.findIndex(t => t.state.id === tabId);
    if (idx === -1) return;
    const [old] = this.tabs.splice(idx, 1);
    const wasActive = this.activeTabId === tabId;
    const localDraft = old.root.querySelector<HTMLTextAreaElement>("textarea.claudian-input")?.value ?? "";
    /* { abort: false }: this is a client-side catch-up (replay ring rolled
       over, or another device cleared/reopened the tab), not a user-driven
       cancel — the daemon was never asked to stop anything, and destroying
       `old` only to remount a fresh controller around the SAME tab a moment
       later must not abort a turn the Mac may still be generating for it.
       See TabController.destroy's `opts` comment. */
    await old.destroy({ abort: false });
    const controller = this.mountTab(fresh, { silent: true });
    if (localDraft && localDraft !== (fresh.draft ?? "")) {
      /* Reapply through the same input+dispatchEvent pattern insertIntoComposer
         uses: InputBox's own "input" listener picks it up from there (autoResize,
         scheduleDraftPublish), so the newly mounted controller ends up with
         exactly the state it would have had if the resync had never
         interrupted the user's typing. */
      const composer = controller.root.querySelector<HTMLTextAreaElement>("textarea.claudian-input");
      if (composer) {
        composer.value = localDraft;
        composer.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
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

  /* `share` — text and/or images arriving from the iOS share sheet (or
     VAULTGW_AUTOSEND, which rides the same channel). Called from
     renderer.ts's `case "share"`; buffers via pendingShare above when
     mount() has not finished yet, applies immediately otherwise. Goes into
     the active composer rather than being sent, so the user still frames
     the question. */
  handleShare(payload: SharePayload): void {
    if (!this.mounted) {
      /* No batch-share path exists, so two shares queuing before mount is
         rare (it needs the app killed and relaunched twice in a hurry, or
         ShareInbox.drain firing more than once before boot() finishes) but
         not impossible — merge rather than let the second overwrite the
         first. */
      this.pendingShare = this.pendingShare
        ? {
            text: [this.pendingShare.text, payload.text].filter(Boolean).join("\n\n") || undefined,
            images: [...(this.pendingShare.images ?? []), ...(payload.images ?? [])],
          }
        : payload;
      return;
    }
    this.applyShare(payload);
  }

  private applyShare(payload: SharePayload): void {
    if (payload.text) this.insertIntoComposer(payload.text);
    if (payload.images && payload.images.length > 0) {
      this.activeInputBox()?.addImageAttachments(payload.images);
    }
  }

  /* TabController.inputBox is private — a TypeScript-only boundary, not a
     runtime one. TabController.ts already exposes narrow passthroughs for
     exactly this shape of need (ingestDroppedFiles, focusInput); the ideal
     fix here is one more line there —
     `addImageAttachments(items: {mediaType, dataUri}[]) { this.inputBox.addImageAttachments(items); }`
     next to those — but TabController.ts is another concurrent pass's file
     this wave (draft persistence / notification deep-link both touch it
     right now), so this reaches through rather than risking a concurrent
     write to a file outside this pass's ownership. Narrow and documented on
     purpose: swap for the real passthrough once that lands. */
  private activeInputBox(): InputBox | null {
    const controller = this.tabs.find(t => t.state.id === this.activeTabId);
    if (!controller) return null;
    return controller.getInputBox();
  }

  /* `share` text — goes into the active composer rather than being sent, so
     the user still frames the question. */
  insertIntoComposer(text: string): void {
    const composer = this.activeComposer();
    if (!composer) return;
    const existing = composer.value;
    composer.value = existing ? `${existing.replace(/\s*$/, "")}\n\n${text}` : text;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    composer.focus();
  }

  /* `switchTab` — a notification tap's deep link (native.ts's
     __vaultgwSwitchTab, wired via onSwitchTab in the constructor). Parked
     until mount() has restored tabs; applied immediately once it has. */
  private handleSwitchTab(pending: PendingTabSwitch): void {
    if (!this.mounted) {
      this.pendingSwitchTab = pending;
      return;
    }
    void this.switchTab(pending.tabId, pending.requestId);
  }

  /* Activates the tab a notification named, foregrounding it over whatever
     tab was last active — the deferred-item-B fix: previously a tapped
     notification only foregrounded the app onto the last-active tab.

     "Reload if stale" here means: a tab this client doesn't currently have
     mounted (closed on this device, or opened for the first time from a
     notification about a chat that lives only on the Mac) is fetched fresh
     via persistence.loadTab (GET /tabs/:id, reopening a closed one if
     needed) and mounted. An ALREADY-mounted tab is deliberately not torn
     down and rebuilt here: TabState.pendingApprovals is excluded from the
     persisted/re-fetched shape by design (Persistence.ts — it is
     runtime-only, repopulated solely by live control_request events), so
     remounting an in-progress tab from a fresh GET would silently drop a
     genuinely still-pending approval's card instead of preserving it. The
     socket's own reconnect — already triggered on every foreground via the
     `resume` dispatch, independently of this method, subscribing `tabs:
     "all"` with each tab's own cursor — is what catches an already-mounted
     tab back up on whatever it missed while backgrounded. */
  private switchTabSeq = 0;
  async switchTab(tabId: string, requestId?: string): Promise<void> {
    if (!tabId) return;
    /* Two notification taps in quick succession can overlap in loadTab;
       the last tap wins, so an older in-flight switch must not select. */
    const token = ++this.switchTabSeq;
    let controller = this.tabs.find(t => t.state.id === tabId);
    if (!controller) {
      this.storage.invalidateTab(tabId);
      const state = await this.persistence.loadTab(tabId);
      if (token !== this.switchTabSeq) return;
      if (!state) {
        platform.notify("That chat is no longer on the gateway.");
        return;
      }
      controller = this.tabs.find(t => t.state.id === tabId) ?? this.mountTab(state, { silent: false });
    }
    if (token !== this.switchTabSeq) return;
    this.selectTab(controller.state.id);
    if (requestId) this.scrollToApprovalCard(requestId);
  }

  /* There is no per-card requestId in the DOM (ApprovalModal.ts's cards are
     keyed only in an in-memory Map, not src/view's to fork for this) so this
     targets the approval area's most recently added card, which is correct
     for the overwhelmingly common case of one outstanding approval per tab.
     Retries briefly: the card the notification named may not have re-arrived
     yet (the socket's replay is async and can land after this runs), and an
     already-resolved approval simply has no card to scroll to — that is a
     normal outcome, not a failure, so this gives up quietly. */
  private scrollToApprovalCard(requestId: string, attemptsLeft = 20): void {
    if (!requestId) return;
    const contents = Array.from(this.tabsContainer.querySelectorAll<HTMLElement>(".claudian-tab-content"));
    const visible = contents.find(el => el.style.display !== "none");
    const cards = visible?.querySelectorAll<HTMLElement>(".claudian-approval-area .claudian-ask-approval-info");
    const card = cards && cards.length > 0 ? cards[cards.length - 1] : null;
    if (card) {
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (attemptsLeft <= 0) return;
    window.setTimeout(() => this.scrollToApprovalCard(requestId, attemptsLeft - 1), 200);
  }

  /* Drains the active tab's composer debounce right now, without hiding it —
     called from renderer.ts's app-backgrounding path (native `suspend`, and
     the `pagehide` fallback) right before the socket suspends. A hidden tab
     already flushed its own draft when the user switched away from it
     (TabController.hide()); the active tab is the only one that can still
     have unflushed text sitting behind InputBox's 500ms debounce at the
     moment the app backgrounds. */
  flushActiveDraft(): void {
    this.tabs.find(t => t.state.id === this.activeTabId)?.flushDraft();
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
