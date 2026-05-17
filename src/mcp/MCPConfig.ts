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

  async upsertServer(name: string, config: MCPServerConfig): Promise<void> {
    const cfg = await this.load();
    if (!cfg.mcpServers) cfg.mcpServers = {};
    cfg.mcpServers[name] = config;
    await this.save(cfg);
  }

  async removeServer(name: string): Promise<void> {
    const cfg = await this.load();
    if (cfg.mcpServers) delete cfg.mcpServers[name];
    await this.save(cfg);
  }
}
