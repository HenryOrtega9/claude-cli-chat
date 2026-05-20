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
     full config so disable is non-destructive. */
  disabledMcpServers?: Record<string, MCPServerConfig>;
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

/* Atomic JSON writer: stage to `<path>.tmp`, then rename over the target.
   Prevents truncation on crash mid-write. Exported so Persistence and
   PermissionsConfig share one implementation. */
export async function writeJsonAtomic(
  adapter: DataAdapter,
  path: string,
  data: unknown,
): Promise<void> {
  const tmp = `${path}.tmp`;
  const payload = JSON.stringify(data, null, 2);
  await adapter.write(tmp, payload);
  /* adapter.rename atomically replaces the destination on POSIX. On Windows
     adapters that disallow overwrite, the existing file is removed first
     to avoid EEXIST. Wrapped in a try so we always clean up the tmp file. */
  try {
    await adapter.rename(tmp, path);
  } catch (err) {
    try {
      if (await adapter.exists(path)) await adapter.remove(path);
      await adapter.rename(tmp, path);
    } catch (err2) {
      /* Best-effort cleanup of the stale tmp so it doesn't accumulate. */
      try { if (await adapter.exists(tmp)) await adapter.remove(tmp); } catch { /* ignore */ }
      throw err2;
    }
  }
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

  async upsertServer(name: string, config: MCPServerConfig): Promise<void> {
    const cfg = await this.load();
    if (!cfg.mcpServers) cfg.mcpServers = {};
    cfg.mcpServers[name] = config;
    /* Edits to a name that previously existed as disabled should clear the
       stale disabled entry, otherwise we'd carry duplicate definitions. */
    if (cfg.disabledMcpServers && cfg.disabledMcpServers[name]) {
      delete cfg.disabledMcpServers[name];
    }
    await this.save(cfg);
  }

  async removeServer(name: string): Promise<void> {
    const cfg = await this.load();
    if (cfg.mcpServers) delete cfg.mcpServers[name];
    /* Also clear any disabled-side entry under the same name so deletion is
       a full purge regardless of which bucket the server was sitting in. */
    if (cfg.disabledMcpServers) delete cfg.disabledMcpServers[name];
    await this.save(cfg);
  }

  /* Toggle a server's enabled state by moving its config between the
     active `mcpServers` map and the plugin-private `disabledMcpServers`
     map. Idempotent: enabling an already-enabled server (or disabling an
     already-disabled one) is a no-op. Returns true if the file changed,
     false otherwise — callers use this to decide whether to surface the
     "restart chat to apply" notice. */
  async setEnabled(name: string, enabled: boolean): Promise<boolean> {
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
  }
}
