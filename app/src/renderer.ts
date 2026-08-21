/* Renderer entry for the standalone shell.

   Boot order mirrors ClaudeChatPlugin.onload() exactly:

     installDomHelpers()      (Obsidian's DOM prototype helpers; every view
                               file builds DOM with createDiv/createEl, so this
                               must precede any UI construction)
     resolve config.json      (tells us the working directory)
     initializePlatform()     (BEFORE settings, stores, or any engine code —
                               shared modules reach the host only through this
                               singleton)
     load settings
     construct DesktopHost
     refreshMcpDenyPatterns() (primed before any tab can spawn, so disabled
                               servers are hidden from the very first turn)
     catalogs                 (skills/commands + subagents)
     mount DesktopChatShell into #app

   Electron is confined to this file: the panel's show/hide contract with the
   main process is a shell-entry concern, not something shared code or
   DesktopChatShell should know about. */

import { ipcRenderer } from "electron";
import { stat } from "node:fs/promises";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { installDomHelpers } from "../../src/platform/dom/dom-polyfill";
import { DesktopPlatform } from "./desktop-platform";
import { initializePlatform } from "../../src/platform";
import { StateEmitter } from "../../src/claude/StateEmitter";
import { loadAppConfig, loadDesktopSettings } from "./config";
import { setOverlayFocusFallback } from "../../src/platform/dom/desktop-overlays";
import { setSyncFileWriter } from "../../src/storage/Persistence";
import { DesktopHost } from "./host";
import { DesktopChatShell } from "./shell";
import { openSettingsModal } from "./settings-modal";

/* Overlay surfaces that own the Escape key while they are up: Agent A's modal
   and suggest hosts (Obsidian's structural class names, so styles.css maps),
   the context-menu popup, and InputBox's own toolbar popups (model / effort /
   permission-mode / attach / trusted-folders — .claudian-popup). The last one
   used to be missing, so dismissing a model picker with Esc also hid the
   entire panel. */
const OVERLAY_SELECTOR = ".modal-container, .prompt, .claudesk-menu, .claudian-popup";

function overlayOpen(): boolean {
  return document.querySelector(OVERLAY_SELECTOR) !== null;
}

/* Snapshot of overlayOpen() taken at window CAPTURE, i.e. the very first
   listener in the propagation path. InputBox's popup Escape handler sits on
   document in the BUBBLE phase and removes its popup without calling
   preventDefault, so by the time the bubble handler below runs the popup is
   already gone and a live query would report "no overlay" — and hide the
   panel out from under the user. */
let overlayAtKeydown = false;
window.addEventListener(
  "keydown",
  (e: KeyboardEvent) => {
    if (e.key === "Escape") overlayAtKeydown = overlayOpen();
  },
  true,
);

/* Whole-window Finder drop target. The shared code already handles drops over
   the chat area (TabController's root zone -> InputBox attach pipeline, with
   webUtils.getPathForFile covering Electron 32+'s File.path removal); this
   document-level layer covers the strips that zone never sees (header, tab
   bar) and, critically, cancels the default for any file drop nothing
   consumed — without that Electron navigates the panel to the dropped
   file:// URL and wedges the renderer. Bubble phase, so the deeper handlers
   run first and mark what they consumed via defaultPrevented.

   URL drags (a link out of Safari, a bookmark, a .webloc) carry
   "text/uri-list" but no "Files", so the file gate never engaged for them and
   Chromium ran its default action instead: navigate the frame to the dropped
   URL. Main's will-navigate guard is the real backstop, but it turns such a
   drop into "open it in the browser", which is not what dropping something on
   a chat panel should mean — so those are swallowed here, except over an
   editable field where a native text drop is the useful behavior. */
function wireDragAndDrop(shell: DesktopChatShell): void {
  const types = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []);
  const hasFiles = (e: DragEvent) => types(e).includes("Files");
  const hasUri = (e: DragEvent) => types(e).includes("text/uri-list");
  const isEditable = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement);

  document.addEventListener("dragover", (e) => {
    if (e.defaultPrevented) return;
    if (hasFiles(e) || (hasUri(e) && !isEditable(e.target))) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (e.defaultPrevented) return;
    if (hasFiles(e)) {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) shell.ingestDroppedFiles(files);
      return;
    }
    if (hasUri(e) && !isEditable(e.target)) e.preventDefault();
  });
}

/* Cmd+, is registered on its own, BEFORE the heavy async boot work, so the
   settings modal stays reachable even when boot bails out early (a working
   directory that no longer exists). macOS convention for Preferences, and the
   only settings affordance reachable while the shell shows a placeholder. */
function wireSettingsShortcut(openSettings: () => void): void {
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "," || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    e.preventDefault();
    openSettings();
  });
}

function wireKeyboard(shell: DesktopChatShell): void {
  /* Bubble phase on window, so every inner handler has already run and
     `defaultPrevented` reliably tells us whether one of them claimed the key
     (InputBox consumes Escape for its suggestion popup and for cancelling a
     streaming turn; SearchBar consumes it to close). */
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (e.defaultPrevented) return;
      /* A modal, suggest popup, or context menu handles its own dismissal.
         Read from the capture-phase snapshot, not a live query: a popup that
         tore itself down on this same keystroke would otherwise look absent. */
      if (overlayAtKeydown) return;
      /* Never let a stray Escape throw away an unsent draft — the panel is a
         one-keystroke-away surface, so hiding it with text in the composer
         would be the easiest way to lose a message. */
      if (shell.activeInputHasText()) return;
      ipcRenderer.send("claudesk:hide");
      return;
    }

    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      /* Cmd+W closes the TAB, never the window: the panel is resident and only
         the tray's Quit ends the process. */
      if (e.key === "t") {
        e.preventDefault();
        shell.newTab();
      } else if (e.key === "w") {
        e.preventDefault();
        shell.closeActiveTab();
      }
    }
  });

  /* Main sends this after every show(). Focusing here (rather than on
     window focus) keeps the panel behaving like Spotlight: hotkey, type.
     A show with a modal already up (tray → Settings… while the modal is
     open, or any hide/show cycle) must NOT pull focus down to the composer
     behind the backdrop, where the user cannot see what they are typing. */
  ipcRenderer.on("claudesk:shown", () => {
    /* Topmost, not first: MCPManagerModal stacks an edit modal over itself. */
    const stack = document.body.querySelectorAll<HTMLElement>(":scope > .modal-container");
    const top = stack[stack.length - 1];
    if (top) {
      (top.querySelector<HTMLElement>(".prompt-input") ?? top.querySelector<HTMLElement>(".modal"))?.focus();
      return;
    }
    /* A context menu or composer popup is up: leave focus where it is. */
    if (overlayOpen()) return;
    shell.focusActiveInput();
  });
}

/* Tray -> "Settings…". Main shows the panel first and rides the accelerator it
   currently has registered along with the message, which can differ from
   config.json's value when a configured hotkey failed to bind. */
function wireSettingsChannel(open: (activeHotkey?: string) => void): void {
  ipcRenderer.on("claudesk:open-settings", (_event, payload: unknown) => {
    const hotkey =
      payload !== null && typeof payload === "object"
        ? (payload as { activeHotkey?: unknown }).activeHotkey
        : undefined;
    open(typeof hotkey === "string" ? hotkey : undefined);
  });
}

/* A configured working directory that no longer resolves to a folder is NOT
   treated as a boot failure: NodeFileStorage mkdirs the whole parent chain on
   its first write, so booting normally would conjure
   `<bad-path>/.claude-cli-chat/desktop/` out of nothing, restore zero tabs,
   discover zero skills, and present as total history loss with no error at
   all. Nothing is mounted against the bad path; the banner names it and hands
   the user straight to the field that fixes it. */
function renderMissingWorkingDir(mount: HTMLElement, path: string, openSettings: () => void): void {
  mount.textContent = "";
  const wrap = document.createElement("div");
  wrap.className = "claudesk-boot-error";
  /* Inline, like shell.ts's already-open placeholder: neither stylesheet has a
     rule for this block, so it carries its own layout. */
  wrap.style.padding = "2em";
  wrap.style.textAlign = "center";

  const title = document.createElement("h3");
  title.textContent = "Working directory not found";

  const lead = document.createElement("p");
  lead.textContent = "Claude Quick Chat is configured to run against:";

  const pathEl = document.createElement("code");
  pathEl.textContent = path;
  pathEl.style.display = "block";
  pathEl.style.margin = "0.75em 0";
  pathEl.style.wordBreak = "break-all";

  const detail = document.createElement("p");
  detail.textContent =
    "That folder does not exist — a moved or renamed vault, or a Mac where " +
    "iCloud has not synced it yet. Nothing was created there and no tabs were " +
    "loaded. Point the app at the right folder, then quit and reopen it.";

  const button = document.createElement("button");
  button.className = "claudesk-retry-btn";
  button.textContent = "Open settings";
  button.style.marginTop = "1em";
  button.addEventListener("click", () => openSettings());

  wrap.appendChild(title);
  wrap.appendChild(lead);
  wrap.appendChild(pathEl);
  wrap.appendChild(detail);
  wrap.appendChild(button);
  mount.appendChild(wrap);
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function renderBootFailure(mount: HTMLElement, err: unknown): void {
  /* The panel has no console the user will look at, so a boot failure has to
     be legible in the window itself. Plain DOM: installDomHelpers may be the
     thing that failed. */
  mount.textContent = "";
  const wrap = document.createElement("div");
  wrap.className = "claudesk-boot-error";
  const title = document.createElement("h3");
  title.textContent = "Claude failed to start";
  const detail = document.createElement("pre");
  detail.textContent = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  wrap.appendChild(title);
  wrap.appendChild(detail);
  mount.appendChild(wrap);
}

async function boot(): Promise<void> {
  const mount = document.getElementById("app");
  if (!mount) throw new Error("renderer: #app mount point is missing from index.html");

  /* Quit-time teardown, in two halves.

     beforeunload can only run synchronous work, and shutdownSync never
     destroys the TabControllers — but TabController.destroy() is the only
     thing that deletes an incognito tab's session file, the one the CLI
     still writes an `ai-title` summary into even under
     --no-session-persistence. So the real quit path is main holding the quit
     open on IPC while the awaitable teardown runs here; beforeunload stays
     as the crash/force fallback and is idempotent against it.

     Registered before the try, so EVERY exit from boot() — the early return
     below and the boot-failure catch alike — leaves main a listener to talk
     to instead of waiting out its whole quit timeout. */
  let runTeardown: () => Promise<void> = () => Promise.resolve();
  let teardownStarted = false;
  ipcRenderer.on("claudesk:teardown", () => {
    if (teardownStarted) return;
    teardownStarted = true;
    void runTeardown()
      .catch((err: unknown) => console.warn("[claude-quick-chat] teardown failed:", err))
      .finally(() => ipcRenderer.send("claudesk:teardown-done"));
  });

  try {
    installDomHelpers();

    const config = await loadAppConfig();
    const workingDirOk = await isDirectory(config.workingDir);
    /* Fallback root so the settings modal (and its toasts) have a platform to
       render against. Nothing is written into it: loadDesktopSettings is told
       not to seed, and no store is mounted on this path. */
    const baseDir = workingDirOk ? config.workingDir : homedir();

    initializePlatform(new DesktopPlatform({ baseDir }));
    /* Persistence's quit-time flushSync() needs a synchronous file API; it no
       longer imports node itself so the shared bundle stays browser-safe. */
    setSyncFileWriter({ mkdirSync, renameSync, writeFileSync });

    const settings = await loadDesktopSettings({ seed: workingDirOk });
    const host = new DesktopHost(baseDir, settings);

    const openSettings = (activeHotkey?: string) => openSettingsModal(host, activeHotkey);
    /* Both settings entry points are wired BEFORE the heavy async work, so
       they exist on the recovery path below as well as on the normal one. */
    wireSettingsChannel(openSettings);
    wireSettingsShortcut(() => openSettings());

    if (!workingDirOk) {
      renderMissingWorkingDir(mount, config.workingDir, () => openSettings());
      ipcRenderer.send("claudesk:ready");
      return;
    }

    /* Best-effort: a read failure leaves every server enabled rather than
       blocking the launch. */
    await host.refreshMcpDenyPatterns();
    host.refreshSkillCatalog();
    host.refreshSubagentCatalog();

    /* TC001 status display: configure from persisted settings and emit idle
       once at load. No network calls unless the integration is toggled on. */
    StateEmitter.configure(settings.tc001Enabled, settings.tc001Ip);
    if (settings.tc001Enabled) StateEmitter.setState("idle");

    /* Mirror every spawned child's pid into the main process. Main is the only
       thing that outlives a renderer crash, and beforeunload does not run on
       one — without this, an OOM-killed renderer leaves every `claude` child
       running with PPID 1. */
    host.subprocessManager.onChildPid = (pid, alive) =>
      ipcRenderer.send("claudesk:child-pid", { pid, alive });

    const shell = new DesktopChatShell(mount, host);
    /* Set before mount(): the shell only adds its header buttons when a
       handler exists, and the header is built during mount. */
    shell.onOpenSettings = () => openSettings();
    shell.onResetPosition = () => ipcRenderer.send("claudesk:reset-position");
    await shell.mount();
    /* Overlays hand focus back to the composer when the element they took it
       from is gone (the usual case: the modal was opened from the tray, so
       activeElement was <body>). */
    setOverlayFocusFallback(() => shell.focusActiveInput());
    wireKeyboard(shell);
    wireDragAndDrop(shell);

    /* Order matters: shell.destroy() first (it awaits each TabSession's
       dispose, and the incognito session-file cleanup deliberately runs after
       the child has exited), host.dispose() second (it calls killAll, which
       would otherwise strand that cleanup). */
    runTeardown = async () => {
      try {
        await shell.destroy();
      } catch (err) {
        console.warn("[claude-quick-chat] shell teardown failed:", err);
      }
      await host.dispose();
    };
    window.addEventListener("beforeunload", () => shell.shutdownSync());

    /* Last statement: main queues IPC_SHOWN / IPC_OPEN_SETTINGS until it sees
       this, because webContents.send() into a page with no listener attached
       is dropped silently and the boot above spends seconds on disk. */
    ipcRenderer.send("claudesk:ready");
  } catch (err) {
    console.error("[claude-quick-chat] boot failed:", err);
    renderBootFailure(mount, err);
    /* Report in even here. A failure past wireSettingsChannel leaves the
       settings modal working, and main drops tray → Settings… on the floor
       until it sees this; the teardown listener above is already attached, so
       a quit still answers immediately. */
    ipcRenderer.send("claudesk:ready");
  }
}

void boot();
