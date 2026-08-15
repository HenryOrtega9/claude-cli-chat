/*
 * Electron main process for the standalone "Claude Quick Chat" shell.
 *
 * The app is a resident macOS menu-bar accessory: no dock tile, no visible
 * window until the global hotkey fires. The panel window is created ONCE at
 * startup and is only ever hidden/shown afterwards, never destroyed — the
 * renderer owns live `claude` subprocesses and warm tabs, so tearing the
 * window down would kill them. Every quit path therefore goes through the tray.
 */

import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PANEL_WIDTH = 800;
const PANEL_HEIGHT = 640;
/* Floors keep the chat layout usable — below this the composer toolbar wraps
   into the tab bar. */
const PANEL_MIN_WIDTH = 560;
const PANEL_MIN_HEIGHT = 420;

/* Gap between the panel's bottom edge and the work-area bottom (the work
   area already excludes the Dock). */
const PANEL_BOTTOM_MARGIN = 24;

const DEFAULT_ACCELERATOR = "Alt+Space";

/*
 * Duplicated from app/src/config.ts on purpose. That module is renderer code
 * (it imports src/platform, which is DOM-bound), so main cannot import it —
 * the two copies of these three constants have to be kept in step by hand.
 *
 * Field ownership inside config.json: main writes ONLY "hotkey" and
 * "panelBounds", the renderer writes ONLY "workingDir", and both
 * read-modify-write the whole file so neither erases the other's fields. Main
 * never creates the file; seeding it is the renderer's job (it is the side
 * that knows the default working dir).
 */
const APP_CONFIG_DIR = join(homedir(), "Library", "Application Support", "ClaudeQuickChat");
const APP_CONFIG_PATH = join(APP_CONFIG_DIR, "config.json");

/* main.js lives in app/dist/, index.html one level up in app/. The href form
   is what will-navigate hands us, so it is captured once here rather than
   compared against webContents.getURL() (which is the CURRENT url, so a
   same-url reload would compare equal and slip through) or matched by
   suffix (which would admit any file:// path ending in index.html). */
const INDEX_HTML_PATH = join(__dirname, "..", "index.html");
const INDEX_URL = pathToFileURL(INDEX_HTML_PATH).href;

/* Channel names are a hard contract with the renderer — do not rename. */
const IPC_HIDE = "claudesk:hide";
const IPC_SHOWN = "claudesk:shown";
/* main -> renderer, payload { activeHotkey: string }: open the settings modal.
   The accelerator rides along because main owns the live registration and the
   renderer's config.json copy may be a fallback behind it. */
const IPC_OPEN_SETTINGS = "claudesk:open-settings";
/* renderer -> main (invoke), payload string: try to rebind the global hotkey.
   Answers { ok: boolean, active: string } — `active` is what is registered
   NOW, so a failed attempt still tells the modal what to display. */
const IPC_SET_HOTKEY = "claudesk:set-hotkey";
/* renderer -> main: header button equivalent of the tray's Reset Window
   Position — clear the pinned bounds and return to default placement. */
const IPC_RESET_POSITION = "claudesk:reset-position";
/* renderer -> main: the async boot() finished and its ipcRenderer.on handlers
   are attached. Anything main wants to push at the renderer before this is
   queued — webContents.send() into a page with no listener yet is dropped
   silently, and boot() spends seconds on disk before it registers. */
const IPC_READY = "claudesk:ready";
/* main -> renderer: run the awaitable teardown (tab destroy, which is what
   deletes incognito session files) before the process exits. */
const IPC_TEARDOWN = "claudesk:teardown";
/* renderer -> main: teardown finished; the quit may proceed. */
const IPC_TEARDOWN_DONE = "claudesk:teardown-done";
/* renderer -> main, payload { pid, alive }: mirror of the live `claude` child
   set. Main owns the authoritative copy so it can SIGTERM them if the
   renderer dies without running its own killAll(). */
const IPC_CHILD_PID = "claudesk:child-pid";

/* Longest the quit path waits for the renderer's teardown before exiting
   anyway. Generous enough for a tab destroy that awaits each subprocess's
   SIGTERM handshake, short enough that a wedged renderer cannot hold the
   app open. */
const TEARDOWN_TIMEOUT_MS = 4000;

let panel: BrowserWindow | null = null;
let tray: Tray | null = null;

/* False until the renderer's boot() reports in on IPC_READY; reset whenever
   the page is reloaded. Gates the two pushes that have no retry of their own. */
let rendererReady = false;
let pendingShown = false;
let pendingOpenSettings = false;

/* PIDs of `claude` children the renderer has spawned and not yet reaped. Only
   used on the crash path: a clean quit lets the renderer kill its own. */
const childPids = new Set<number>();

/* Rate-limit for the crash-recovery reload, so a renderer that dies
   deterministically on boot cannot spin. */
let lastRendererCrash = 0;

/* Quit handshake state. `teardownDone` means the renderer has finished (or
   was given up on) and a quit may proceed; `teardownPending` means one is in
   flight, so a second Quit falls through instead of re-preventing. */
let teardownDone = false;
let teardownPending = false;

/* The accelerator currently registered with the OS. Never a guess: every
 * assignment follows a successful globalShortcut.register().
 */
let activeAccelerator = DEFAULT_ACCELERATOR;

type PanelBounds = { x: number; y: number; width: number; height: number };

/* Bounds the user last dragged or edge-resized the panel to, or null while
 * the panel still follows the default cursor-display placement. Persisted as
 * config.json's "panelBounds" so the pin survives restarts.
 */
let userBounds: PanelBounds | null = null;

/* True while positionPanel() applies bounds programmatically. The moved/
 * resized listeners consult it so only human adjustments pin the panel; it is
 * cleared a tick later because Electron may deliver those events after
 * setBounds() returns.
 */
let applyingBounds = false;

let persistBoundsTimer: NodeJS.Timeout | null = null;

/*
 * Distinguishes a real quit (tray → Quit) from the incidental window/app
 * lifecycle events that must NOT terminate the process.
 */
let quitting = false;

/*
 * A second launch of the app just toggles the panel of the first instance.
 * requestSingleInstanceLock() returns false in the *new* process, which exits
 * immediately; the original receives "second-instance".
 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showPanel());
  void app.whenReady().then(onReady);
}

function onReady(): void {
  /* FIRST, before any window exists: Electron installs its own default menu
     whenever the app sets none, and on macOS that menu's key equivalents are
     dispatched by NSMenu before the web page ever sees the keystroke — so the
     renderer's preventDefault() cannot win them back. The default template's
     fileMenu binds Cmd+W to close (which our close handler turns into "hide
     the panel", the opposite of the documented "Cmd+W closes the TAB") and
     viewMenu binds Cmd+R to reload (which runs beforeunload -> killAll and
     SIGTERMs every live `claude` child mid-stream). LSUIElement only hides
     the menu bar; it does not unbind the equivalents.

     appMenu and editMenu are kept deliberately: Cmd+Q lives in appMenu (and
     routes through before-quit, so the teardown handshake still runs), and on
     macOS Cmd+C/X/V/A/Z reach the web contents through editMenu's roles — an
     app with no Edit menu loses clipboard in the composer and the settings
     fields. */
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      ...(app.isPackaged
        ? []
        : [{ label: "Developer", submenu: [{ role: "toggleDevTools" as const }] }]),
    ]),
  );

  /* Accessory app: menu bar only, no dock tile, no app switcher entry. */
  app.dock?.hide();

  /* Registered on the app, not on one window, so any webContents this process
     ever creates inherits the guard. */
  app.on("web-contents-created", (_event, contents) => installNavigationGuards(contents));

  userBounds = readConfiguredBounds();
  createPanel();
  /* Hotkey before the tray: the tray menu labels itself with whatever
     accelerator actually registered, fallback included. */
  registerConfiguredShortcut();
  createTray();

  /* Re-registration guard: shortcuts are process-global and leak on reload. */
  app.on("will-quit", () => globalShortcut.unregisterAll());
}

function createPanel(): void {
  panel = new BrowserWindow({
    width: PANEL_WIDTH,
    height: PANEL_HEIGHT,
    frame: false,
    show: false,
    /*
     * "panel" lets the window float above full-screen spaces and take key
     * focus without stealing the previous app's activation state.
     */
    type: "panel",
    transparent: true,
    backgroundColor: "#00000000",
    /*
     * Frosted-glass translucency (like a menu-bar popover): macOS blurs
     * whatever is behind the window, and desktop.css keeps the big surface
     * fills semi-transparent so the blur shows through. "active" pins the
     * effect on — a non-activating panel reports inactive, which would
     * otherwise gray the vibrancy out. roundedCorners clips the vibrancy
     * layer to the native window shape so no frosted square corners bleed
     * past the CSS radius.
     */
    vibrancy: "under-window",
    visualEffectState: "active",
    roundedCorners: true,
    resizable: true,
    minWidth: PANEL_MIN_WIDTH,
    minHeight: PANEL_MIN_HEIGHT,
    movable: true,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      /* The renderer keeps streaming CLI output while hidden. */
      backgroundThrottling: false,
    },
  });

  /*
   * "floating", NOT "screen-saver": macOS renders drag images at window
   * level ~500 (kCGDraggingWindowLevel), and a screen-saver-level window
   * (1000) sits ABOVE that layer — a Finder drag visibly disappears behind
   * the panel and the drop is never delivered to it. Floating (level 3)
   * stays above normal windows while remaining below the drag layer, which
   * is what makes drag-and-drop into the panel possible at all.
   */
  panel.setAlwaysOnTop(true, "floating");
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  void panel.loadFile(INDEX_HTML_PATH);

  /*
   * Deliberately NO hide-on-blur (dropped 2026-08-14): the panel is a
   * persistent floating companion, so clicking into another app leaves it
   * on screen. Esc and the global hotkey are the dismissal paths.
   */

  /*
   * A user drag or edge-resize pins the panel: its bounds are remembered and
   * every later show restores them instead of re-centering on the cursor's
   * display. "moved"/"resized" also fire for our own positionPanel() call, so
   * a flag suppresses those — only human adjustments count as pinning.
   */
  panel.on("moved", () => rememberUserBounds());
  panel.on("resized", () => rememberUserBounds());

  /*
   * Nothing may destroy the window while the app is alive — the renderer's
   * subprocesses and tab state have to survive a dismissal.
   */
  panel.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    hidePanel();
  });

  /*
   * The window is transparent and never rebuilt, so a dead renderer leaves an
   * invisible empty rectangle that the hotkey and the tray both still "show".
   * Every recovery affordance (settings modal, header buttons, Retry) lives
   * inside the renderer, so without this the only way out is Quit + relaunch.
   * beforeunload does not run on a crash either, which is why the children the
   * dead renderer spawned are reaped here rather than by the renderer.
   */
  panel.webContents.on("render-process-gone", (_event, details) => {
    console.error(`[claudesk] renderer gone: ${details.reason} (${details.exitCode})`);
    rendererReady = false;
    reapChildPids();
    /* A clean exit is the normal quit path, and a quit in progress must not be
       fought with a reload. */
    if (quitting || details.reason === "clean-exit") return;
    const now = Date.now();
    /* Deterministic crash (a bad restored tab, say): reloading would respawn
       the same state forever. Leave the panel dead and let the tray's Reload
       Panel item be the manual escape hatch. */
    if (now - lastRendererCrash < 10_000) {
      console.error("[claudesk] renderer crash loop; not reloading (use tray → Reload Panel)");
      return;
    }
    lastRendererCrash = now;
    reloadPanel();
  });

  panel.on("closed", () => {
    panel = null;
  });
}

/*
 * Nothing in this app is allowed to navigate the panel. The window runs with
 * nodeIntegration and no contextIsolation, so a remote page loaded into it
 * would get `require` — and a top-level navigation also unloads the renderer,
 * firing beforeunload, which SIGTERMs every live `claude` child and drops the
 * window lock. The only route back would be the tray's Reload Panel, i.e. a
 * second full teardown — so the navigation is stopped, not recovered from.
 *
 * Reachable without the guard from three directions: a plain left-click on an
 * anchor `marked` produced from assistant text (gfm autolinks bare URLs), a
 * URL/link dragged onto the panel (Chromium's default action for an
 * unprevented drop is to navigate the frame), and window.open.
 */
function installNavigationGuards(contents: Electron.WebContents): void {
  const block = (event: Electron.Event, url: string): void => {
    /* Not emitted for the programmatic loadFile, but a same-document reload of
       our own page must never be treated as an escape. devtools:// is exempt
       because the guard is registered app-wide and the detached DevTools
       window (dev builds only) navigates within its own scheme. */
    if (url === INDEX_URL || url.startsWith("devtools://")) return;
    event.preventDefault();
    if (isExternallyOpenable(url)) void shell.openExternal(url);
  };
  contents.on("will-navigate", (details, url) => block(details, url));
  /* Electron splits subframe navigation out of will-navigate, so an <iframe
     src> smuggled through rendered markdown needs its own guard — but this
     event ALSO fires for the main frame, so a single link click reaches both
     handlers. Main-frame navigations stay with will-navigate above; running
     block() here too would hand the same URL to shell.openExternal twice and
     open two browser tabs per click. A subframe navigating itself is never a
     user click, so it is stopped without being forwarded anywhere. */
  contents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame) return;
    if (details.url === INDEX_URL || details.url.startsWith("devtools://")) return;
    details.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternallyOpenable(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

/* Whitelist, not blacklist: only these schemes are ever handed to the OS.
   file:, data:, javascript: and custom schemes are dropped outright — an
   href="#" anchor alone resolves to a file:// URL, and openExternal on a
   local path is a code-execution path, not a convenience. */
function isExternallyOpenable(url: string): boolean {
  return /^(?:https?|mailto):/i.test(url);
}

/* SIGTERM whatever `claude` children the renderer told us about. Only used
   when the renderer died without running its own killAll(); on the clean quit
   path the set is already empty by the time this could matter. */
function reapChildPids(): void {
  for (const pid of childPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  childPids.clear();
}

/* The one destructive recovery in the app: it re-runs beforeunload, so any
   live turn is lost. Only worth it when the alternative is a dead panel. */
function reloadPanel(): void {
  if (!panel || panel.webContents.isDestroyed()) return;
  rendererReady = false;
  pendingShown = false;
  pendingOpenSettings = false;
  /* The outgoing page's beforeunload kills its own children, but a reload
     from here may be recovering FROM a page that can no longer run it. */
  reapChildPids();
  panel.reload();
}

/*
 * app/assets/trayTemplate.png (16x16) with its @2x sibling alongside it.
 * nativeImage.createFromPath picks the @2x representation up automatically
 * from the filename convention, so only the 1x path is named here.
 *
 * Layout note: this file builds to app/dist/main.js, so __dirname is app/dist
 * both in the repo and inside the packaged asar (which preserves the same
 * repo-relative layout).
 */
function loadTrayImage(): Electron.NativeImage {
  const image = nativeImage.createFromPath(join(__dirname, "..", "assets", "trayTemplate.png"));
  /*
   * Template images are drawn from their ALPHA channel only, which is what
   * makes the glyph invert correctly between light and dark menu bars (and
   * highlight white when the menu is open).
   */
  if (!image.isEmpty()) image.setTemplateImage(true);
  return image;
}

function createTray(): void {
  const image = loadTrayImage();
  tray = new Tray(image);
  if (image.isEmpty()) {
    /*
     * Missing or unreadable asset. A Tray with neither image nor title is
     * invisible, which would leave the app unreachable, so fall back to the
     * text glyph rather than shipping a blank menu-bar slot.
     */
    console.error("[claudesk] tray image missing; falling back to the text glyph");
    tray.setTitle("✳");
  }
  tray.setToolTip("Claude Quick Chat");

  rebuildTrayMenu();
  /* Left-click the menu-bar item toggles too; right-click opens the menu. */
  tray.on("click", () => togglePanel());
}

/*
 * The menu is rebuilt rather than mutated whenever its labels can change (the
 * hotkey rebinding, the login-item checkbox), because Electron snapshots the
 * template at buildFromTemplate time.
 */
function rebuildTrayMenu(): void {
  if (!tray) return;

  /*
   * Login items registered in dev point at the bare `electron` binary in
   * node_modules, which would "start Claude at login" as an empty Electron
   * shell. Only a packaged build may touch the setting.
   */
  const canSetLoginItem = app.isPackaged;
  const openAtLogin = canSetLoginItem && app.getLoginItemSettings().openAtLogin;

  const menu = Menu.buildFromTemplate([
    {
      label: "Toggle Claude",
      /*
       * Display only: the real binding is the global shortcut. An accelerator
       * here would register a second, menu-scoped binding.
       */
      accelerator: activeAccelerator,
      registerAccelerator: false,
      click: () => togglePanel(),
    },
    {
      label: "Settings…",
      click: () => openSettings(),
    },
    {
      label: "Reset Window Position",
      /* Only meaningful once a drag/resize has pinned the panel. */
      enabled: userBounds !== null,
      click: () => resetPanelPosition(),
    },
    {
      /* The only recovery affordance that survives a dead renderer — every
         other one is drawn by the renderer itself. Destructive to live turns,
         hence the position at the bottom of the group rather than a keystroke. */
      label: "Reload Panel",
      click: () => reloadPanel(),
    },
    { type: "separator" },
    {
      label: canSetLoginItem ? "Start at Login" : "Start at Login (packaged app only)",
      type: "checkbox",
      checked: openAtLogin,
      enabled: canSetLoginItem,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked });
        /* Re-read rather than trust the click: macOS can refuse the change
           (managed login items), and the checkbox must not lie. */
        rebuildTrayMenu();
      },
    },
    { type: "separator" },
    {
      label: "Quit Claude Quick Chat",
      accelerator: "Command+Q",
      registerAccelerator: false,
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

/* ----- global hotkey ---------------------------------------------------- */

/* config.json's "hotkey", or null when absent/unusable. Read synchronously at
   startup: the panel and tray both want the resolved accelerator, and this is
   a single small file read before any window exists. */
function readConfiguredHotkey(): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(APP_CONFIG_PATH, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const hotkey = (parsed as { hotkey?: unknown }).hotkey;
    if (typeof hotkey !== "string") return null;
    const trimmed = hotkey.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    /* Missing on first launch (the renderer seeds the file), unreadable, or
       malformed — all mean "no override". */
    return null;
  }
}

/* Main owns this field. Read-modify-write so the renderer's workingDir — and
   anything a future build adds — survives. */
function writeConfiguredHotkey(hotkey: string): void {
  try {
    let existing: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(APP_CONFIG_PATH, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      /* No file yet: write one carrying just the hotkey. The renderer fills in
         workingDir on its next load, which read-modify-writes this back. */
    }
    existing.hotkey = hotkey;
    writeAppConfigSync(existing);
  } catch (err) {
    console.error("[claudesk] could not persist hotkey to config.json:", err);
  }
}

/*
 * Atomic replace. A bare writeFileSync truncates before it writes, and
 * writeConfiguredBounds runs on a 500 ms debounce off every window drag, so
 * the truncation window is hit routinely — while the recovery path treats an
 * unparseable config.json as "reseed from the hard-coded default working
 * directory". Staged inside APP_CONFIG_DIR because rename is only atomic
 * within one filesystem, and under a pid-suffixed name so main's writer and
 * the renderer's saveWorkingDir cannot collide on the staging path.
 */
function writeAppConfigSync(value: Record<string, unknown>): void {
  const tmp = `${APP_CONFIG_PATH}.${process.pid}.tmp`;
  mkdirSync(APP_CONFIG_DIR, { recursive: true });
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, APP_CONFIG_PATH);
}

/*
 * Bind `accelerator`, replacing whatever is bound now. Returns false without
 * leaving anything registered when the string is malformed (register throws)
 * or the combination is already taken by another app.
 */
function bind(accelerator: string): boolean {
  globalShortcut.unregisterAll();
  try {
    return globalShortcut.register(accelerator, () => togglePanel());
  } catch (err) {
    console.error(`[claudesk] invalid accelerator ${accelerator}:`, err);
    return false;
  }
}

function registerConfiguredShortcut(): void {
  const configured = readConfiguredHotkey();
  if (configured !== null && bind(configured)) {
    activeAccelerator = configured;
    return;
  }
  if (configured !== null) {
    console.error(
      `[claudesk] could not register configured hotkey ${configured} (invalid or already taken); falling back to ${DEFAULT_ACCELERATOR}`,
    );
  }
  if (bind(DEFAULT_ACCELERATOR)) {
    activeAccelerator = DEFAULT_ACCELERATOR;
    return;
  }
  /*
   * Nothing is bound. The tray (click and menu) still reaches the panel, so
   * the app stays usable; the label would be a lie, hence the explicit reset.
   */
  console.error(
    `[claudesk] failed to register global shortcut ${DEFAULT_ACCELERATOR} (already taken?) — use the tray icon`,
  );
  activeAccelerator = DEFAULT_ACCELERATOR;
}

/*
 * Rebind on request from the settings modal. On failure the PREVIOUS binding
 * is restored before answering, so a typo can never leave the user with no
 * hotkey at all, and the answer reports what is actually live.
 */
function applyAccelerator(next: string): { ok: boolean; active: string } {
  const previous = activeAccelerator;
  if (next === previous && globalShortcut.isRegistered(previous)) {
    /* Persist anyway. activeAccelerator and config.json's hotkey legitimately
       disagree after registerConfiguredShortcut() falls back (the stale value
       is deliberately left on disk so the choice comes back if the conflict
       clears). The settings modal seeds its field from the LIVE accelerator,
       so "open Settings, press Apply" is the only way a user can adopt the
       fallback — and without this write it would report success and change
       nothing. writeConfiguredHotkey is an idempotent read-modify-write. */
    writeConfiguredHotkey(next);
    return { ok: true, active: previous };
  }

  if (bind(next)) {
    activeAccelerator = next;
    writeConfiguredHotkey(next);
    rebuildTrayMenu();
    return { ok: true, active: next };
  }

  if (!bind(previous)) {
    /* The previous binding no longer takes either (another app grabbed it
       while we were unregistered). Fall all the way back. */
    bind(DEFAULT_ACCELERATOR);
    activeAccelerator = DEFAULT_ACCELERATOR;
  } else {
    activeAccelerator = previous;
  }
  rebuildTrayMenu();
  return { ok: false, active: activeAccelerator };
}

function togglePanel(): void {
  if (panel && panel.isVisible()) {
    hidePanel();
  } else {
    showPanel();
  }
}

function showPanel(): void {
  if (!panel) return;
  /* Only place a panel that is not already placed. Three callers reach here
     with the panel already on screen (tray → Settings…, second-instance,
     activate), and an unpinned panel recomputes its position from the CURSOR's
     display — so opening the settings modal from the menu bar of another
     display would teleport a mid-conversation window across screens. The
     boundsUsable clause keeps the escape hatch for a visible panel stranded on
     a display that has since been unplugged. */
  if (!panel.isVisible() || !boundsUsable(panel.getBounds())) positionPanel(panel);
  panel.show();
  panel.focus();
  /* The renderer focuses the composer on every show, not just the first. */
  notifyShown();
}

/* webContents.send() into a page whose listeners are not attached yet is
   dropped with no error, and the renderer registers its IPC handlers only
   after an async boot that reads settings, MCP config and every persisted tab
   off disk. Both pushes therefore queue until IPC_READY. */
function notifyShown(): void {
  if (!panel || panel.webContents.isDestroyed()) return;
  if (!rendererReady) {
    pendingShown = true;
    return;
  }
  panel.webContents.send(IPC_SHOWN);
}

function hidePanel(): void {
  if (!panel || !panel.isVisible()) return;
  panel.hide();
  /*
   * hide() alone leaves this app active, so the previously focused app does
   * not come back to the front. app.hide() yields activation to it.
   */
  app.hide?.();
}

/*
 * Pinned panel (user has dragged/resized it): restore those exact bounds, as
 * long as they still land meaningfully on a connected display. Otherwise the
 * default: whichever display holds the cursor, horizontally centered, resting
 * PANEL_BOTTOM_MARGIN above the work-area bottom. Unusable pins (a
 * disconnected display) are kept on disk — the display may come back — but
 * ignored until then.
 */
function positionPanel(win: BrowserWindow): void {
  applyingBounds = true;
  try {
    if (userBounds && boundsUsable(userBounds)) {
      win.setBounds(userBounds);
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const { workArea } = screen.getDisplayNearestPoint(cursor);

    const x = Math.round(workArea.x + (workArea.width - PANEL_WIDTH) / 2);
    const y = Math.round(workArea.y + workArea.height - PANEL_HEIGHT - PANEL_BOTTOM_MARGIN);

    win.setBounds({ x, y, width: PANEL_WIDTH, height: PANEL_HEIGHT });
  } finally {
    setTimeout(() => {
      applyingBounds = false;
    }, 0);
  }
}

/* Enough of the panel on some display to grab: at least a 200x100 sliver of
   it intersects a work area. */
function boundsUsable(b: PanelBounds): boolean {
  return screen.getAllDisplays().some((d) => {
    const wa = d.workArea;
    const ix = Math.min(b.x + b.width, wa.x + wa.width) - Math.max(b.x, wa.x);
    const iy = Math.min(b.y + b.height, wa.y + wa.height) - Math.max(b.y, wa.y);
    return ix >= 200 && iy >= 100;
  });
}

function rememberUserBounds(): void {
  if (!panel || applyingBounds) return;
  /* "moved" is an alias of "move" on macOS, i.e. it fires continuously
     throughout a drag rather than once at the end. The only tray-menu field
     driven by userBounds is the enabled flag on "Reset Window Position", so
     rebuild only on the null -> non-null flip; doing it per frame ran a
     synchronous getLoginItemSettings() LaunchServices query and a full NSMenu
     rebuild dozens of times a second on the main thread. */
  const hadPin = userBounds !== null;
  userBounds = panel.getBounds();
  if (!hadPin) rebuildTrayMenu();
  /* Debounced: a drag emits one "moved" but an edge-resize can emit several
     "resized" in quick succession. */
  if (persistBoundsTimer) clearTimeout(persistBoundsTimer);
  persistBoundsTimer = setTimeout(() => {
    persistBoundsTimer = null;
    writeConfiguredBounds(userBounds);
  }, 500);
}

/* Tray → Reset Window Position: back to cursor-following default placement. */
function resetPanelPosition(): void {
  userBounds = null;
  if (persistBoundsTimer) {
    clearTimeout(persistBoundsTimer);
    persistBoundsTimer = null;
  }
  writeConfiguredBounds(null);
  rebuildTrayMenu();
  if (panel && panel.isVisible()) positionPanel(panel);
}

/* config.json's "panelBounds", or null when absent/malformed. Sizes below the
   window minimums are clamped rather than rejected so an old pin survives a
   minimum bump in a later build. */
function readConfiguredBounds(): PanelBounds | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(APP_CONFIG_PATH, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const raw = (parsed as { panelBounds?: unknown }).panelBounds;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const b = raw as Record<string, unknown>;
    const nums = [b.x, b.y, b.width, b.height];
    if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    return {
      x: Math.round(b.x as number),
      y: Math.round(b.y as number),
      width: Math.max(PANEL_MIN_WIDTH, Math.round(b.width as number)),
      height: Math.max(PANEL_MIN_HEIGHT, Math.round(b.height as number)),
    };
  } catch {
    return null;
  }
}

/* Main owns this field (same read-modify-write discipline as the hotkey).
   null removes the pin. */
function writeConfiguredBounds(bounds: PanelBounds | null): void {
  try {
    let existing: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(APP_CONFIG_PATH, "utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      /* No file yet — write one carrying just the pin; the renderer fills in
         workingDir on its next load. */
    }
    if (bounds === null) delete existing.panelBounds;
    else existing.panelBounds = bounds;
    writeAppConfigSync(existing);
  } catch (err) {
    console.error("[claudesk] could not persist panelBounds to config.json:", err);
  }
}

/*
 * Tray -> Settings…. The panel has to be on screen first: the modal renders
 * inside it, and opening it against a hidden window would leave the user
 * staring at an unchanged menu bar.
 */
function openSettings(): void {
  showPanel();
  if (!panel || panel.webContents.isDestroyed()) return;
  /* Queued rather than dropped when the renderer is still booting — a tray
     item that silently does nothing is worse than one that acts a beat late. */
  if (!rendererReady) {
    pendingOpenSettings = true;
    return;
  }
  panel.webContents.send(IPC_OPEN_SETTINGS, { activeHotkey: activeAccelerator });
}

/* Renderer's Esc path. */
ipcMain.on(IPC_HIDE, () => hidePanel());

/* Renderer's header reset button. */
ipcMain.on(IPC_RESET_POSITION, () => resetPanelPosition());

/* Boot finished: flush whatever was queued while the page had no listeners. */
ipcMain.on(IPC_READY, () => {
  rendererReady = true;
  if (pendingShown) {
    pendingShown = false;
    notifyShown();
  }
  if (pendingOpenSettings) {
    pendingOpenSettings = false;
    openSettings();
  }
});

/* Live `claude` child roster, mirrored from the renderer's SubprocessManager. */
ipcMain.on(IPC_CHILD_PID, (_event, payload: unknown) => {
  if (payload === null || typeof payload !== "object") return;
  const { pid, alive } = payload as { pid?: unknown; alive?: unknown };
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return;
  if (alive === true) childPids.add(pid);
  else childPids.delete(pid);
});

/* Teardown finished (or the renderer answered a second time — ignore that). */
ipcMain.on(IPC_TEARDOWN_DONE, () => {
  if (teardownDone) return;
  teardownDone = true;
  app.quit();
});

/*
 * Hotkey round trip for the settings modal. Validation is the registration
 * itself — Electron is the only authority on which accelerator strings parse
 * and which combinations are free.
 */
ipcMain.handle(IPC_SET_HOTKEY, (_event, value: unknown): { ok: boolean; active: string } => {
  const next = typeof value === "string" ? value.trim() : "";
  if (next.length === 0) return { ok: false, active: activeAccelerator };
  return applyAccelerator(next);
});

/*
 * Menu-bar app: closing/hiding the panel is not a reason to exit. Quit is
 * reachable only through the tray.
 */
app.on("window-all-closed", () => {
  /* intentionally empty */
});

app.on("activate", () => showPanel());

/*
 * Quit handshake. beforeunload can only run shutdownSync(), which never
 * destroys the TabControllers — and TabController.destroy() is the only thing
 * that deletes an incognito tab's session file, the one the CLI still writes
 * an `ai-title` summary into under --no-session-persistence. So the quit is
 * held (once) while the renderer runs the awaitable teardown.
 *
 * `quitting` is set unconditionally and first: panel.on("close") keys off it,
 * and the flag must be true no matter which branch below runs.
 */
app.on("before-quit", (event) => {
  quitting = true;
  if (teardownDone) return;
  if (!panel || panel.webContents.isDestroyed() || !rendererReady) {
    /* Nobody to ask. */
    teardownDone = true;
    return;
  }
  /* A second Quit while one is in flight falls through and exits now, so a
     wedged teardown can always be overridden by asking twice. */
  if (teardownPending) return;
  teardownPending = true;
  event.preventDefault();
  panel.webContents.send(IPC_TEARDOWN);
  setTimeout(() => {
    if (teardownDone) return;
    console.error("[claudesk] renderer teardown timed out; quitting anyway");
    teardownDone = true;
    app.quit();
  }, TEARDOWN_TIMEOUT_MS);
});
