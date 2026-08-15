/* DesktopChatShell — the standalone shell's port of src/view/ClaudeChatView.

   Everything below is ClaudeChatView minus ItemView: same composition
   (renderHeader -> nav row with TabBar -> tabs container -> one TabController
   per tab), same tab lifecycle, same restore flow, and the same window.lock
   protocol ported token-for-token — but pointed at the app's OWN store under
   .claude-cli-chat/desktop/. The app and the Obsidian plugin keep disjoint
   tab stores and locks, so they run concurrently; this lock only guards the
   desktop store against a stale/duplicate copy of the app itself.

   Deliberate divergences, all of them forced by the host:
   - `new Notice(...)` -> `platform.notify(...)` (no obsidian).
   - SnippetPicker -> DesktopSnippetPicker (the shared one extends
     obsidian.SuggestModal and is Obsidian-only).
   - The placeholder names the holder as "another Claude window (Obsidian?)"
     and offers a Retry button, since the other holder is usually a different
     application here rather than a second Obsidian leaf.
   - Remote Control is stubbed: the PTY-proxied flow is still driven from the
     plugin.
   - Keyboard/IPC wiring lives in renderer.ts (electron is the renderer entry's
     concern); this class exposes the command targets it drives. */

import { unlinkSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { platform } from "../../src/platform";
import { renderHeader } from "../../src/view/Header";
import { TabBar, type TabBadgeState } from "../../src/view/TabBar";
import { TabController } from "../../src/view/TabController";
import { StateEmitter } from "../../src/claude/StateEmitter";
import { HistoryModal } from "../../src/view/HistoryModal";
import { MCPManagerModal } from "../../src/view/MCPManagerModal";
import { makeTabState, type TabState } from "../../src/view/state";
import { DESKTOP_SETTINGS_PATH } from "./config";
import { DesktopSnippetPicker } from "./snippet-picker";
import type { DesktopHost } from "./host";

/* Working-dir-relative path for the multi-window lock file. Each shell writes
   a unique instance token (`<pid>:<uuid>`) here on mount and removes it on
   teardown. A second window opening sees the lock, verifies the holder PID is
   still alive, and renders an "already open" notice instead of restoring tabs.
   The token (rather than a bare PID) lets us tell two shells in the SAME
   process apart, so one teardown can't delete a lock another legitimately
   holds.

   DELIBERATELY NOT the plugin's `.claude-cli-chat/window.lock`: since
   2026-08-14 the desktop app keeps its whole tab store (tabs.json,
   conversations/, lock) under the `desktop/` subdirectory, so the app and the
   Obsidian plugin own disjoint files and are free to run at the same time.
   This lock only guards against a second copy of the DESKTOP shell (a stale
   crashed instance; live double-launch is already prevented by Electron's
   single-instance lock). DESKTOP_STORE_DIR must match the Persistence dir in
   host.ts. */
const DESKTOP_STORE_DIR = ".claude-cli-chat/desktop";
const WINDOW_LOCK_DIR = DESKTOP_STORE_DIR;
const WINDOW_LOCK_PATH = `${WINDOW_LOCK_DIR}/window.lock`;

/* Process-local guard, mirroring ClaudeChatView's. One renderer could in
   principle mount two shells (a future split view, a hot reload that leaks the
   old instance); both would share a PID, so the on-disk lock provides no
   protection between them. Only the first shell in a process restores tabs and
   holds the lock. */
let activeShellInstance: DesktopChatShell | null = null;

/* 128-bit random id via crypto.randomUUID where available, falling back to
   Math.random so the app still starts if the API is missing. Mirrors
   ClaudeChatView's local helper. */
function makeInstanceId(): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export class DesktopChatShell {
  /* Set by renderer.ts before mount(). Absent means "no settings affordance",
     which is what keeps this class free of any modal it doesn't own. */
  onOpenSettings?: () => void;
  /* Set by renderer.ts before mount(): asks the main process to clear the
     pinned panel bounds and return to the default placement. */
  onResetPosition?: () => void;

  private readonly host: DesktopHost;
  private readonly root: HTMLElement;
  private tabs: TabController[] = [];
  private activeTabId: string | null = null;
  private tabBar!: TabBar;
  private tabsContainer!: HTMLElement;
  /* True when this shell holds the on-disk lock. Placeholder mounts never set
     it, so their teardown is a no-op. */
  private holdingLock = false;
  /* Unique per-shell lock payload: `<pid>:<uuid>`. */
  private readonly instanceToken = `${process.pid}:${makeInstanceId()}`;
  /* Set by whichever teardown ran first. The quit path runs destroy() over
     IPC and THEN unloads the page, so beforeunload's shutdownSync() would
     otherwise re-run the whole disposal against already-torn-down objects. */
  private torndown = false;

  constructor(root: HTMLElement, host: DesktopHost) {
    this.root = root;
    this.host = host;
  }

  /* Mount (or re-mount, from the placeholder's Retry) the whole UI. Mirrors
     ClaudeChatView.onOpen, including the order: lock check FIRST, before any
     UI exists, so a blocked shell never builds a header it has to tear down. */
  async mount(): Promise<void> {
    this.root.empty();
    this.root.addClass("claudian-container");
    this.root.setAttribute("data-provider", "claude");

    const lockHolder = await this.checkWindowLock();
    if (lockHolder !== null) {
      this.renderAlreadyOpenPlaceholder(lockHolder);
      return;
    }
    /* Foreign-process check passed; now guard against a SECOND shell in OUR
       process. The on-disk lock can't catch that case — both share the PID. */
    if (activeShellInstance && activeShellInstance !== this) {
      this.renderAlreadyOpenPlaceholder(process.pid);
      return;
    }
    activeShellInstance = this;
    await this.acquireWindowLock();

    const header = renderHeader(this.root, {
      onNewTab: () => this.createTab(),
      onClear: () => this.clearActiveTab(),
      onHistory: () => this.showHistory(),
      onSnippets: () => this.showSnippetPicker(),
      onMcp: () => this.showMcpManager(),
      onToggleRemoteControl: () => this.toggleRemoteControl(),
    });
    this.mountSettingsButton(header);

    const navRow = this.root.createDiv({ cls: "claudian-input-nav-row" });
    this.tabBar = new TabBar(navRow, {
      onSelect: (id) => this.selectTab(id),
      onClose: (id) => void this.closeTab(id),
      onNew: () => this.createTab(),
    });

    this.tabsContainer = this.root.createDiv({ cls: "claudian-tab-content-container" });

    await this.restoreTabs();
  }

  /* The shared header's callback set is fixed in src/view/Header.ts, and src/
     is frozen, so the shell's own affordance is appended to the actions row
     after the fact rather than threaded through renderHeader. Same element
     shape and classes as the buttons Header builds, so styles.css covers it. */
  private mountSettingsButton(header: HTMLElement): void {
    const actions = header.querySelector<HTMLElement>(".claudian-header-actions");
    if (!actions) return;
    /* Reset sits left of the gear, matching the tray's Reset Window
       Position item so the fix for a mispinned window is one click away. */
    if (this.onResetPosition) {
      const reset = actions.createSpan({
        cls: "claudian-header-btn",
        attr: { "aria-label": "Reset window position", title: "Reset window position" },
      });
      platform.setIcon(reset, "locate-fixed");
      reset.addEventListener("click", () => this.onResetPosition?.());
    }
    if (this.onOpenSettings) {
      const btn = actions.createSpan({
        cls: "claudian-header-btn",
        attr: { "aria-label": "Settings", title: "Settings" },
      });
      platform.setIcon(btn, "settings");
      btn.addEventListener("click", () => this.onOpenSettings?.());
    }
  }

  /* ----- window lock ---------------------------------------------------- */

  /* Returns the PID of the live window currently holding the lock, or null if
     no live holder exists (lock missing, stale, or unreadable). */
  private async checkWindowLock(): Promise<number | null> {
    try {
      if (!(await platform.storage.exists(WINDOW_LOCK_PATH))) return null;
      const raw = (await platform.storage.read(WINDOW_LOCK_PATH)).trim();
      /* Lock payload is `<pid>:<uuid>`. Parse the PID off the front; older
         locks may be a bare PID, which parseInt still reads correctly. */
      const pid = parseInt(raw, 10);
      if (!Number.isFinite(pid) || pid <= 0) return null;
      /* A lock we wrote ourselves (exact token match) means this same shell is
         re-mounting — treat as no foreign holder. */
      if (raw === this.instanceToken) return null;
      if (pid === process.pid) {
        /* Same PID, different token: a second shell in our own process. The
           singleton gate already blocks that path, but treat it as held here
           too so the on-disk lock can't be silently overwritten if the gate is
           ever bypassed. */
        return pid;
      }
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
    try {
      if (!(await platform.storage.exists(WINDOW_LOCK_DIR))) {
        await platform.storage.mkdir(WINDOW_LOCK_DIR);
      }
      await platform.storage.write(WINDOW_LOCK_PATH, this.instanceToken);
      this.holdingLock = true;
    } catch (err) {
      console.warn("[claude-quick-chat] failed to acquire window lock:", err);
    }
  }

  private async releaseWindowLock(): Promise<void> {
    if (!this.holdingLock) return;
    this.holdingLock = false;
    try {
      if (await platform.storage.exists(WINDOW_LOCK_PATH)) {
        const raw = (await platform.storage.read(WINDOW_LOCK_PATH)).trim();
        /* Only remove the lock if the stored token is EXACTLY ours — otherwise
           we'd clobber a lock another holder legitimately took after we
           dropped ours. A bare PID check would match a same-process sibling. */
        if (raw === this.instanceToken) {
          await platform.storage.remove(WINDOW_LOCK_PATH);
        }
      }
    } catch (err) {
      console.warn("[claude-quick-chat] failed to release window lock:", err);
    }
  }

  /* Synchronous counterpart for beforeunload, where no promise resolves. Same
     token check, node fs instead of the async storage adapter. Leaving a stale
     lock behind is recoverable (the next launch's live-PID probe clears it),
     but only after the user has seen a spurious placeholder, so it is worth
     the direct fs call on the quit path. */
  private releaseWindowLockSync(): void {
    if (!this.holdingLock) return;
    this.holdingLock = false;
    const base = platform.storage.basePath();
    if (base === null) return;
    const abs = join(base, WINDOW_LOCK_PATH);
    try {
      if (!existsSync(abs)) return;
      if (readFileSync(abs, "utf8").trim() !== this.instanceToken) return;
      unlinkSync(abs);
    } catch {
      /* best-effort — a stale lock self-heals on the next live-PID probe */
    }
  }

  private renderAlreadyOpenPlaceholder(holderPid: number): void {
    const wrap = this.root.createDiv({ cls: "claudian-multi-window-block" });
    /* Inline, exactly as ClaudeChatView does it: styles.css has no rule for
       this block, so the placeholder has to carry its own layout. */
    wrap.style.padding = "2em";
    wrap.style.textAlign = "center";
    wrap.createEl("h3", { text: "Claude Quick Chat is already running" });
    wrap.createEl("p", {
      text: `Another copy of this app (pid ${holderPid}) holds the desktop tab store. ` +
            "This usually means a crashed instance left a stale lock behind or the app " +
            "was launched twice. Quit the other copy (or let the stale lock age out) and retry. " +
            "Obsidian's Claude view is unaffected — it has its own tab store and can run alongside this app.",
    });
    const retry = wrap.createEl("button", { cls: "claudesk-retry-btn", text: "Retry" });
    retry.style.marginTop = "1em";
    retry.addEventListener("click", () => {
      /* Re-runs the full mount, lock check included. If the other holder has
         since quit, this is the path that gets the user a working panel
         without restarting the app. */
      void this.mount();
    });
  }

  /* ----- tab lifecycle -------------------------------------------------- */

  private async restoreTabs(): Promise<void> {
    const index = await this.host.persistence.loadIndex();
    if (!index || index.tabs.length === 0) {
      this.createTab();
      return;
    }
    /* Bypass per-tab saveIndex writes during the restore loop — each
       createTab + selectTab pair would otherwise trigger TWO index writes per
       restored tab. One write at the very end instead. */
    for (const entry of index.tabs) {
      const state = await this.host.persistence.loadTab(entry.id);
      this.createTab(state ?? undefined, { skipSave: true });
    }
    if (index.activeTabId && this.tabs.some(t => t.state.id === index.activeTabId)) {
      this.selectTab(index.activeTabId, { skipSave: true });
    }
    this.saveIndex();
  }

  private saveIndex(): Promise<void> {
    /* Don't let an incognito tab's id leak into the index as activeTabId — it
       isn't in the persisted tabs list, so persist null rather than a dangling
       reference. */
    const activeTab = this.tabs.find(t => t.state.id === this.activeTabId);
    const activeTabId = activeTab && !activeTab.state.incognito ? this.activeTabId : null;
    const index = {
      activeTabId,
      /* Incognito tabs are excluded so they never reach tabs.json and thus
         never restore on reload. */
      tabs: this.tabs
        .filter(t => !t.state.incognito)
        .map(t => ({
          id: t.state.id,
          title: t.state.title,
          sessionId: t.state.sessionId,
        })),
    };
    /* Dedupe lives inside persistence.saveIndex (content compare that reverts
       on write failure); no second cache here. */
    return this.host.persistence.saveIndex(index).catch(err => {
      console.warn("[claude-quick-chat] index write failed", err);
    });
  }

  private createTab(state?: TabState, opts: { skipSave?: boolean; incognito?: boolean } = {}): void {
    const controller = new TabController(
      this.host,
      this.tabsContainer,
      /* The RenderLifecycle is opaque to shared code and ignored by
         DesktopPlatform.renderMarkdown; passing the shell keeps the ownership
         story ("the mounting surface owns the render") intact. */
      this,
      state ?? makeTabState({ incognito: opts.incognito }),
      () => {
        /* Late async continuations (title-gen, renderer chains) can fire this
           after closeTab destroyed the controller and deleted its files —
           writing here would resurrect them. */
        if (controller.isDestroyed()) return;
        this.renderTabBar();
        /* saveIndex() self-filters incognito tabs, so it stays safe to call
           unconditionally. */
        if (!controller.state.incognito) {
          this.host.persistence.scheduleSaveTab(controller.state);
        }
        this.saveIndex();
      },
    );
    controller.onForkRequest = (src, messageId) => this.forkFromMessage(src, messageId);
    controller.onIncognitoToggle = (tabId, incognito) => void this.onIncognitoToggle(tabId, incognito);
    this.tabs.push(controller);
    this.selectTab(controller.state.id, { skipSave: true });
    if (!opts.skipSave) {
      this.saveIndex();
      /* Tabs created with pre-populated history (fork, History-modal reopen)
         carry messages no streaming event will reproduce. saveIndex only
         writes the index entry; without an explicit body write, a reload
         before the first interaction drops the carried history. */
      if (!controller.state.incognito && controller.state.messages.length > 0) {
        this.host.persistence.scheduleSaveTab(controller.state);
      }
      /* User-initiated new tab (or fork). Reset the TC001 to "ready" so a
         lingering "thinking" / "needs_permission" from another tab doesn't
         carry over. skipSave marks the restore path, where the device keeps
         whatever StateEmitter already emitted. */
      StateEmitter.setState("ready");
    }
  }

  /* Create a new tab whose state is the source tab's history truncated at and
     including `messageId`. The fork gets a fresh tab id and *no* sessionId —
     the next message spawns a brand new session, so the fork is independent of
     the source from then on. */
  private forkFromMessage(source: TabController, messageId: string): void {
    const idx = source.state.messages.findIndex(m => m.id === messageId);
    if (idx === -1) {
      platform.notify("Couldn't find message to fork from.");
      return;
    }
    /* Deep-clone the carried history: slice() alone aliases the live message
       and toolCall objects, so a source turn still streaming would keep
       mutating the fork's state after the branch. Clear streaming flags and
       settle still-running tools — no stream feeds the fork, so those would
       shimmer/spin forever. */
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
      /* Carry the model/effort/mode/snippet so the fork starts in the same
         context as where it branched. Incognito MUST carry too — a plain fork
         of an incognito tab would persist the whole private conversation and
         respawn without --no-session-persistence. */
      incognito: source.state.incognito,
      model: source.state.model,
      effort: source.state.effort,
      permissionMode: source.state.permissionMode,
      envSnippetId: source.state.envSnippetId,
      voiceEnabled: source.state.voiceEnabled,
    };
    this.createTab(forkState);
    /* Be explicit about the semantics: the UI carries history but the new tab
       spawns a fresh Claude session (no --resume), so the model itself has no
       memory of the prior conversation. */
    platform.notify(
      `Forked into new tab. ${truncated.length} messages carried for reference — the new session starts fresh.`,
      6000,
    );
  }

  private selectTab(tabId: string, opts: { skipSave?: boolean } = {}): void {
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
    /* Snapshot busy state before destroy(): a tab closed mid-stream leaves
       StateEmitter asserting "thinking" (it never reached the result event
       that resets to "ready"), orphaning the TC001 heartbeat. */
    const wasBusy = removed.isBusy();
    /* Await destroy() so the subprocess SIGTERM handshake finishes before we
       move on — otherwise children leak as PPID=1 orphans. */
    await removed.destroy();
    /* Incognito tabs have nothing on disk. For the rest, drop the index entry
       FIRST, then the files, awaiting both: a crash between the two leaves an
       orphaned conversation file (harmless) instead of a dangling index entry
       that restores as a phantom blank tab. */
    if (!removed.state.incognito) {
      await this.saveIndex();
      await this.host.persistence.deleteTab(tabId);
    }
    /* Clear the orphaned "thinking" heartbeat back to "ready", but only when
       no surviving tab is itself busy. */
    if (wasBusy && !this.tabs.some(t => t.isBusy())) {
      StateEmitter.setState("ready");
    }
    if (this.tabs.length === 0) {
      this.createTab();
    } else if (this.activeTabId === tabId) {
      /* `idx` was captured before the await; another close finishing during
         destroy() can shrink the array, so clamp before indexing. */
      const fallback = this.tabs[Math.min(Math.max(0, idx - 1), this.tabs.length - 1)];
      if (fallback) this.selectTab(fallback.state.id);
    } else {
      this.renderTabBar();
    }
    this.saveIndex();
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

  /* Reconcile disk when a still-empty tab toggles incognito. Turning ON
     deletes any file written while it was a normal empty tab; turning OFF
     resumes normal persistence. saveIndex() re-derives the filtered index
     either way. */
  private async onIncognitoToggle(tabId: string, incognito: boolean): Promise<void> {
    const tab = this.tabs.find(t => t.state.id === tabId);
    this.renderTabBar();
    if (incognito) {
      /* Same ordering as closeTab: rewrite the index (which now filters this
         tab out) BEFORE removing its files. */
      await this.saveIndex();
      await this.host.persistence.deleteTab(tabId);
    } else {
      if (tab) this.host.persistence.scheduleSaveTab(tab.state);
      await this.saveIndex();
    }
  }

  /* ----- header actions ------------------------------------------------- */

  private clearActiveTab(): void {
    const active = this.tabs.find(t => t.state.id === this.activeTabId);
    if (active) void active.clear();
  }

  private showMcpManager(): void {
    new MCPManagerModal(null, this.host, () => {
      /* Servers may have been toggled while the modal was open, so the active
         tab's cost-surface pill can be stale. */
      const active = this.tabs.find(t => t.state.id === this.activeTabId);
      if (active) void active.refreshCostSurface();
    }).open();
  }

  private showSnippetPicker(): void {
    const active = this.tabs.find(t => t.state.id === this.activeTabId);
    if (!active) return;
    const snippets = this.host.settings.envSnippets;
    if (snippets.length === 0) {
      /* Not "the plugin's settings": that store is the vault's Obsidian-managed
         data.json, which this app never reads. The app's settings live in its
         own file and its modal has no snippet editor, so the only path that
         actually populates this list is a hand edit of that file. Name it. */
      platform.notify(
        `No environment snippets yet. Add them under "envSnippets" in ` +
          `${this.host.getVaultPath()}/${DESKTOP_SETTINGS_PATH}, then relaunch.`,
        8000,
      );
      return;
    }
    new DesktopSnippetPicker(snippets, active.getAppliedSnippetId(), choice => {
      if (choice === "__clear__") {
        active.clearSnippet();
        platform.notify("Cleared environment snippet from this tab.");
      } else {
        active.applySnippet(choice);
        platform.notify(`Applied snippet: ${choice.name}`);
      }
    }).open();
  }

  private showHistory(): void {
    new HistoryModal(null, this.host.persistence, async (conversationId) => {
      const existing = this.tabs.find(t => t.state.id === conversationId);
      if (existing) {
        this.selectTab(existing.state.id);
        return;
      }
      const state = await this.host.persistence.loadTab(conversationId);
      if (state) this.createTab(state);
    }).open();
  }

  /* Remote Control drives a PTY-proxied `claude remote-control` through an
     inline Python pty.fork(), pairing card and all. It is wired to the
     plugin's lifecycle rather than to TabController alone, so the shell
     declines instead of half-starting it. */
  private toggleRemoteControl(): void {
    platform.notify("Remote Control: use the Obsidian plugin");
  }

  /* ----- command targets (renderer.ts drives these) --------------------- */

  newTab(): void {
    if (!this.tabsContainer) return;
    this.createTab();
  }

  closeActiveTab(): void {
    if (this.activeTabId) void this.closeTab(this.activeTabId);
  }

  nextTab(): void {
    if (this.tabs.length < 2) return;
    const idx = this.tabs.findIndex(t => t.state.id === this.activeTabId);
    const next = this.tabs[(idx + 1) % this.tabs.length];
    this.selectTab(next.state.id);
  }

  prevTab(): void {
    if (this.tabs.length < 2) return;
    const idx = this.tabs.findIndex(t => t.state.id === this.activeTabId);
    const prev = this.tabs[(idx - 1 + this.tabs.length) % this.tabs.length];
    this.selectTab(prev.state.id);
  }

  /* Window-level Finder-drop fallback: renderer.ts forwards file drops that
     landed outside the active tab's DOM (header, tab bar). The tab root's
     own drop zone consumes drops over the chat area first and marks them
     defaultPrevented, so nothing arrives here twice. */
  ingestDroppedFiles(files: File[]): void {
    const active = this.tabs.find(t => t.state.id === this.activeTabId);
    if (!active) return;
    active.ingestDroppedFiles(files);
    active.focusInput();
  }

  focusActiveInput(): void {
    const active = this.tabs.find(t => t.state.id === this.activeTabId);
    if (active) {
      active.focusInput();
      return;
    }
    /* Placeholder mount, or a mount still in flight: no controller exists, so
       fall back to whatever composer is on screen. */
    this.activeComposer()?.focus();
  }

  /* True when the visible composer holds text. Esc clears the draft instead of
     hiding the panel in that case — losing an unsent message to a stray Esc is
     the one thing a Spotlight-style panel must not do. InputBox exposes focus()
     but no text accessor, and src/ is frozen, so the visible tab's textarea is
     located through the DOM. show()/hide() drive the inline display, which is
     what makes "visible" decidable here. */
  activeInputHasText(): boolean {
    const composer = this.activeComposer();
    return !!composer && composer.value.trim().length > 0;
  }

  private activeComposer(): HTMLTextAreaElement | null {
    const scope: HTMLElement = this.tabsContainer ?? this.root;
    const contents = Array.from(scope.querySelectorAll<HTMLElement>(".claudian-tab-content"));
    const visible = contents.find(el => el.style.display !== "none") ?? null;
    return visible?.querySelector<HTMLTextAreaElement>("textarea.claudian-input") ?? null;
  }

  /* ----- teardown ------------------------------------------------------- */

  /* Mirrors ClaudeChatView.onClose. This is the path the quit handshake takes
     (main holds the quit open on IPC and the renderer awaits this), because
     TabController.destroy() is what deletes an incognito tab's session file —
     the CLI writes an `ai-title` record summarizing the chat there even under
     --no-session-persistence, so skipping it defeats incognito entirely.
     shutdownSync below stays as the crash/force fallback. */
  async destroy(): Promise<void> {
    if (this.torndown) return;
    this.torndown = true;
    await Promise.all(this.tabs.map(t => t.destroy()));
    this.tabs = [];
    /* Surrender the process-local slot only if WE own it — a placeholder shell
       never owned it, and nulling the live owner's slot would let another
       same-process shell restore. */
    if (activeShellInstance === this) activeShellInstance = null;
    await this.releaseWindowLock();
  }

  /* beforeunload path: nothing async completes, so persist what can be
     persisted synchronously and drop the lock with a direct fs call. */
  shutdownSync(): void {
    if (this.torndown) return;
    this.torndown = true;
    if (activeShellInstance === this) activeShellInstance = null;
    this.host.disposeSync();
    this.releaseWindowLockSync();
  }
}
