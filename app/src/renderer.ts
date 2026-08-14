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
import { installDomHelpers } from "./dom-polyfill";
import { DesktopPlatform } from "./desktop-platform";
import { initializePlatform } from "../../src/platform";
import { StateEmitter } from "../../src/claude/StateEmitter";
import { loadAppConfig, loadDesktopSettings } from "./config";
import { DesktopHost } from "./host";
import { DesktopChatShell } from "./shell";
import { openSettingsModal } from "./settings-modal";

/* Overlay surfaces that own the Escape key while they are up: Agent A's modal
   and suggest hosts (Obsidian's structural class names, so styles.css maps)
   and the context-menu popup. */
const OVERLAY_SELECTOR = ".modal-container, .prompt, .claudesk-menu";

function overlayOpen(): boolean {
  return document.querySelector(OVERLAY_SELECTOR) !== null;
}

/* Whole-window Finder drop target. The shared code already handles drops over
   the chat area (TabController's root zone -> InputBox attach pipeline, with
   webUtils.getPathForFile covering Electron 32+'s File.path removal); this
   document-level layer covers the strips that zone never sees (header, tab
   bar) and, critically, cancels the default for any file drop nothing
   consumed — without that Electron navigates the panel to the dropped
   file:// URL and wedges the renderer. Bubble phase, so the deeper handlers
   run first and mark what they consumed via defaultPrevented. File drags
   only: text drags keep their native behavior. */
function wireDragAndDrop(shell: DesktopChatShell): void {
  const hasFiles = (e: DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");
  document.addEventListener("dragover", (e) => {
    if (!e.defaultPrevented && hasFiles(e)) e.preventDefault();
  });
  document.addEventListener("drop", (e) => {
    if (e.defaultPrevented || !hasFiles(e)) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length > 0) shell.ingestDroppedFiles(files);
  });
}

function wireKeyboard(shell: DesktopChatShell, openSettings: () => void): void {
  /* Bubble phase on window, so every inner handler has already run and
     `defaultPrevented` reliably tells us whether one of them claimed the key
     (InputBox consumes Escape for its suggestion popup and for cancelling a
     streaming turn; SearchBar consumes it to close). */
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      if (e.defaultPrevented) return;
      /* A modal, suggest popup, or context menu handles its own dismissal. */
      if (overlayOpen()) return;
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
      } else if (e.key === ",") {
        /* macOS convention for Preferences, and the only settings affordance
           reachable while the shell is showing the already-open placeholder. */
        e.preventDefault();
        openSettings();
      }
    }
  });

  /* Main sends this after every show(). Focusing here (rather than on
     window focus) keeps the panel behaving like Spotlight: hotkey, type. */
  ipcRenderer.on("claudesk:shown", () => {
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

  try {
    installDomHelpers();

    const config = await loadAppConfig();
    const baseDir = config.workingDir;

    initializePlatform(new DesktopPlatform({ baseDir }));

    const settings = await loadDesktopSettings();
    const host = new DesktopHost(baseDir, settings);

    /* Best-effort: a read failure leaves every server enabled rather than
       blocking the launch. */
    await host.refreshMcpDenyPatterns();
    host.refreshSkillCatalog();
    host.refreshSubagentCatalog();

    /* TC001 status display: configure from persisted settings and emit idle
       once at load. No network calls unless the integration is toggled on. */
    StateEmitter.configure(settings.tc001Enabled, settings.tc001Ip);
    if (settings.tc001Enabled) StateEmitter.setState("idle");

    const openSettings = (activeHotkey?: string) => openSettingsModal(host, activeHotkey);

    const shell = new DesktopChatShell(mount, host);
    /* Set before mount(): the shell only adds its header buttons when a
       handler exists, and the header is built during mount. */
    shell.onOpenSettings = () => openSettings();
    shell.onResetPosition = () => ipcRenderer.send("claudesk:reset-position");
    await shell.mount();
    wireKeyboard(shell, () => openSettings());
    wireSettingsChannel(openSettings);
    wireDragAndDrop(shell);

    /* Quit-time teardown. The renderer stays alive across hide/show (processes
       and tabs stay warm), so this only fires on a real quit — at which point
       only synchronous work completes. */
    window.addEventListener("beforeunload", () => shell.shutdownSync());
  } catch (err) {
    console.error("[claude-quick-chat] boot failed:", err);
    renderBootFailure(mount, err);
  }
}

void boot();
