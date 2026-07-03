import { Notice, type App, type DataAdapter } from "obsidian";

/* MCP server config schema. Mirrors Claude Code's `.mcp.json` and the
   Anthropic MCP spec. Servers can be stdio (command/args) or remote
   (url/headers). The CLI auto-detects from the `type` field. */
export type MCPServerConfig = {
  type?: "stdio" | "sse" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

export type MCPConfigFile = {
  mcpServers?: Record<string, MCPServerConfig>;
  /* Plugin-only field: configured-but-disabled MCP servers, kept out of
     the active `mcpServers` map so the Claude Code CLI never spawns them
     (the CLI ignores unknown top-level keys). Disabling moves an entry
     from `mcpServers` to here; re-enabling moves it back. Preserves the
     full config so disable is non-destructive.

     LEGACY: this `mcpServers` / `disabledMcpServers` split predates the
     realization that the CLI never reads this file, so toggling here had no
     runtime effect. The live per-vault enable/disable now lives in
     `disabledServers` below and is enforced at spawn via a `--settings`
     deny layer. These two maps are preserved on round-trip but no longer
     drive behavior. */
  disabledMcpServers?: Record<string, MCPServerConfig>;
  /* Per-vault disable list: display names (exactly as `claude mcp list`
     prints them) of servers the user has switched off for this vault's
     chats. The full server set comes from the CLI itself; this records only
     the user's per-vault opt-outs. At spawn each name becomes an
     `mcp__<sanitized>` deny rule passed via `--settings`, which removes that
     server's tools from the model's tool list — scoped to the plugin's
     subprocesses alone, so other Claude Code instances are unaffected. */
  disabledServers?: string[];
  /* Some configs also include a parallel `_claudian.servers` block — left
     intact on write so Claudian's UI keeps working alongside ours. */
  _claudian?: { servers?: Record<string, unknown> };
  /* Index signature preserves unknown top-level keys on round-trip so editing
     servers from the plugin UI never wipes other config the user added by
     hand (e.g. cross-tool metadata). */
  [key: string]: unknown;
};

/* Path Claudian uses, kept for cross-plugin compatibility per the user's
   memory. Located inside the vault so the MCP config travels with the vault. */
export const MCP_CONFIG_PATH = ".claude/mcp.json";

/* Claude Code names every MCP tool `mcp__<server>__<tool>`, where <server>
   is the configured display name with any character outside [A-Za-z0-9_-]
   replaced by an underscore. So "claude.ai Gmail" -> "claude_ai_Gmail" while
   "openai-image" keeps its hyphen. Verified against the live tool list the
   CLI advertises. A server-level deny rule omits the <tool> segment. */
export function sanitizeMcpServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_");
}

/* The permission rule that disables a whole MCP server: matching the
   `mcp__<server>` prefix removes every one of that server's tools from the
   model's advertised tool list. Verified: denying `mcp__Perplexity` drops
   all four Perplexity tools from the init event's tool set. */
export function mcpDenyPattern(name: string): string {
  return `mcp__${sanitizeMcpServerName(name)}`;
}

/* Atomic JSON writer: stage to a per-write `<path>.<token>.tmp`, then rename
   over the target. Prevents truncation on crash mid-write. The unique token
   keeps two concurrent writers to the same path from sharing one staging file
   (which could interleave into a corrupt result). Exported so Persistence and
   PermissionsConfig share one implementation. */
export async function writeJsonAtomic(
  adapter: DataAdapter,
  path: string,
  data: unknown,
): Promise<void> {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const tmp = `${path}.${token}.tmp`;
  const payload = JSON.stringify(data, null, 2);
  await adapter.write(tmp, payload);
  /* adapter.rename atomically replaces the destination on POSIX. On adapters
     that disallow overwrite, retry with the existing file moved ASIDE (not
     deleted) — if the retry also fails, the old data is still recoverable at
     the .bak and the new payload still lives in the tmp. The previous
     delete-then-retry fallback could destroy BOTH copies on a double rename
     failure (e.g. transient iCloud locks). */
  try {
    await adapter.rename(tmp, path);
  } catch (err) {
    const bak = `${path}.${token}.bak`;
    try {
      if (await adapter.exists(path)) await adapter.rename(path, bak);
      await adapter.rename(tmp, path);
      try { if (await adapter.exists(bak)) await adapter.remove(bak); } catch { /* ignore */ }
    } catch (err2) {
      /* Roll the original back into place if we moved it and the retry died.
         Keep the tmp — it holds the only copy of the new payload. */
      try {
        if (!(await adapter.exists(path)) && (await adapter.exists(bak))) await adapter.rename(bak, path);
      } catch { /* ignore — .bak remains on disk for manual recovery */ }
      throw err2;
    }
  }
}

/* Module-level write chain keyed by config path. MCPConfigStore is
   instantiated fresh at every call site (main.ts, TabController, the manager
   modal), so a per-instance lock wouldn't serialize across surfaces. Keying
   the chain on the path makes every mutator that touches the same file (e.g.
   two rapid MCP toggles) run its load-mutate-save strictly in sequence, so a
   second load() can't start before the first save() lands and silently lose
   the first update. Mirrors PermissionsConfigStore.writeChain, hoisted to
   module scope because the stores aren't singletons. */
const mcpWriteChains = new Map<string, Promise<void>>();

function runOnMcpWriteChain<T>(path: string, op: () => Promise<T>): Promise<T> {
  const prev = mcpWriteChains.get(path) ?? Promise.resolve();
  const next = prev.then(op);
  /* Swallow rejections on the stored chain so one failed write doesn't poison
     every future write; the rejection still surfaces via the returned promise. */
  mcpWriteChains.set(path, next.then(() => undefined, () => undefined));
  return next;
}

export class MCPConfigStore {
  constructor(private app: App) {}

  async ensureDir(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(".claude"))) await adapter.mkdir(".claude");
  }

  async load(): Promise<MCPConfigFile> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(MCP_CONFIG_PATH))) return { mcpServers: {} };
    const text = await adapter.read(MCP_CONFIG_PATH);
    try {
      const parsed = JSON.parse(text) as MCPConfigFile;
      if (!parsed.mcpServers) parsed.mcpServers = {};
      return parsed;
    } catch {
      /* Rotate the corrupted file to .bak so the user can recover their
         hand-edits, then return defaults so the UI doesn't block. Surface
         a Notice so they know their edits got rejected and where the
         backup landed. */
      const bak = `${MCP_CONFIG_PATH}.bak`;
      try {
        await adapter.write(bak, text);
        new Notice(`Could not parse ${MCP_CONFIG_PATH}; backup saved to ${bak}`);
      } catch {
        new Notice(`Could not parse ${MCP_CONFIG_PATH}; backup write also failed`);
      }
      return { mcpServers: {} };
    }
  }

  async save(config: MCPConfigFile): Promise<void> {
    await this.ensureDir();
    /* Spread-merge so any unknown top-level keys present in `config` are
       written through verbatim. Callers pass the previously loaded object
       (possibly mutated), so this preserves cross-tool metadata that the
       MCPConfigFile type doesn't explicitly model. */
    const payload: Record<string, unknown> = { ...config };
    await writeJsonAtomic(this.app.vault.adapter, MCP_CONFIG_PATH, payload);
  }

  async listServers(): Promise<Array<{ name: string; config: MCPServerConfig }>> {
    const cfg = await this.load();
    const servers = cfg.mcpServers ?? {};
    return Object.entries(servers).map(([name, config]) => ({ name, config }));
  }

  /* Returns all servers including disabled ones, tagged with their state.
     Used by the cost-surface popup and the MCP manager modal so the user
     can see and re-enable previously-disabled servers without losing
     them. Enabled servers sort first, then disabled, each alphabetically
     within their group. */
  async listAllServers(): Promise<Array<{ name: string; config: MCPServerConfig; enabled: boolean }>> {
    const cfg = await this.load();
    const enabled = Object.entries(cfg.mcpServers ?? {}).map(([name, config]) => ({ name, config, enabled: true }));
    const disabled = Object.entries(cfg.disabledMcpServers ?? {}).map(([name, config]) => ({ name, config, enabled: false }));
    enabled.sort((a, b) => a.name.localeCompare(b.name));
    disabled.sort((a, b) => a.name.localeCompare(b.name));
    return [...enabled, ...disabled];
  }

  /* ----- Per-vault enable/disable (the live model) -------------------- */

  /* Display names the user has disabled for this vault. The authoritative
     server set comes from `claude mcp list`; this is only the opt-out list. */
  async getDisabledServerNames(): Promise<string[]> {
    const cfg = await this.load();
    const list = cfg.disabledServers;
    return Array.isArray(list) ? list.filter(n => typeof n === "string") : [];
  }

  /* Add or remove a server name from the per-vault disable list. Returns
     true if the file changed (idempotent otherwise), so callers know whether
     to recompute deny patterns and surface the "restart chat to apply"
     notice. Drops the key entirely when the list empties to keep the file
     tidy. */
  async setServerDisabled(name: string, disabled: boolean): Promise<boolean> {
    return runOnMcpWriteChain(MCP_CONFIG_PATH, async () => {
      const cfg = await this.load();
      const set = new Set(Array.isArray(cfg.disabledServers) ? cfg.disabledServers : []);
      const had = set.has(name);
      if (disabled) {
        if (had) return false;
        set.add(name);
      } else {
        if (!had) return false;
        set.delete(name);
      }
      if (set.size === 0) delete cfg.disabledServers;
      else cfg.disabledServers = Array.from(set);
      await this.save(cfg);
      return true;
    });
  }

  /* The `mcp__<server>` deny rules for every disabled server, ready to hand
     to the CLI via `--settings`. Empty array means nothing is disabled, so
     the spawn path can skip the flag entirely. */
  async getDenyPatterns(): Promise<string[]> {
    const names = await this.getDisabledServerNames();
    return names.map(mcpDenyPattern);
  }

  async upsertServer(name: string, config: MCPServerConfig): Promise<void> {
    await runOnMcpWriteChain(MCP_CONFIG_PATH, async () => {
      const cfg = await this.load();
      if (!cfg.mcpServers) cfg.mcpServers = {};
      cfg.mcpServers[name] = config;
      /* Edits to a name that previously existed as disabled should clear the
         stale disabled entry, otherwise we'd carry duplicate definitions. */
      if (cfg.disabledMcpServers && cfg.disabledMcpServers[name]) {
        delete cfg.disabledMcpServers[name];
      }
      await this.save(cfg);
    });
  }

  async removeServer(name: string): Promise<void> {
    await runOnMcpWriteChain(MCP_CONFIG_PATH, async () => {
      const cfg = await this.load();
      if (cfg.mcpServers) delete cfg.mcpServers[name];
      /* Also clear any disabled-side entry under the same name so deletion is
         a full purge regardless of which bucket the server was sitting in. */
      if (cfg.disabledMcpServers) delete cfg.disabledMcpServers[name];
      /* And drop it from the live per-vault disable list — the ONLY field that
         drives spawn deny rules. Otherwise a removed server stays permanently
         deny-listed and would poison a future server that sanitizes to the same
         name. */
      if (Array.isArray(cfg.disabledServers)) {
        cfg.disabledServers = cfg.disabledServers.filter(n => n !== name);
        if (cfg.disabledServers.length === 0) delete cfg.disabledServers;
      }
      await this.save(cfg);
    });
  }

  /* Toggle a server's enabled state by moving its config between the
     active `mcpServers` map and the plugin-private `disabledMcpServers`
     map. Idempotent: enabling an already-enabled server (or disabling an
     already-disabled one) is a no-op. Returns true if the file changed,
     false otherwise — callers use this to decide whether to surface the
     "restart chat to apply" notice. */
  async setEnabled(name: string, enabled: boolean): Promise<boolean> {
    return runOnMcpWriteChain(MCP_CONFIG_PATH, async () => {
      const cfg = await this.load();
      const active = cfg.mcpServers ?? {};
      const archive = cfg.disabledMcpServers ?? {};
      if (enabled) {
        if (active[name]) return false; /* already enabled */
        const config = archive[name];
        if (!config) return false; /* nothing to enable */
        active[name] = config;
        delete archive[name];
      } else {
        if (archive[name]) return false; /* already disabled */
        const config = active[name];
        if (!config) return false; /* nothing to disable */
        archive[name] = config;
        delete active[name];
      }
      cfg.mcpServers = active;
      cfg.disabledMcpServers = archive;
      /* Clean up empty maps so the file stays tidy when one side empties. */
      if (Object.keys(cfg.disabledMcpServers).length === 0) delete cfg.disabledMcpServers;
      if (Object.keys(cfg.mcpServers).length === 0) cfg.mcpServers = {};
      await this.save(cfg);
      return true;
    });
  }
}
