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
  Tray,
} from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

let panel: BrowserWindow | null = null;
let tray: Tray | null = null;

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
  /* Accessory app: menu bar only, no dock tile, no app switcher entry. */
  app.dock?.hide();

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

  /* main.js lives in app/dist/, index.html one level up in app/. */
  void panel.loadFile(join(__dirname, "..", "index.html"));

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

  panel.on("closed", () => {
    panel = null;
  });
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
    mkdirSync(APP_CONFIG_DIR, { recursive: true });
    writeFileSync(APP_CONFIG_PATH, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  } catch (err) {
    console.error("[claudesk] could not persist hotkey to config.json:", err);
  }
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
  positionPanel(panel);
  panel.show();
  panel.focus();
  /* The renderer focuses the composer on every show, not just the first. */
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
  userBounds = panel.getBounds();
  rebuildTrayMenu();
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
    mkdirSync(APP_CONFIG_DIR, { recursive: true });
    writeFileSync(APP_CONFIG_PATH, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
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
  panel?.webContents.send(IPC_OPEN_SETTINGS, { activeHotkey: activeAccelerator });
}

/* Renderer's Esc path. */
ipcMain.on(IPC_HIDE, () => hidePanel());

/* Renderer's header reset button. */
ipcMain.on(IPC_RESET_POSITION, () => resetPanelPosition());

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

app.on("before-quit", () => {
  quitting = true;
});
