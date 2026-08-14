/* Standalone-shell configuration: the app-level config.json that names the
   working directory, and the per-working-dir settings file that replaces the
   Obsidian plugin's data.json.

   Two different stores on purpose:

   - config.json lives OUTSIDE the working directory (it is what tells us
     where the working directory is), so it is read/written with node fs
     directly rather than through platform.storage.
   - desktop-settings.json lives INSIDE it, alongside the tab state the
     plugin already writes, so it goes through platform.storage and the same
     atomic-write helper Persistence and PermissionsConfig share. The plugin's
     own data.json is Obsidian-managed and unreachable from here; the two
     apps therefore keep independent settings while sharing sessions, tabs,
     and .claude config. */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { platform } from "../../src/platform";
import { writeJsonAtomic } from "../../src/mcp/MCPConfig";
import {
  DEFAULT_SETTINGS,
  EFFORT_ORDER,
  MODEL_IDS,
  PERMISSION_MODE_ORDER,
  autodetectClaudePath,
  autodetectUserName,
  type ClaudeChatSettings,
} from "../../src/settings-data";

export type AppConfig = {
  /* Absolute directory every storage path resolves against. Shared code
     passes vault-root-relative paths (".claude-cli-chat/tabs/x.json"), so
     this is the exact analogue of the Obsidian vault root. */
  workingDir: string;
  /* Electron accelerator for the global show/hide hotkey. OPTIONAL on disk —
     this in-memory shape always carries a value, defaulting to DEFAULT_HOTKEY
     when the file omits it. */
  hotkey: string;
};

/* One writer per field, deliberately:

   - `workingDir` is written by the RENDERER (saveWorkingDir below). It already
     owns the read/seed path, and the settings modal that edits it lives there.
   - `hotkey` is written by the MAIN process only (app/src/main.ts), because
     main is what actually registers the accelerator and therefore the only
     side that knows whether a value is usable. The renderer proposes a value
     over IPC ("claudesk:set-hotkey") and main persists it after a successful
     registration.

   Both writers read-modify-write the whole file, so neither drops the other's
   field. They are seconds-apart user actions, not a hot path, so no locking. */
export const DEFAULT_HOTKEY = "Alt+Space";

export const APP_CONFIG_DIR = join(homedir(), "Library", "Application Support", "ClaudeQuickChat");
export const APP_CONFIG_PATH = join(APP_CONFIG_DIR, "config.json");

/* Default working directory is the vault the Obsidian plugin runs against, so
   the shell sees the same sessions, the same .claude-cli-chat tab files, and
   the same .claude configuration on first launch. */
export const DEFAULT_WORKING_DIR =
  "/Users/henryortega/Library/Mobile Documents/iCloud~md~obsidian/Documents/Henry Ortega's Second Brain";

export const DESKTOP_SETTINGS_DIR = ".claude-cli-chat";
export const DESKTOP_SETTINGS_PATH = `${DESKTOP_SETTINGS_DIR}/desktop-settings.json`;

/* The file's raw contents as a plain object, or null when it is missing,
   unreadable, or not a JSON object. Kept separate from loadAppConfig so the
   write path can preserve fields this build does not know about (and, more
   to the point, the field the other process owns). */
async function readRawAppConfig(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(APP_CONFIG_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* Missing, unreadable, or invalid JSON. */
  }
  return null;
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/* Read config.json, creating it with the default working directory on first
   run. A malformed or unreadable file is treated as missing and rewritten —
   the alternative (refusing to start) leaves the user with a menu-bar icon
   that does nothing and no way to fix it from inside the app.

   The seed writes `workingDir` only. `hotkey` stays absent until main persists
   one, which keeps the "main is the only writer of hotkey" rule literally true
   and lets an absent field mean "use the default". */
export async function loadAppConfig(): Promise<AppConfig> {
  const raw = await readRawAppConfig();
  const workingDir = readString(raw, "workingDir");
  if (workingDir !== null) {
    return { workingDir, hotkey: readString(raw, "hotkey") ?? DEFAULT_HOTKEY };
  }

  const config = { workingDir: DEFAULT_WORKING_DIR };
  try {
    await mkdir(APP_CONFIG_DIR, { recursive: true });
    await writeFile(APP_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (err) {
    /* Non-fatal: we still return the default so this launch works; the next
       launch just re-seeds. */
    console.warn("[claude-quick-chat] could not write config.json:", err);
  }
  return { ...config, hotkey: readString(raw, "hotkey") ?? DEFAULT_HOTKEY };
}

/* Persist a new working directory (renderer-owned field). Read-modify-write so
   a hotkey main has already stored survives. Takes effect on the next launch:
   baseDir is threaded through initializePlatform() and every store built on it
   at boot, and re-pointing those live would strand open tabs and subprocesses
   against the old root. */
export async function saveWorkingDir(workingDir: string): Promise<void> {
  const next: Record<string, unknown> = { ...(await readRawAppConfig()) };
  next.workingDir = workingDir;
  await mkdir(APP_CONFIG_DIR, { recursive: true });
  await writeFile(APP_CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

/* Load and normalize settings, mirroring ClaudeChatPlugin.loadSettings()'s
   clamping exactly — same enum guards, same defensive re-wrapping of the
   mutable collections, same voice-URI migration. The shapes are shared, so a
   drift here would show up as a subtly different chat than the plugin's. */
export async function loadDesktopSettings(): Promise<ClaudeChatSettings> {
  let stored: Partial<ClaudeChatSettings> = {};
  let existed = false;
  try {
    if (await platform.storage.exists(DESKTOP_SETTINGS_PATH)) {
      const raw = await platform.storage.read(DESKTOP_SETTINGS_PATH);
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        stored = parsed as Partial<ClaudeChatSettings>;
        existed = true;
      }
    }
  } catch (err) {
    /* A corrupt settings file degrades to defaults rather than blocking the
       launch; the reseed below rewrites it. */
    console.warn("[claude-quick-chat] settings read failed; using defaults:", err);
  }

  const settings: ClaudeChatSettings = Object.assign({}, DEFAULT_SETTINGS, stored);
  /* Clamp enum-typed fields to the current vocabulary (main.ts's rationale:
     Object.assign only backfills MISSING keys, so a retired id survives and
     then resolves to undefined at spawn). */
  if (!(settings.defaultModel in MODEL_IDS)) settings.defaultModel = DEFAULT_SETTINGS.defaultModel;
  /* Re-wrap both mutable collections into fresh instances: on a first run
     Object.assign hands over the DEFAULT_SETTINGS references themselves, and
     the in-place mutators (updateMcpToolCache, snippet add/remove) would
     otherwise corrupt the shared default for the process lifetime. The array
     check also normalizes a hand-edited `"envSnippets": null`, which every
     consumer would call array methods on. */
  settings.mcpToolCache = { ...(settings.mcpToolCache ?? {}) };
  settings.envSnippets = Array.isArray(settings.envSnippets) ? [...settings.envSnippets] : [];
  if (!EFFORT_ORDER.includes(settings.defaultEffort)) settings.defaultEffort = DEFAULT_SETTINGS.defaultEffort;
  if (!PERMISSION_MODE_ORDER.includes(settings.permissionMode)) settings.permissionMode = DEFAULT_SETTINGS.permissionMode;

  /* Seed anything the first run should autodetect. `dirty` also covers the
     no-file case so a fresh install lands a complete file on disk instead of
     re-running the detectors on every launch. */
  let dirty = !existed;

  /* Voice migration: an early build stored speechSynthesis voiceURIs
     ("com.apple.voice.…"); playback runs through `say`, which takes plain
     voice names, and a leftover URI makes every spawn exit(1). */
  if (/^com\.apple\./.test(settings.voiceName)) {
    settings.voiceName = "";
    dirty = true;
  }

  if (!settings.claudePath) {
    const detected = autodetectClaudePath();
    if (detected) {
      settings.claudePath = detected;
      dirty = true;
    }
  }

  if (!settings.userName) {
    /* Same validation main.ts applies: dscl can leak an error string into
       stdout, and a truthy check would persist that garbage forever. */
    const detected = autodetectUserName();
    const looksLikeName = (v: string) => /^[A-Za-z][A-Za-z .'-]{0,49}$/.test(v) && /[A-Za-z]/.test(v);
    if (detected && looksLikeName(detected)) {
      settings.userName = detected;
      dirty = true;
    } else {
      const u = process.env.USER ?? "";
      const fallback = u ? u.charAt(0).toUpperCase() + u.slice(1) : "";
      if (fallback && looksLikeName(fallback)) {
        settings.userName = fallback;
        dirty = true;
      }
    }
  }

  if (dirty) {
    try {
      await saveDesktopSettings(settings);
    } catch (err) {
      console.warn("[claude-quick-chat] settings seed write failed:", err);
    }
  }
  return settings;
}

export async function saveDesktopSettings(settings: ClaudeChatSettings): Promise<void> {
  try {
    if (!(await platform.storage.exists(DESKTOP_SETTINGS_DIR))) {
      await platform.storage.mkdir(DESKTOP_SETTINGS_DIR);
    }
  } catch {
    /* mkdir races with Persistence's own ensureDir; a failure here still lets
       writeJsonAtomic surface the real error below. */
  }
  await writeJsonAtomic(platform.storage, DESKTOP_SETTINGS_PATH, settings);
}
