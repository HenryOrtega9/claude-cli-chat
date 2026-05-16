import type { App } from "obsidian";

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
};

/* Path Claudian uses, kept for cross-plugin compatibility per the user's
   memory. Located inside the vault so the MCP config travels with the vault. */
export const MCP_CONFIG_PATH = ".claude/mcp.json";

export class MCPConfigStore {
  constructor(private app: App) {}

  async ensureDir(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(".claude"))) await adapter.mkdir(".claude");
  }

  async load(): Promise<MCPConfigFile> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(MCP_CONFIG_PATH))) return { mcpServers: {} };
    try {
      const text = await adapter.read(MCP_CONFIG_PATH);
      const parsed = JSON.parse(text) as MCPConfigFile;
      if (!parsed.mcpServers) parsed.mcpServers = {};
      return parsed;
    } catch {
      /* Surface the parse error to the caller as an empty config; the modal
         will let the user re-author rather than block on a malformed file. */
      return { mcpServers: {} };
    }
  }

  async save(config: MCPConfigFile): Promise<void> {
    await this.ensureDir();
    await this.app.vault.adapter.write(MCP_CONFIG_PATH, JSON.stringify(config, null, 2));
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
