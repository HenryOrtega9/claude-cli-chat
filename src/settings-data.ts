/* Shared settings data model: model/effort/permission-mode catalogs, the
   persisted settings shape and defaults, and the pure helpers around them.
   This file must stay free of `obsidian` imports (and of imports from any
   Obsidian-only file) so a standalone shell can compile it as-is; the
   Obsidian settings-tab UI lives in ./settings.ts, which re-exports
   everything here so existing `../settings` imports keep working. Node
   builtins are fine (the autodetect helpers shell out). */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

/* Model IDs use the `[1m]` suffix to enable Claude's 1M-context window
   for Opus and Sonnet, matching Claudian's `enableOpus1M`/`enableSonnet1M`
   behavior. Haiku does not support 1M context, so it stays unsuffixed.

   `opusplan` is a CLI alias that auto-routes between Opus (while in plan
   mode) and Sonnet (everywhere else). No `[1m]` suffix because the alias
   itself does the model selection; the underlying Opus path still gets
   1M context. Same model alias `/model opusplan` exposes in Claude Code. */
export const MODEL_IDS = {
  "fable-5": "claude-fable-5[1m]",
  "opus-5": "claude-opus-5[1m]",
  "opus-1m": "claude-opus-4-8[1m]",
  "opus-4-7-1m": "claude-opus-4-7[1m]",
  "opus-4-6-1m": "claude-opus-4-6[1m]",
  "opus-plan": "opusplan",
  "sonnet-5": "claude-sonnet-5[1m]",
  "sonnet-1m": "claude-sonnet-4-6[1m]",
  "haiku": "haiku",
} as const;

export type ModelKey = keyof typeof MODEL_IDS;

export const MODEL_LABELS: Record<ModelKey, string> = {
  "fable-5": "Fable 5 1M",
  "opus-5": "Opus 5 1M",
  "opus-1m": "Opus 4.8 1M",
  "opus-4-7-1m": "Opus 4.7 1M",
  "opus-4-6-1m": "Opus 4.6 1M",
  "opus-plan": "Opus Plan",
  "sonnet-5": "Sonnet 5 1M",
  "sonnet-1m": "Sonnet 4.6 1M",
  "haiku": "Haiku",
};

/* Availability caveats surfaced under the model name in the picker popup
   and appended to the settings dropdown. fable-5 was relaunched 2026-07-01
   with promotional plan-included access (up to 50% of weekly limits),
   extended twice (Jul 7 → Jul 12 → Jul 19). On 2026-07-18 Anthropic
   announced the permanent structure effective Jul 20: Fable 5 is included
   in Max and Team Premium plans at up to 50% of weekly limits, with no end
   date. Pro and Team Standard instead bill it via usage credits at API
   rates ($10/$50 per MTok) after a one-time $100 credit. This user is on
   Max 5x, so Fable 5 draws from the normal subscription caps.
   Details: https://support.claude.com/en/articles/15424964-claude-fable-5-promotional-access
   If Anthropic pulls it entirely, delete the "fable-5"
   entries here and in MODEL_IDS/MODEL_LABELS/MODEL_GROUPS — the
   defaultModel guard in main.ts and the per-tab ModelKey guard in
   TabController fall back gracefully for anyone who had it persisted.
   1M context and xhigh effort are confirmed supported, so it carries the
   `[1m]` suffix and the full effort ladder like the Opus 1M variants. */
export const MODEL_NOTES: Partial<Record<ModelKey, string>> = {
  "fable-5": "Included in Max plans (up to 50% of weekly limits) as of Jul 20, 2026. No usage credits needed.",
};

/* Ordered sections for the model-picker popup; each renders under its own
   header. Fable (the newest family) leads, then Opus variants (including
   the opus-plan alias, which routes to Opus), then Sonnet, then Haiku.
   Keep in sync with MODEL_IDS: every ModelKey must appear in exactly one
   group. */
export const MODEL_GROUPS: { header: string; keys: ModelKey[] }[] = [
  { header: "FABLE", keys: ["fable-5"] },
  { header: "OPUS", keys: ["opus-5", "opus-1m", "opus-4-7-1m", "opus-4-6-1m", "opus-plan"] },
  { header: "SONNET", keys: ["sonnet-5", "sonnet-1m"] },
  { header: "HAIKU", keys: ["haiku"] },
];

/* Effort levels mirror Claude Code CLI's `--effort` flag (v2.1.141:
   low, medium, high, xhigh, max). xhigh is Opus-only — the UI hides it
   when any other model is selected. */
export type EffortLevel = "max" | "xhigh" | "high" | "medium" | "low";
export const EFFORT_LABELS: Record<EffortLevel, string> = {
  max: "Max",
  xhigh: "X-High",
  high: "High",
  medium: "Med",
  low: "Low",
};
export const EFFORT_ORDER: EffortLevel[] = ["max", "xhigh", "high", "medium", "low"];

/* Returns the effort levels available for a given model. xhigh is gated to
   Fable 5, Opus (Opus 5, Opus 4.8, Opus 4.7, Opus 4.6, and opus-plan which
   routes to Opus when in plan mode), and Sonnet 5 — the first Sonnet-tier
   model with xhigh; everything else shows the standard four. Opus 5's full
   ladder (incl. xhigh/max) is confirmed by the effort docs as of its
   2026-07-24 release. */
export function effortLevelsForModel(model: ModelKey): EffortLevel[] {
  if (model === "fable-5" || model === "opus-5" || model === "opus-1m" || model === "opus-4-7-1m" || model === "opus-4-6-1m" || model === "opus-plan" || model === "sonnet-5") return EFFORT_ORDER;
  return EFFORT_ORDER.filter(e => e !== "xhigh");
}

/* Total context window size for a model, used as the denominator when the
   usage snapshot doesn't include `contextWindow` directly. The `[1m]` suffix
   models open the 1M-token window; everything else is 200k. opus-plan can
   resolve to either Opus (1M) or Sonnet (200k) at runtime; we display 1M
   as the upper bound so the donut doesn't overflow when in plan mode. */
export function contextWindowForModel(model: ModelKey): number {
  if (model === "fable-5" || model === "opus-5" || model === "opus-1m" || model === "opus-4-7-1m" || model === "opus-4-6-1m" || model === "sonnet-5" || model === "sonnet-1m" || model === "opus-plan") return 1_000_000;
  return 200_000;
}

/* Permission modes mirror Claude Code CLI's `--permission-mode` flag.
   Cycle order matches the terminal's Shift+Tab behavior: Normal → Accept
   Edits → Plan → Auto → Bypass → Normal. */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "auto" | "bypassPermissions";
export const PERMISSION_MODE_ORDER: PermissionMode[] = [
  "default",
  "acceptEdits",
  "plan",
  "auto",
  "bypassPermissions",
];
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: "Normal",
  acceptEdits: "Accept Edits",
  plan: "Plan",
  auto: "Auto",
  bypassPermissions: "Bypass",
};
export const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  default: "Asks before risky tools (default)",
  acceptEdits: "Auto-approves file edits",
  plan: "Plan-only — no edits or commands",
  auto: "Classifier auto-approves safe tools",
  bypassPermissions: "Skip all permission checks (dangerous)",
};

export function nextPermissionMode(current: PermissionMode): PermissionMode {
  const idx = PERMISSION_MODE_ORDER.indexOf(current);
  return PERMISSION_MODE_ORDER[(idx + 1) % PERMISSION_MODE_ORDER.length];
}

/* A folder outside the vault that the plugin has been granted "trusted"
   status for. When `enabled`, the corresponding Read/Glob/Grep allowlist
   patterns are present in <vault>/.claude/settings.json so Claude can read
   anything under this path without prompting. When disabled, the patterns
   are removed; the folder stays in the list so the user can re-enable with
   one click instead of re-picking it. Path is absolute and normalized
   (trailing slash stripped). */
export type TrustedFolder = {
  path: string;
  enabled: boolean;
};

/* Reusable bundle of settings (model + effort + permission mode + an
   optional system-prompt addendum). Lets the user switch between work
   contexts — "Coding", "Research", "Vault writing" — with one click. */
export type EnvSnippet = {
  id: string;
  name: string;
  model: ModelKey;
  effort: EffortLevel;
  permissionMode: PermissionMode;
  /* Appended to the model's system prompt via --append-system-prompt. */
  systemPromptAddendum: string;
};

export type ClaudeChatSettings = {
  userName: string;
  defaultModel: ModelKey;
  defaultEffort: EffortLevel;
  claudePath: string;
  remoteSessionNamePrefix: string;
  includePartialMessages: boolean;
  permissionMode: PermissionMode;
  envSnippets: EnvSnippet[];
  /* Auto-generate a conversation title after the first user message +
     assistant response. */
  autoGenerateTitles: boolean;
  /* Always-on system-prompt addendum applied to every tab in this vault.
     Passed via --append-system-prompt on every spawn. Composes with the
     per-tab env snippet's addendum (both apply if both set). Functionally
     equivalent to a vault-scoped CLAUDE.md addition. */
  vaultSystemPromptAddendum: string;
  /* Folders outside the vault that the user has explicitly trusted so
     Claude can read from them on demand via the Read/Glob/Grep tools. Each
     entry persists across sessions; toggling `enabled` adds or removes the
     matching `Read(<path>/**)` etc. patterns from .claude/settings.json's
     allowlist. Default empty — the user opts in folder by folder. */
  trustedFolders: TrustedFolder[];
  /* When true, the list of enabled trusted folders is appended to every
     spawn's system prompt so Claude knows where it can look on demand
     without needing the user to mention paths explicitly. Default on. */
  trustedFoldersInSystemPrompt: boolean;
  /* Ulanzi TC001 status display integration. When enabled, the plugin
     drives a 32x8 LED matrix on the LAN: state changes (thinking,
     needs_permission, complete, ready, idle) are pushed to the device
     and written to /tmp/claude_state for the animator daemon. v1 is
     plugin-only; terminal Claude Code does NOT emit. Default off so the
     plugin is silent until hardware is on the network. */
  tc001Enabled: boolean;
  tc001Ip: string;
  /* Voice mode: speak assistant responses aloud via macOS `say` child
     processes (see SpeechController). voiceDefaultOn seeds the per-tab
     Voice pill for tabs that haven't pinned their own value. voiceName is
     a plain `say -v` voice name like "Ava (Premium)" ("" = system default
     voice). */
  voiceDefaultOn: boolean;
  voiceName: string;
  voiceRate: number;
  /* Last-known MCP tool list per server, keyed by the sanitized server name
     the CLI uses in `mcp__<server>__<tool>` ids. Written on every init event;
     read as a fallback by the cost-surface pill so tool counts show before
     the first message of a session (new tab, after /clear, plugin reload).
     Not user-editable — a display cache that lives in data.json alongside
     the settings for lack of a better home. */
  mcpToolCache: Record<string, string[]>;
};

export const DEFAULT_SETTINGS: ClaudeChatSettings = {
  userName: "",
  defaultModel: "sonnet-1m",
  defaultEffort: "medium",
  claudePath: "",
  remoteSessionNamePrefix: "",
  includePartialMessages: true,
  permissionMode: "default",
  envSnippets: [],
  autoGenerateTitles: true,
  vaultSystemPromptAddendum: "",
  trustedFolders: [],
  trustedFoldersInSystemPrompt: true,
  tc001Enabled: false,
  tc001Ip: "192.168.1.50",
  voiceDefaultOn: false,
  voiceName: "",
  voiceRate: 1,
  mcpToolCache: {},
};

/* Build the allowlist patterns that grant Read/Glob/Grep access to anything
   under an absolute folder path. Centralized so the add and remove paths use
   the same shape — divergence here would silently leave dangling permission
   entries the user can't see without opening settings.json by hand. */
export function trustedFolderAllowPatterns(absolutePath: string): string[] {
  const normalized = absolutePath.replace(/\/+$/, "");
  return [
    `Read(${normalized}/**)`,
    `Glob(${normalized}/**)`,
    `Grep(${normalized}/**)`,
  ];
}

export function makeSnippetId(): string {
  return `snip-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function resolveModelId(key: ModelKey): string {
  return MODEL_IDS[key];
}

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
