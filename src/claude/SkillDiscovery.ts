/* Disk-based skill + slash-command discovery. Runs at plugin load so the
   slash-command suggestion popup can show the full catalog before the CLI's
   `system/init` event arrives (init only fires after the first user message
   is read on stdin — see the wire-format gotchas doc). The init payload, when
   it eventually arrives, replaces this cache on the affected tab.

   Sources scanned (matches the CLI's own resolution order):
     1. ~/.claude/{skills,commands}             — user-global
     2. <vault>/.claude/{skills,commands}       — project-scoped
     3. installed plugin caches                  — per installed_plugins.json
        (~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/{skills,commands})

   CLI built-ins (clear, compact, context, init, review, …) are appended last
   so the popup feels complete on first paint. */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type DiscoverySource = "user" | "project" | "plugin" | "builtin";

export type DiscoveredEntry = {
  name: string;
  description?: string;
  source: DiscoverySource;
  /* Plugin display name when source === "plugin". */
  pluginName?: string;
};

export type DiscoveryResult = {
  skills: DiscoveredEntry[];
  commands: DiscoveredEntry[];
};

/* Known CLI built-in slash commands. Not exhaustive — observed from a live
   init event on Claude Code 2.1.143. New built-ins will appear in the popup
   once the user sends a message and the real init payload supersedes this
   list. Keep alphabetized within concern groups. */
const BUILTIN_COMMANDS: { name: string; description: string }[] = [
  { name: "clear",            description: "Clear conversation history" },
  { name: "compact",          description: "Summarize and compact the context window" },
  { name: "context",          description: "Show context window usage" },
  { name: "init",             description: "Initialize a new CLAUDE.md" },
  { name: "review",           description: "Review a pull request" },
  { name: "security-review",  description: "Security review of pending changes" },
  { name: "usage",            description: "Show usage statistics" },
  { name: "extra-usage",      description: "Extra usage details" },
  { name: "insights",         description: "Show conversation insights" },
];

function parseFrontmatter(content: string): { name?: string; description?: string } {
  /* Frontmatter must be the first chars of the file, `---` fenced. Multi-line
     description values (folded or block) are common in skill SKILL.md files;
     keep the regex lazy and let later cleanup trim it. */
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const block = m[1];
  const nameMatch = block.match(/^name:\s*(.+)$/m);
  const descMatch = block.match(/^description:\s*([\s\S]+?)(?=\n[a-zA-Z_-]+:\s|\n*$)/);
  let description = descMatch?.[1]?.trim();
  /* Strip surrounding quotes (single OR double) — they're a YAML convention,
     not part of the value. */
  if (description) {
    if ((description.startsWith('"') && description.endsWith('"')) ||
        (description.startsWith("'") && description.endsWith("'"))) {
      description = description.slice(1, -1);
    }
    /* Collapse whitespace runs so a multi-line description displays as one
       trimmed line in the suggestion popup. */
    description = description.replace(/\s+/g, " ").trim();
  }
  return {
    name: nameMatch?.[1]?.trim(),
    description,
  };
}

function listSkillsIn(skillsDir: string, source: DiscoverySource, pluginName?: string): DiscoveredEntry[] {
  if (!existsSync(skillsDir)) return [];
  let entries: string[] = [];
  try { entries = readdirSync(skillsDir); } catch { return []; }
  const out: DiscoveredEntry[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const skillPath = join(skillsDir, entry);
    try { if (!statSync(skillPath).isDirectory()) continue; } catch { continue; }
    const skillMd = join(skillPath, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    let content = "";
    try { content = readFileSync(skillMd, "utf8"); } catch { continue; }
    const fm = parseFrontmatter(content);
    out.push({ name: fm.name || entry, description: fm.description, source, pluginName });
  }
  return out;
}

function listCommandsIn(commandsDir: string, source: DiscoverySource, pluginName?: string): DiscoveredEntry[] {
  if (!existsSync(commandsDir)) return [];
  let entries: string[] = [];
  try { entries = readdirSync(commandsDir); } catch { return []; }
  const out: DiscoveredEntry[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const cmdPath = join(commandsDir, entry);
    let content = "";
    try { content = readFileSync(cmdPath, "utf8"); } catch { continue; }
    const fm = parseFrontmatter(content);
    out.push({
      name: entry.replace(/\.md$/, ""),
      description: fm.description,
      source,
      pluginName,
    });
  }
  return out;
}

/* Resolve install paths for every plugin entry in installed_plugins.json.
   The file's `plugins` map is keyed by `<plugin>@<marketplace>`; each value
   is an array of install records (a plugin can be installed at both user
   and project scope simultaneously). */
function listInstalledPluginDirs(): Array<{ pluginName: string; installPath: string }> {
  const home = homedir();
  const installedPluginsFile = join(home, ".claude/plugins/installed_plugins.json");
  if (!existsSync(installedPluginsFile)) return [];
  let raw: string;
  try { raw = readFileSync(installedPluginsFile, "utf8"); } catch { return []; }
  let data: { plugins?: Record<string, Array<{ installPath?: string }>> };
  try { data = JSON.parse(raw); } catch { return []; }
  const out: Array<{ pluginName: string; installPath: string }> = [];
  for (const [key, installs] of Object.entries(data.plugins ?? {})) {
    if (!Array.isArray(installs)) continue;
    const pluginName = key.split("@")[0];
    for (const install of installs) {
      if (install && typeof install.installPath === "string") {
        out.push({ pluginName, installPath: install.installPath });
      }
    }
  }
  return out;
}

export function discoverSkillsAndCommands(vaultPath: string): DiscoveryResult {
  const home = homedir();
  const skills: DiscoveredEntry[] = [];
  const commands: DiscoveredEntry[] = [];

  skills.push(...listSkillsIn(join(home, ".claude/skills"), "user"));
  commands.push(...listCommandsIn(join(home, ".claude/commands"), "user"));

  if (vaultPath) {
    skills.push(...listSkillsIn(join(vaultPath, ".claude/skills"), "project"));
    commands.push(...listCommandsIn(join(vaultPath, ".claude/commands"), "project"));
  }

  for (const { pluginName, installPath } of listInstalledPluginDirs()) {
    skills.push(...listSkillsIn(join(installPath, "skills"), "plugin", pluginName));
    commands.push(...listCommandsIn(join(installPath, "commands"), "plugin", pluginName));
  }

  for (const b of BUILTIN_COMMANDS) {
    commands.push({ name: b.name, description: b.description, source: "builtin" });
  }

  /* De-dup by name within each list. Later entries (e.g. user override of a
     plugin command of the same name) win. Skills and commands keep separate
     namespaces because the CLI treats them as distinct concepts (skills are
     invoked via the Skill tool; commands run a prompt template). */
  return { skills: dedupByName(skills), commands: dedupByName(commands) };
}

function dedupByName(entries: DiscoveredEntry[]): DiscoveredEntry[] {
  const seen = new Map<string, DiscoveredEntry>();
  for (const e of entries) seen.set(e.name, e);
  return Array.from(seen.values());
}
