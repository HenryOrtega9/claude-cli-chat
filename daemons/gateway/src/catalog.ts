/* /catalog — everything the phone's composer needs to render its pickers
   without shipping a copy of the desktop's disk-scanning code.

   Sources are the same ones the desktop shell uses: SkillDiscovery and
   SubagentDiscovery walk disk, `claude mcp list` is the authoritative MCP set
   (the vault's .claude/mcp.json is only the per-vault opt-out list — the CLI
   ignores that file entirely), and the model/effort/permission catalogs come
   from settings-data so the phone and the desktop can never disagree about
   which models exist or which of them support xhigh.

   `catalogHash` lets a client skip re-rendering its pickers when nothing
   changed across a reconnect. */

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

import { discoverSkillsAndCommands } from "../../../src/claude/SkillDiscovery";
import { discoverSubagents } from "../../../src/claude/SubagentDiscovery";
import { listMcpServersViaCli } from "../../../src/mcp/McpServerList";
import { MCPConfigStore } from "../../../src/mcp/MCPConfig";
import {
  EFFORT_ORDER,
  MODEL_GROUPS,
  MODEL_IDS,
  MODEL_LABELS,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODE_ORDER,
  effortLevelsForModel,
  type ModelKey,
} from "../../../src/settings-data";

export type Catalog = {
  skills: unknown[];
  commands: unknown[];
  subagents: unknown[];
  models: Array<{ key: string; id: string; label: string; efforts: string[]; group: string }>;
  efforts: string[];
  permissionModes: Array<{ key: string; label: string }>;
  mcpServers: Array<{ name: string; enabled: boolean; status?: string }>;
  userName: string;
  hash: string;
};

/* Local copy of settings-data's autodetectUserName / autodetectClaudePath
   behavior. Importing them would bind the daemon to a module the shared-ui
   refactor is actively moving; the daemon needs exactly two values and both
   are three lines. */
export function detectUserName(): string {
  try {
    const out = execSync("dscl . -read /Users/$USER RealName 2>/dev/null | sed -n 's/^ //p' | tail -1", {
      encoding: "utf8",
      timeout: 1000,
      shell: "/bin/sh",
    }).trim();
    if (out) return out;
  } catch { /* fall through to $USER */ }
  const u = process.env.USER ?? "";
  return u ? u.charAt(0).toUpperCase() + u.slice(1) : "";
}

export function detectClaudePath(): string {
  const home = process.env.HOME ?? "";
  for (const p of [`${home}/.local/bin/claude`, "/usr/local/bin/claude", "/opt/homebrew/bin/claude", `${home}/.npm-global/bin/claude`]) {
    if (existsSync(p)) return p;
  }
  try {
    return execSync("command -v claude", { encoding: "utf8", timeout: 3000 }).trim();
  } catch {
    return "claude";
  }
}

function modelCatalog() {
  const groupOf = new Map<string, string>();
  for (const g of MODEL_GROUPS) for (const k of g.keys) groupOf.set(k, g.header);
  return (Object.keys(MODEL_IDS) as ModelKey[]).map(key => ({
    key,
    id: MODEL_IDS[key],
    label: MODEL_LABELS[key],
    efforts: effortLevelsForModel(key) as string[],
    group: groupOf.get(key) ?? "OTHER",
  }));
}

export async function buildCatalog(vault: string, claudePath: string, log: (m: string) => void): Promise<Catalog> {
  let skills: unknown[] = [];
  let commands: unknown[] = [];
  try {
    const found = discoverSkillsAndCommands(vault);
    skills = found.skills;
    commands = found.commands;
  } catch (err) {
    log(`skill discovery failed: ${String(err)}`);
  }

  let subagents: unknown[] = [];
  try {
    subagents = discoverSubagents(vault).agents;
  } catch (err) {
    log(`subagent discovery failed: ${String(err)}`);
  }

  /* The disable list is per-vault and lives in .claude/mcp.json; the server
     set itself comes from the CLI. A failed `claude mcp list` degrades to an
     empty list rather than a 500 — the phone shows no MCP pill, and every
     other picker still works. */
  let mcpServers: Catalog["mcpServers"] = [];
  try {
    const disabled = new Set(await new MCPConfigStore(null).getDisabledServerNames());
    const servers = await listMcpServersViaCli(claudePath);
    mcpServers = servers.map(s => ({ name: s.name, enabled: !disabled.has(s.name), status: s.status }));
  } catch (err) {
    log(`mcp list failed: ${String(err)}`);
  }

  const body = {
    skills,
    commands,
    subagents,
    models: modelCatalog(),
    efforts: EFFORT_ORDER as string[],
    /* bypassPermissions is omitted deliberately: the contract forbids a phone
       tab from ever running in it, so it must not appear as a choice. */
    permissionModes: PERMISSION_MODE_ORDER
      .filter(m => m !== "bypassPermissions")
      .map(m => ({ key: m, label: PERMISSION_MODE_LABELS[m] })),
    mcpServers,
    userName: detectUserName(),
  };
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 12);
  return { ...body, hash };
}
