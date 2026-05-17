import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type ClaudeChatPlugin from "./main";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  PermissionsConfigStore,
  RECOMMENDED_ALLOW_PATTERNS,
} from "./permissions/PermissionsConfig";
import { findRemoteControlPids } from "./claude/SubprocessManager";

/* Per-control debounce helper used to coalesce rapid text-input keystrokes
   into a single saveSettings() call. The synchronous in-memory state is
   still updated immediately by the caller — only the disk write is
   debounced. 250ms feels instant to the user but absorbs a fast typist's
   keystroke train into one write. */
function debounced<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let handle: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = null;
      fn(...args);
    }, ms);
  };
}

/* Model IDs use the `[1m]` suffix to enable Claude's 1M-context window
   for Opus and Sonnet, matching Claudian's `enableOpus1M`/`enableSonnet1M`
   behavior. Haiku does not support 1M context, so it stays unsuffixed.

   `opusplan` is a CLI alias that auto-routes between Opus (while in plan
   mode) and Sonnet (everywhere else). No `[1m]` suffix because the alias
   itself does the model selection; the underlying Opus path still gets
   1M context. Same model alias `/model opusplan` exposes in Claude Code. */
export const MODEL_IDS = {
  "opus-1m": "claude-opus-4-7[1m]",
  "opus-plan": "opusplan",
  "sonnet-1m": "claude-sonnet-4-6[1m]",
  "haiku": "haiku",
} as const;

export type ModelKey = keyof typeof MODEL_IDS;

export const MODEL_LABELS: Record<ModelKey, string> = {
  "opus-1m": "Opus 1M",
  "opus-plan": "Opus Plan",
  "sonnet-1m": "Sonnet 1M",
  "haiku": "Haiku",
};

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
   Opus today (including opus-plan, which routes to Opus when in plan mode);
   everything else shows the standard four. */
export function effortLevelsForModel(model: ModelKey): EffortLevel[] {
  if (model === "opus-1m" || model === "opus-plan") return EFFORT_ORDER;
  return EFFORT_ORDER.filter(e => e !== "xhigh");
}

/* Total context window size for a model, used as the denominator when the
   usage snapshot doesn't include `contextWindow` directly. The `[1m]` suffix
   models open the 1M-token window; everything else is 200k. opus-plan can
   resolve to either Opus (1M) or Sonnet (200k) at runtime — we display 1M
   as the upper bound so the donut doesn't overflow when in plan mode. */
export function contextWindowForModel(model: ModelKey): number {
  if (model === "opus-1m" || model === "sonnet-1m" || model === "opus-plan") return 1_000_000;
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
  /* Model alias used for title generation. "haiku" is fast + cheap and
     well-suited to the task. */
  titleGenerationModel: string;
  /* Always-on system-prompt addendum applied to every tab in this vault.
     Passed via --append-system-prompt on every spawn. Composes with the
     per-tab env snippet's addendum (both apply if both set). Functionally
     equivalent to a vault-scoped CLAUDE.md addition. */
  vaultSystemPromptAddendum: string;
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
  titleGenerationModel: "haiku",
  vaultSystemPromptAddendum: "",
};

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

export function autodetectClaudePath(): string {
  if (cachedClaudePath !== null) return cachedClaudePath;
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

export class ClaudeChatSettingTab extends PluginSettingTab {
  plugin: ClaudeChatPlugin;
  /* Cached allowlist patterns for the synchronous display() call. Populated
     by an async load on first display(); when load completes we re-display
     to swap the "Loading..." placeholder for the real rows. */
  private allowPatternsCache: string[] | null = null;
  private permissionsStore: PermissionsConfigStore;

  constructor(app: App, plugin: ClaudeChatPlugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.permissionsStore = new PermissionsConfigStore(app);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Claude (CLI Chat)" });

    const saveDebounced = debounced(() => { void this.plugin.saveSettings(); }, 250);

    new Setting(containerEl)
      .setName("Your name")
      .setDesc("Used in the welcome greeting (e.g., \"Hey there, Henry Ortega\").")
      .addText(text => {
        const debouncedSave = debounced(() => { void this.plugin.saveSettings(); }, 250);
        text
          .setPlaceholder("Henry Ortega")
          .setValue(this.plugin.settings.userName)
          .onChange(value => {
            /* In-memory state update is synchronous so any consumer reading
               settings between keystrokes sees the latest value; only the
               disk flush is debounced. */
            this.plugin.settings.userName = value.trim();
            debouncedSave();
          });
      });

    new Setting(containerEl)
      .setName("Default model")
      .setDesc("Sonnet 1M and Opus 1M use the 1M-context window via the `[1m]` model suffix. Haiku has standard context.")
      .addDropdown(dd => {
        const options: Record<string, string> = {};
        for (const key of Object.keys(MODEL_LABELS) as ModelKey[]) {
          options[key] = `${MODEL_LABELS[key]} (${MODEL_IDS[key]})`;
        }
        dd.addOptions(options)
          .setValue(this.plugin.settings.defaultModel)
          .onChange(async value => {
            this.plugin.settings.defaultModel = value as ModelKey;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Default reasoning effort")
      .setDesc("Maps to Claude Code's `--effort` flag. Higher values allow deeper reasoning at the cost of latency and tokens.")
      .addDropdown(dd => {
        const options: Record<string, string> = {};
        for (const key of EFFORT_ORDER) {
          options[key] = `${EFFORT_LABELS[key]} (${key})`;
        }
        dd.addOptions(options)
          .setValue(this.plugin.settings.defaultEffort)
          .onChange(async value => {
            this.plugin.settings.defaultEffort = value as EffortLevel;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Claude CLI path")
      .setDesc("Absolute path to the `claude` binary. Leave empty to autodetect.")
      .addText(text => {
        const debouncedSave = debounced(() => { void this.plugin.saveSettings(); }, 250);
        text
          .setPlaceholder(autodetectClaudePath() || "/path/to/claude")
          .setValue(this.plugin.settings.claudePath)
          .onChange(value => {
            this.plugin.settings.claudePath = value.trim();
            debouncedSave();
          });
      })
      .addButton(btn =>
        btn
          .setButtonText("Autodetect")
          .onClick(async () => {
            const detected = autodetectClaudePath();
            this.plugin.settings.claudePath = detected;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    new Setting(containerEl)
      .setName("Default permission mode")
      .setDesc("Starting permission mode for new tabs. Use Shift+Tab in the input box to cycle modes inside an active tab.")
      .addDropdown(dd => {
        const options: Record<string, string> = {};
        for (const key of PERMISSION_MODE_ORDER) {
          options[key] = `${PERMISSION_MODE_LABELS[key]} — ${PERMISSION_MODE_DESCRIPTIONS[key]}`;
        }
        dd.addOptions(options)
          .setValue(this.plugin.settings.permissionMode)
          .onChange(async value => {
            this.plugin.settings.permissionMode = value as PermissionMode;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Stream partial messages")
      .setDesc("Render assistant text as it arrives. Disable for cleaner final-only rendering.")
      .addToggle(t =>
        t.setValue(this.plugin.settings.includePartialMessages).onChange(async value => {
          this.plugin.settings.includePartialMessages = value;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "Vault system prompt" });
    containerEl.createEl("p", {
      text: "Additional instructions appended to Claude's system prompt on every spawn. Scoped to this vault only — equivalent to a vault-level CLAUDE.md addition. Composes with any env-snippet addendum (both apply if both are set). Takes effect on the next subprocess restart (new tab, /clear, or sending the next message in a fresh tab).",
      cls: "setting-item-description",
    });
    new Setting(containerEl)
      .setName("Custom system prompt")
      .setDesc("Plain text. Leave empty for none.")
      .addTextArea(t => {
        const debouncedSave = debounced(() => { void this.plugin.saveSettings(); }, 250);
        t.setPlaceholder("e.g. Always cite source notes by [[wikilink]] when referencing vault content.")
          .setValue(this.plugin.settings.vaultSystemPromptAddendum)
          .onChange(value => {
            this.plugin.settings.vaultSystemPromptAddendum = value;
            debouncedSave();
          });
        t.inputEl.rows = 6;
        t.inputEl.style.width = "100%";
      });

    this.renderAllowlistSection(containerEl);

    containerEl.createEl("h3", { text: "Conversations" });

    new Setting(containerEl)
      .setName("Auto-generate conversation titles")
      .setDesc("After the first user message + assistant response, run a small model to title the conversation. Displayed under the tab bar.")
      .addToggle(t =>
        t.setValue(this.plugin.settings.autoGenerateTitles).onChange(async value => {
          this.plugin.settings.autoGenerateTitles = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Title generation model")
      .setDesc("Model alias to use for auto-titling. Haiku is fast and cheap; pass any alias the CLI understands.")
      .addText(text => {
        const debouncedSave = debounced(() => { void this.plugin.saveSettings(); }, 250);
        text
          .setPlaceholder("haiku")
          .setValue(this.plugin.settings.titleGenerationModel)
          .onChange(value => {
            this.plugin.settings.titleGenerationModel = value.trim() || "haiku";
            debouncedSave();
          });
      });

    new Setting(containerEl)
      .setName("Remote Control session prefix")
      .setDesc("Optional prefix for auto-generated Remote Control session names. Defaults to your machine hostname.")
      .addText(text => {
        const debouncedSave = debounced(() => { void this.plugin.saveSettings(); }, 250);
        text
          .setPlaceholder("hostname")
          .setValue(this.plugin.settings.remoteSessionNamePrefix)
          .onChange(value => {
            this.plugin.settings.remoteSessionNamePrefix = value.trim();
            debouncedSave();
          });
      });

    this.renderSnippetsSection(containerEl);

    this.renderProcessCleanupSection(containerEl);
  }

  /* Surfaces a count of live `claude --remote-control` processes (tracked
     + orphan) and a kill-everything button. Wired to
     SubprocessManager.killAllRemoteAndOrphans so it disposes tracked
     sessions cleanly and also signals any leftover PIDs the registry lost
     track of (e.g. survivors from before this cleanup logic existed). */
  private renderProcessCleanupSection(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "Process cleanup" });
    containerEl.createEl("p", {
      text: "Live `claude --remote-control` processes: both the ones this plugin is currently tracking and any orphans left over from a prior Obsidian session. Closing a tab in the UI should kill its remote session; this button is the safety net when that breaks.",
      cls: "setting-item-description",
    });

    const livePids = findRemoteControlPids();
    const tracked = this.plugin.subprocessManager.listRemote().length;
    const total = livePids.length;
    const orphans = Math.max(0, total - tracked);

    new Setting(containerEl)
      .setName("Active remote sessions")
      .setDesc(
        total === 0
          ? "None running."
          : `${total} process${total === 1 ? "" : "es"} found (${tracked} tracked, ${orphans} orphan${orphans === 1 ? "" : "s"}).`
      )
      .addButton(btn => {
        btn.setButtonText(total === 0 ? "Refresh" : `Kill ${total}`);
        if (total > 0) btn.setWarning();
        btn.onClick(async () => {
          if (total === 0) {
            this.display();
            return;
          }
          const { tracked: t, orphans: o } = await this.plugin.subprocessManager.killAllRemoteAndOrphans();
          const killed = t + o;
          new Notice(
            killed === 0
              ? "Nothing to kill."
              : `Killed ${killed} session${killed === 1 ? "" : "s"} (${t} tracked, ${o} orphan${o === 1 ? "" : "s"}).`
          );
          this.display();
        });
      });
  }

  /* Tool allowlist editor — writes to <vault>/.claude/settings.json's
     `permissions.allow` array. The same file the CLI reads, so the
     allowlist applies whether Claude is run from this plugin or directly
     via `claude` from this vault. Unknown top-level keys ($schema,
     enabledPlugins, hooks, env, deny, ask) are preserved on write. */
  private renderAllowlistSection(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "Tool allowlist" });
    containerEl.createEl("p", {
      text: "Patterns auto-approved without prompting in any permission mode. Same syntax as Claude Code: Bash(prefix:*) matches commands starting with prefix, Bash(literal) matches exactly, plain ToolName approves all uses. Edits write to <vault>/.claude/settings.json — other keys in the file are preserved.",
      cls: "setting-item-description",
    });

    /* Async-load on first display(); re-render once loaded. */
    if (this.allowPatternsCache === null) {
      containerEl.createEl("p", { text: "Loading allowlist…", cls: "setting-item-description" });
      void this.permissionsStore.listAllow().then(patterns => {
        this.allowPatternsCache = patterns;
        this.display();
      });
      return;
    }

    const patterns = this.allowPatternsCache;

    /* "Add recommended" button — bulk-adds the curated read-only safe set,
       skipping any already present. The displayed count reflects what
       would actually be added based on current state. */
    const missingRecommended = RECOMMENDED_ALLOW_PATTERNS.filter(p => !patterns.includes(p));
    new Setting(containerEl)
      .setName("Recommended safe patterns")
      .setDesc(
        `${RECOMMENDED_ALLOW_PATTERNS.length} curated read-only/low-risk Bash patterns (cat, grep, find, ls, git status, etc.). ` +
        (missingRecommended.length === 0
          ? "All already in your allowlist."
          : `${missingRecommended.length} not yet added.`)
      )
      .addButton(btn => {
        btn.setButtonText(missingRecommended.length === 0 ? "All added" : `Add ${missingRecommended.length}`)
          .setDisabled(missingRecommended.length === 0);
        if (missingRecommended.length > 0) btn.setCta();
        btn.onClick(async () => {
          const added = await this.permissionsStore.addAllowMany(RECOMMENDED_ALLOW_PATTERNS);
          new Notice(`Added ${added} pattern${added === 1 ? "" : "s"} to allowlist.`);
          this.allowPatternsCache = null;
          this.display();
        });
      });

    /* Add custom pattern — text input + button. */
    let pendingPattern = "";
    let inputEl: HTMLInputElement | null = null;
    new Setting(containerEl)
      .setName("Add custom pattern")
      .setDesc("e.g. Bash(npm test:*) or Bash(curl https://api.example.com:*) — leave empty and Enter does nothing.")
      .addText(t => {
        inputEl = t.inputEl;
        t.setPlaceholder("Bash(your command:*)")
          .onChange(v => { pendingPattern = v; });
        t.inputEl.addEventListener("keydown", async e => {
          if (e.key === "Enter") {
            e.preventDefault();
            await addPending();
          }
        });
      })
      .addButton(btn => {
        btn.setButtonText("Add").setCta().onClick(addPending);
      });

    const self = this;
    async function addPending() {
      const trimmed = pendingPattern.trim();
      if (!trimmed) return;
      const added = await self.permissionsStore.addAllow(trimmed);
      if (added) {
        new Notice(`Added: ${trimmed}`);
        self.allowPatternsCache = null;
        self.display();
      } else {
        /* Duplicate — clear the input so the user can immediately try a
           different pattern without manually wiping the stale text. */
        if (inputEl) inputEl.value = "";
        pendingPattern = "";
        new Notice("Already in allowlist.");
      }
    }

    /* Current allowlist — one row per pattern with a remove button. Long
       literal entries (multi-line bash one-offs) are truncated for display
       but the full pattern lives in the title attribute. */
    containerEl.createEl("h4", { text: `Current allowlist (${patterns.length})` });
    if (patterns.length === 0) {
      containerEl.createEl("p", { text: "Empty. Add the recommended set above or your own patterns.", cls: "setting-item-description" });
      return;
    }

    /* Cap the allowlist's vertical footprint so a large list doesn't push
       the rest of the settings panel off-screen. Border + padding give the
       scroll region a clear visual boundary; max-height is a fixed pixel
       value rather than vh so it doesn't grow with the user's monitor. */
    const scrollWrap = containerEl.createDiv();
    scrollWrap.style.maxHeight = "400px";
    scrollWrap.style.overflowY = "auto";
    scrollWrap.style.border = "1px solid var(--background-modifier-border)";
    scrollWrap.style.borderRadius = "6px";
    scrollWrap.style.padding = "4px 8px";
    scrollWrap.style.marginTop = "8px";

    for (const pattern of patterns) {
      const truncated = pattern.length > 100 ? pattern.slice(0, 97) + "…" : pattern;
      const isMultiline = pattern.includes("\n");
      const displayName = isMultiline ? truncated.replace(/\n/g, " ⏎ ") : truncated;
      const row = new Setting(scrollWrap)
        .setName(displayName)
        .addExtraButton(btn => {
          btn.setIcon("trash-2").setTooltip("Remove from allowlist").onClick(async () => {
            await this.permissionsStore.removeAllow(pattern);
            this.allowPatternsCache = null;
            this.display();
          });
        });
      /* Native browser tooltip on hover shows the full pattern when truncated. */
      if (pattern !== displayName) row.nameEl.setAttr("title", pattern);
    }
  }

  /* Snippet editor: lists existing snippets with edit/delete affordances and
     a button to add a new one. Editing happens inline via a series of
     Setting rows (Obsidian's native form widgets) so we don't need a
     dedicated modal. */
  private renderSnippetsSection(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "Environment snippets" });
    containerEl.createEl("p", {
      text: "Bundle model + effort + permission mode + a system-prompt addendum into a named preset. Apply to a tab from the chat header's snippet picker.",
      cls: "setting-item-description",
    });

    for (const snippet of this.plugin.settings.envSnippets) {
      this.renderSnippetRow(containerEl, snippet);
    }

    new Setting(containerEl)
      .addButton(btn =>
        btn.setButtonText("Add snippet").setCta().onClick(async () => {
          const next: EnvSnippet = {
            id: makeSnippetId(),
            name: "New snippet",
            model: this.plugin.settings.defaultModel,
            effort: this.plugin.settings.defaultEffort,
            permissionMode: this.plugin.settings.permissionMode,
            systemPromptAddendum: "",
          };
          this.plugin.settings.envSnippets.push(next);
          await this.plugin.saveSettings();
          this.display();
        })
      );
  }

  private renderSnippetRow(containerEl: HTMLElement, snippet: EnvSnippet) {
    const wrap = containerEl.createDiv({ cls: "claudian-snippet-editor" });

    const debouncedSave = debounced(() => { void this.plugin.saveSettings(); }, 250);

    new Setting(wrap)
      .setName("Name")
      .addText(t => t.setValue(snippet.name).onChange(v => {
        snippet.name = v;
        debouncedSave();
      }))
      .addExtraButton(btn => {
        btn.setIcon("trash-2").setTooltip("Delete snippet").onClick(async () => {
          const idx = this.plugin.settings.envSnippets.findIndex(s => s.id === snippet.id);
          if (idx >= 0) this.plugin.settings.envSnippets.splice(idx, 1);
          await this.plugin.saveSettings();
          this.display();
        });
      });

    new Setting(wrap)
      .setName("Model")
      .addDropdown(dd => {
        const opts: Record<string, string> = {};
        for (const k of Object.keys(MODEL_LABELS) as ModelKey[]) opts[k] = MODEL_LABELS[k];
        dd.addOptions(opts).setValue(snippet.model).onChange(async v => {
          snippet.model = v as ModelKey;
          await this.plugin.saveSettings();
        });
      });

    new Setting(wrap)
      .setName("Effort")
      .addDropdown(dd => {
        const opts: Record<string, string> = {};
        for (const k of EFFORT_ORDER) opts[k] = EFFORT_LABELS[k];
        dd.addOptions(opts).setValue(snippet.effort).onChange(async v => {
          snippet.effort = v as EffortLevel;
          await this.plugin.saveSettings();
        });
      });

    new Setting(wrap)
      .setName("Permission mode")
      .addDropdown(dd => {
        const opts: Record<string, string> = {};
        for (const k of PERMISSION_MODE_ORDER) opts[k] = PERMISSION_MODE_LABELS[k];
        dd.addOptions(opts).setValue(snippet.permissionMode).onChange(async v => {
          snippet.permissionMode = v as PermissionMode;
          await this.plugin.saveSettings();
        });
      });

    new Setting(wrap)
      .setName("System prompt addendum")
      .setDesc("Text appended to Claude's system prompt via --append-system-prompt.")
      .addTextArea(t => {
        t.setValue(snippet.systemPromptAddendum).onChange(v => {
          snippet.systemPromptAddendum = v;
          debouncedSave();
        });
        t.inputEl.rows = 4;
        t.inputEl.style.width = "100%";
      });
  }
}
