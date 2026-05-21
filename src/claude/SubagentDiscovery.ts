/* Disk-based subagent definition discovery. Mirrors SkillDiscovery's
   structure and resolution order so behavior stays consistent with what the
   Claude Code CLI itself loads.

   Sources scanned (matches the CLI's own resolution order, last writer wins
   so project overrides user overrides plugin):
     1. plugin caches (~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/agents/*.md)
     2. ~/.claude/agents/*.md                  — user-global
     3. <vault>/.claude/agents/*.md            — project-scoped

   Each subagent is a markdown file with a YAML frontmatter header, e.g.:

       ---
       description: Use when you need to ...
       tools: Read, Bash, Edit          # optional; comma-separated OR YAML list
       model: opus                      # optional override
       ---
       System prompt body goes here. */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DiscoverySource } from "./SkillDiscovery";

export type SubagentEntry = {
  name: string;
  description?: string;
  /* Allowlist of tool names the subagent may use. Undefined means inherit
     all tools available in the parent session — same default the CLI uses
     when the frontmatter omits the field. */
  tools?: string[];
  /* Optional model override declared in the agent's frontmatter. */
  model?: string;
  /* Markdown body after the closing `---` fence. Becomes the subagent's
     system prompt when the Task tool spawns it. Capped at 50k chars to
     keep the in-memory catalog cheap on a vault with many large agents. */
  bodyText: string;
  source: DiscoverySource;
  /* Absolute path on disk, used by the manager modal's "Reveal" action. */
  filePath: string;
  /* Plugin display name when source === "plugin". */
  pluginName?: string;
};

export type SubagentCatalog = {
  agents: SubagentEntry[];
};

const BODY_TEXT_CAP = 50_000;

/* Parses YAML frontmatter and captures the body text after the closing
   fence. Mirrors SkillDiscovery's parseFrontmatter line-by-line key parser
   so quirks (folded continuation lines, quote stripping) stay consistent.
   Extended to surface the `tools` and `model` fields plus the body. */
function parseFrontmatterFull(content: string): {
  fields: Record<string, string>;
  /* Raw indented continuation lines, keyed by the most recent top-level key.
     Used to detect YAML-list shapes for fields like `tools:`. */
  continuations: Record<string, string[]>;
  bodyText: string;
} {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { fields: {}, continuations: {}, bodyText: content };
  const block = m[1];
  const bodyStart = m.index! + m[0].length;
  /* Skip a single leading newline after the closing fence so the body
     doesn't start with a blank line. */
  let body = content.slice(bodyStart);
  if (body.startsWith("\r\n")) body = body.slice(2);
  else if (body.startsWith("\n")) body = body.slice(1);

  const KEY_LINE = /^([a-z_][a-z0-9_-]*):\s*(.*)$/i;
  const fields: Record<string, string> = {};
  const continuations: Record<string, string[]> = {};
  let currentKey: string | null = null;
  const lines = block.split(/\r?\n/);
  for (const line of lines) {
    const km = line.match(KEY_LINE);
    if (km) {
      currentKey = km[1];
      fields[currentKey] = km[2] ?? "";
      continuations[currentKey] = [];
    } else if (currentKey !== null) {
      const trimmed = line.trim();
      if (trimmed) {
        fields[currentKey] = (fields[currentKey] ? fields[currentKey] + " " : "") + trimmed;
        continuations[currentKey].push(line);
      }
    }
  }
  return { fields, continuations, bodyText: body };
}

function cleanValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let v = raw.trim();
  if (!v) return undefined;
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  v = v.replace(/\s+/g, " ").trim();
  return v || undefined;
}

/* Splits a `tools:` value into a string array. Accepts either:
     tools: Read, Bash, Edit
   or:
     tools:
       - Read
       - Bash
   The plain parser collapses YAML-list continuation lines into a single
   space-joined string, so we detect the list shape by checking whether the
   first non-empty continuation line begins with `-`. */
function parseToolsField(
  inlineValue: string | undefined,
  continuationLines: string[] | undefined,
): string[] | undefined {
  const firstContinuation = continuationLines?.find(l => l.trim().length > 0);
  if (firstContinuation && firstContinuation.trim().startsWith("-")) {
    const out: string[] = [];
    for (const line of continuationLines ?? []) {
      const t = line.trim();
      if (!t.startsWith("-")) continue;
      const item = t.slice(1).trim().replace(/^["']|["']$/g, "");
      if (item) out.push(item);
    }
    return out.length > 0 ? out : undefined;
  }
  const cleaned = cleanValue(inlineValue);
  if (!cleaned) return undefined;
  const parts = cleaned
    .split(",")
    .map(s => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function listAgentsIn(agentsDir: string, source: DiscoverySource, pluginName?: string): SubagentEntry[] {
  if (!existsSync(agentsDir)) return [];
  let entries: string[] = [];
  try { entries = readdirSync(agentsDir); } catch { return []; }
  const out: SubagentEntry[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    if (!entry.endsWith(".md")) continue;
    const filePath = join(agentsDir, entry);
    try { if (!statSync(filePath).isFile()) continue; } catch { continue; }
    let content = "";
    try { content = readFileSync(filePath, "utf8"); } catch { continue; }
    const parsed = parseFrontmatterFull(content);
    const fmName = cleanValue(parsed.fields["name"]);
    const bodyText = parsed.bodyText.length > BODY_TEXT_CAP
      ? parsed.bodyText.slice(0, BODY_TEXT_CAP)
      : parsed.bodyText;
    out.push({
      name: fmName || entry.replace(/\.md$/, ""),
      description: cleanValue(parsed.fields["description"]),
      tools: parseToolsField(parsed.fields["tools"], parsed.continuations["tools"]),
      model: cleanValue(parsed.fields["model"]),
      bodyText,
      source,
      filePath,
      pluginName,
    });
  }
  return out;
}

/* Resolve install paths for every plugin entry in installed_plugins.json.
   Same shape SkillDiscovery uses; duplicated here so SubagentDiscovery has
   no inbound dependency on SkillDiscovery's internals beyond the shared
   DiscoverySource type. */
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

export function discoverSubagents(vaultPath: string): SubagentCatalog {
  const home = homedir();
  const agents: SubagentEntry[] = [];

  /* Plugin layer first so user / project later overrides win in dedupByName. */
  for (const { pluginName, installPath } of listInstalledPluginDirs()) {
    agents.push(...listAgentsIn(join(installPath, "agents"), "plugin", pluginName));
  }

  agents.push(...listAgentsIn(join(home, ".claude/agents"), "user"));

  if (vaultPath) {
    agents.push(...listAgentsIn(join(vaultPath, ".claude/agents"), "project"));
  }

  return { agents: dedupByName(agents) };
}

/* Later entries win, so project-scoped agents override user-scoped which
   override plugin-bundled ones of the same name. */
function dedupByName(entries: SubagentEntry[]): SubagentEntry[] {
  const seen = new Map<string, SubagentEntry>();
  for (const e of entries) seen.set(e.name, e);
  return Array.from(seen.values());
}
