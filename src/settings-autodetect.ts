/* Node-only settings helpers, split out of ./settings-data.ts.

   These two are the only settings-layer functions that touch the machine
   (a `claude` binary probe and a macOS `dscl` lookup), so they are the only
   ones a browser bundle cannot compile. Keeping them here lets
   ./settings-data.ts stay node-free for the iOS web target while
   ./settings.ts re-exports both modules, so every existing `../settings`
   import keeps resolving the same symbols. */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

/* Module-scoped caches so the settings tab's display() call (re-run on
   every render) doesn't re-fork a child process for the autodetect helpers
   on every paint. Reset implicitly on plugin reload via module re-eval. */
let cachedClaudePath: string | null = null;
let cachedUserName: string | null = null;

export function autodetectClaudePath(force = false): string {
  /* A failed detection caches "" so passive callers (placeholder text on
     every display() paint) stay cheap, but the Autodetect button passes
     force=true — otherwise installing the CLI after the first settings
     open would never be noticed until a full plugin reload. */
  if (cachedClaudePath !== null && !force) return cachedClaudePath;
  const candidates = [
    `${process.env.HOME}/.local/bin/claude`,
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
    `${process.env.HOME}/.npm-global/bin/claude`,
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      cachedClaudePath = p;
      return p;
    }
  }
  try {
    /* 3s timeout matches autodetectUserName's bound so a stuck PATH lookup
       can't freeze the settings tab. */
    cachedClaudePath = execSync("command -v claude", { encoding: "utf8", timeout: 3000 }).trim();
  } catch {
    cachedClaudePath = "";
  }
  return cachedClaudePath;
}

/* Autodetect the user's display name on first install. macOS `dscl` returns
   the RealName attribute from Directory Services ("Henry Ortega"). If that
   fails, fall back to capitalizing the shell username. The user can override
   anytime in plugin settings. */
export function autodetectUserName(): string {
  if (cachedUserName !== null) return cachedUserName;
  try {
    const out = execSync("dscl . -read /Users/$USER RealName 2>/dev/null | sed -n 's/^ //p' | tail -1", {
      encoding: "utf8",
      timeout: 1000,
      shell: "/bin/sh",
    }).trim();
    if (out) {
      cachedUserName = out;
      return out;
    }
  } catch { /* ignore */ }
  const u = process.env.USER ?? "";
  cachedUserName = u ? u.charAt(0).toUpperCase() + u.slice(1) : "";
  return cachedUserName;
}
