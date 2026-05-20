import { Notice, type App } from "obsidian";
import { writeJsonAtomic } from "../mcp/MCPConfig";

/* Schema mirrors Claude Code's <vault>/.claude/settings.json `permissions`
   block. Unknown top-level keys ($schema, enabledPlugins, hooks, env, etc.)
   are preserved on round-trip so editing the allowlist from the plugin UI
   never wipes other config the user added by hand or via the CLI. */
export type PermissionsBlock = {
  allow?: string[];
  deny?: string[];
  ask?: string[];
};

export type SettingsJsonFile = {
  permissions?: PermissionsBlock;
  [key: string]: unknown;
};

export const SETTINGS_JSON_PATH = ".claude/settings.json";

/* Curated read-only / low-risk Bash patterns covering ~80% of routine
   prompts in vault-driven sessions. Each entry uses Claude Code's allow-
   pattern syntax: `ToolName(prefix:*)` matches commands starting with
   `prefix `; `ToolName(literal)` matches that exact command; `ToolName`
   alone is a blanket approve for that tool. */
export const RECOMMENDED_ALLOW_PATTERNS: string[] = [
  // File writes / edits (covers Write, Edit line-deletions, batch + notebook)
  "Edit",
  "Write",
  "MultiEdit",
  "NotebookEdit",
  // Read-only file inspection
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(less:*)",
  "Bash(wc:*)",
  "Bash(file:*)",
  // Search
  "Bash(grep:*)",
  "Bash(rg:*)",
  "Bash(find:*)",
  "Bash(fd:*)",
  // Listing / nav
  "Bash(ls:*)",
  "Bash(pwd)",
  "Bash(tree:*)",
  "Bash(stat:*)",
  // Git read-only
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git branch:*)",
  "Bash(git remote:*)",
  // Plugin dev (used regularly when iterating on claude-cli-chat itself)
  "Bash(npm run typecheck)",
  "Bash(npm run build)",
];

export class PermissionsConfigStore {
  /* Serializes load-mutate-save operations so concurrent add/remove calls
     don't race on the shared settings.json. Each mutator chains onto this
     promise; readers stay lock-free since stale reads are tolerable. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private app: App) {}

  private async ensureDir(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(".claude"))) await adapter.mkdir(".claude");
  }

  async load(): Promise<SettingsJsonFile> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(SETTINGS_JSON_PATH))) return {};
    const text = await adapter.read(SETTINGS_JSON_PATH);
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object") return {};
      const cfg = parsed as SettingsJsonFile;
      /* Defensive normalization: permissions may be present-but-null (user
         hand-edit) or `allow` may be a string/null instead of an array.
         Treat any non-array allow as empty; it will be overwritten on the
         next save so we don't silently drop a bad shape forever. */
      if (cfg.permissions === null || cfg.permissions === undefined) {
        /* leave as undefined; callers default it */
      } else if (typeof cfg.permissions === "object") {
        const allow = (cfg.permissions as PermissionsBlock).allow;
        if (!Array.isArray(allow)) {
          (cfg.permissions as PermissionsBlock).allow = [];
        }
      }
      return cfg;
    } catch {
      /* Rotate corrupted file to .bak so user can recover hand-edits, then
         return defaults so the UI doesn't block. Surface a Notice so the
         user knows their edits got rejected. */
      const bak = `${SETTINGS_JSON_PATH}.bak`;
      try {
        await adapter.write(bak, text);
        new Notice(`Could not parse ${SETTINGS_JSON_PATH}; backup saved to ${bak}`);
      } catch {
        new Notice(`Could not parse ${SETTINGS_JSON_PATH}; backup write also failed`);
      }
      return {};
    }
  }

  async save(config: SettingsJsonFile): Promise<void> {
    await this.ensureDir();
    await writeJsonAtomic(this.app.vault.adapter, SETTINGS_JSON_PATH, config);
  }

  async listAllow(): Promise<string[]> {
    const cfg = await this.load();
    const allow = cfg.permissions?.allow;
    return Array.isArray(allow) ? allow : [];
  }

  addAllow(pattern: string): Promise<boolean> {
    const trimmed = pattern.trim();
    if (!trimmed) return Promise.resolve(false);
    /* Chain onto writeChain so concurrent calls don't clobber each other.
       Capture the resolved value via a sentinel so the outer promise can
       still return boolean. */
    let result = false;
    const next = this.writeChain.then(async () => {
      const cfg = await this.load();
      if (!cfg.permissions) cfg.permissions = {};
      if (!Array.isArray(cfg.permissions.allow)) cfg.permissions.allow = [];
      if (cfg.permissions.allow.includes(trimmed)) { result = false; return; }
      cfg.permissions.allow.push(trimmed);
      await this.save(cfg);
      result = true;
    });
    /* Swallow rejections on the chain so one failed write doesn't poison
       all future writes; surface them to the caller via the returned promise. */
    this.writeChain = next.catch(() => undefined);
    return next.then(() => result);
  }

  addAllowMany(patterns: string[]): Promise<number> {
    let added = 0;
    const next = this.writeChain.then(async () => {
      const cfg = await this.load();
      if (!cfg.permissions) cfg.permissions = {};
      if (!Array.isArray(cfg.permissions.allow)) cfg.permissions.allow = [];
      for (const raw of patterns) {
        const p = raw.trim();
        if (!p || cfg.permissions.allow.includes(p)) continue;
        cfg.permissions.allow.push(p);
        added++;
      }
      if (added > 0) await this.save(cfg);
    });
    this.writeChain = next.catch(() => undefined);
    return next.then(() => added);
  }

  removeAllow(pattern: string): Promise<void> {
    const next = this.writeChain.then(async () => {
      const cfg = await this.load();
      const allow = cfg.permissions?.allow;
      if (!Array.isArray(allow)) return;
      cfg.permissions!.allow = allow.filter(p => p !== pattern);
      await this.save(cfg);
    });
    this.writeChain = next.catch(() => undefined);
    return next;
  }
}
