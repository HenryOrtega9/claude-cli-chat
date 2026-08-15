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

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

/* Why this is a discriminated result rather than `Record | null`: the three
   failure modes need three different write policies, and collapsing them is
   what let a transient read error destroy a good config.

   - "missing"     first run (ENOENT). Safe to seed.
   - "corrupt"     the file existed but did not parse. The bytes are moved
                   aside to config.json.corrupt-<ts> first, so seeding no
                   longer destroys anything.
   - "unreadable"  we could not even read it (EACCES, an iCloud placeholder
                   that has not materialized). The contents are unknown and
                   still on disk, so NOTHING may be written over them. */
type RawAppConfig =
  | { status: "ok"; data: Record<string, unknown> }
  | { status: "missing" }
  | { status: "corrupt" }
  | { status: "unreadable" };

function isErrnoCode(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

/* Kept separate from loadAppConfig so the write path can preserve fields this
   build does not know about (and, more to the point, the field the other
   process owns). */
async function readRawAppConfig(): Promise<RawAppConfig> {
  let raw: string;
  try {
    raw = await readFile(APP_CONFIG_PATH, "utf8");
  } catch (err) {
    if (isErrnoCode(err, "ENOENT")) return { status: "missing" };
    console.warn("[claude-quick-chat] could not read config.json:", err);
    return { status: "unreadable" };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { status: "ok", data: parsed as Record<string, unknown> };
    }
  } catch {
    /* falls through to the quarantine below */
  }
  /* Quarantine rather than overwrite: a truncated file (the old non-atomic
     writer) or a bad hand edit still holds the user's hotkey and pinned
     bounds, and those are unrecoverable once they are gone. */
  const quarantine = `${APP_CONFIG_PATH}.corrupt-${Date.now()}`;
  try {
    await rename(APP_CONFIG_PATH, quarantine);
    console.warn(`[claude-quick-chat] config.json did not parse; moved to ${quarantine}`);
    return { status: "corrupt" };
  } catch (err) {
    console.warn("[claude-quick-chat] config.json did not parse and could not be moved aside:", err);
    return { status: "unreadable" };
  }
}

/* tmp-file + rename inside APP_CONFIG_DIR: rename is only atomic within one
   filesystem, and the pid suffix keeps this writer from colliding with the
   main process's synchronous one on the staging path. */
async function writeAppConfigFile(value: Record<string, unknown>): Promise<void> {
  const tmp = `${APP_CONFIG_PATH}.${process.pid}.tmp`;
  await mkdir(APP_CONFIG_DIR, { recursive: true });
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, APP_CONFIG_PATH);
}

function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/* Read config.json, creating it with the default working directory on first
   run. Refusing to start is not an option — that leaves the user with a
   menu-bar icon that does nothing and no way to fix it from inside the app —
   so every failure path still returns a usable in-memory config.

   The seed MERGES over whatever the file already held. Only `workingDir` is
   this side's to set, and main legitimately creates a hotkey-only or
   bounds-only file before the renderer has ever seeded (see main.ts's
   writeConfiguredHotkey / writeConfiguredBounds); writing a bare
   `{ workingDir }` over that silently reset the global hotkey and un-pinned
   the panel. */
export async function loadAppConfig(): Promise<AppConfig> {
  const raw = await readRawAppConfig();
  const stored = raw.status === "ok" ? raw.data : null;
  const workingDir = readString(stored, "workingDir");
  const hotkey = readString(stored, "hotkey") ?? DEFAULT_HOTKEY;
  if (workingDir !== null) return { workingDir, hotkey };

  /* An unreadable file's contents are unknown and still on disk: seeding over
     it would destroy fields we could not even see. */
  if (raw.status !== "unreadable") {
    const next: Record<string, unknown> = { ...(stored ?? {}) };
    next.workingDir = DEFAULT_WORKING_DIR;
    try {
      await writeAppConfigFile(next);
    } catch (err) {
      /* Non-fatal: we still return the default so this launch works; the next
         launch just re-seeds. */
      console.warn("[claude-quick-chat] could not write config.json:", err);
    }
  }
  return { workingDir: DEFAULT_WORKING_DIR, hotkey };
}

/* Persist a new working directory (renderer-owned field). Read-modify-write so
   a hotkey main has already stored survives. Takes effect on the next launch:
   baseDir is threaded through initializePlatform() and every store built on it
   at boot, and re-pointing those live would strand open tabs and subprocesses
   against the old root. */
export async function saveWorkingDir(workingDir: string): Promise<void> {
  const raw = await readRawAppConfig();
  /* Throwing is the right answer here, not a blind overwrite: the settings
     modal surfaces the message, and writing would drop the hotkey and pinned
     bounds sitting in a file we could not read. */
  if (raw.status === "unreadable") {
    throw new Error(`${APP_CONFIG_PATH} could not be read; fix or remove it and try again.`);
  }
  const next: Record<string, unknown> = { ...(raw.status === "ok" ? raw.data : {}) };
  next.workingDir = workingDir;
  await writeAppConfigFile(next);
}

/* Load and normalize settings, mirroring ClaudeChatPlugin.loadSettings()'s
   clamping exactly — same enum guards, same defensive re-wrapping of the
   mutable collections, same voice-URI migration. The shapes are shared, so a
   drift here would show up as a subtly different chat than the plugin's. */
export async function loadDesktopSettings(
  opts: { seed?: boolean } = {},
): Promise<ClaudeChatSettings> {
  /* Callers running against a fallback base directory (a working dir that no
     longer exists) pass seed:false so the recovery path does not conjure a
     settings file into a directory the user never chose. */
  const seed = opts.seed ?? true;
  let stored: Partial<ClaudeChatSettings> = {};
  let existed = false;
  /* Distinct from `!existed`: a read/parse failure means the file is THERE and
     holds something we could not understand. Reseeding over it would delete
     the user's env snippets, claudePath, voice and MCP tool cache with no
     backup — the failure mode PermissionsConfigStore and MCPConfigStore both
     avoid by rotating the bad text to a .bak first. */
  let readFailed = false;
  let rawText: string | null = null;
  try {
    if (await platform.storage.exists(DESKTOP_SETTINGS_PATH)) {
      rawText = await platform.storage.read(DESKTOP_SETTINGS_PATH);
      const parsed: unknown = JSON.parse(rawText);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        stored = parsed as Partial<ClaudeChatSettings>;
        existed = true;
      } else {
        readFailed = true;
      }
    }
  } catch (err) {
    readFailed = true;
    console.warn("[claude-quick-chat] settings read failed; using defaults:", err);
  }

  if (readFailed) {
    const bak = `${DESKTOP_SETTINGS_PATH}.bak`;
    let backedUp = false;
    try {
      if (rawText !== null) {
        await platform.storage.write(bak, rawText);
        backedUp = true;
      }
    } catch (err) {
      console.warn("[claude-quick-chat] could not back up unreadable settings:", err);
    }
    /* Loud, because suppressing the reseed only protects the file until the
       next saveSettings() (an MCP init, a model-pill change) writes defaults
       over it anyway. The user has to act. */
    platform.notify(
      `Could not read ${DESKTOP_SETTINGS_PATH}; running on defaults` +
        (backedUp ? ` (backup at ${bak})` : "") +
        ". Fix or move that file before changing any setting, or it will be overwritten.",
      12000,
    );
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
     re-running the detectors on every launch — but ONLY a genuine
     exists()===false counts as a first run, never a file we failed to read. */
  let dirty = !existed && !readFailed;

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

  if (dirty && seed && !readFailed) {
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
