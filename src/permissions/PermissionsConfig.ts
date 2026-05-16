import type { App } from "obsidian";

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
  constructor(private app: App) {}

  private async ensureDir(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(".claude"))) await adapter.mkdir(".claude");
  }

  async load(): Promise<SettingsJsonFile> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(SETTINGS_JSON_PATH))) return {};
    try {
      return JSON.parse(await adapter.read(SETTINGS_JSON_PATH)) as SettingsJsonFile;
    } catch {
      /* Malformed file — return empty so the UI lets the user re-author
         rather than blocking. The user can still hand-fix the file. */
      return {};
    }
  }

  async save(config: SettingsJsonFile): Promise<void> {
    await this.ensureDir();
    await this.app.vault.adapter.write(SETTINGS_JSON_PATH, JSON.stringify(config, null, 2));
  }

  async listAllow(): Promise<string[]> {
    const cfg = await this.load();
    return cfg.permissions?.allow ?? [];
  }

  async addAllow(pattern: string): Promise<boolean> {
    const trimmed = pattern.trim();
    if (!trimmed) return false;
    const cfg = await this.load();
    if (!cfg.permissions) cfg.permissions = {};
    if (!cfg.permissions.allow) cfg.permissions.allow = [];
    if (cfg.permissions.allow.includes(trimmed)) return false;
    cfg.permissions.allow.push(trimmed);
    await this.save(cfg);
    return true;
  }

  async addAllowMany(patterns: string[]): Promise<number> {
    const cfg = await this.load();
    if (!cfg.permissions) cfg.permissions = {};
    if (!cfg.permissions.allow) cfg.permissions.allow = [];
    let added = 0;
    for (const raw of patterns) {
      const p = raw.trim();
      if (!p || cfg.permissions.allow.includes(p)) continue;
      cfg.permissions.allow.push(p);
      added++;
    }
    if (added > 0) await this.save(cfg);
    return added;
  }

  async removeAllow(pattern: string): Promise<void> {
    const cfg = await this.load();
    if (!cfg.permissions?.allow) return;
    cfg.permissions.allow = cfg.permissions.allow.filter(p => p !== pattern);
    await this.save(cfg);
  }
}
