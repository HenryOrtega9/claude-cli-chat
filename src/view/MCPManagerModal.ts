import { platform, PlatformModal, type AppHandle } from "../platform";
import { MCPConfigStore, sanitizeMcpServerName } from "../mcp/MCPConfig";
import type { ParsedMcpServer } from "../mcp/McpServerList";
import type { PluginHost } from "../platform/host";

/* Same local check as TabBar.ts / MessageRenderer.ts (each file keeps its own
   rather than sharing one, per the existing convention) — gates touch-only
   behavior so the plugin/desktop build (mouse, hover available) is unchanged. */
function isTouchHost(): boolean {
  try {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
  } catch { return false; }
}

/* Modal for per-vault MCP server control. Lists every server the Claude Code
   CLI actually loads (via `claude mcp list` — the authoritative source, since
   the CLI ignores our vault-local .claude/mcp.json), each with a checkbox.
   Unchecking a server disables it for THIS vault's chats only: the plugin
   spawns its subprocesses with an `mcp__<server>` deny rule passed through
   `--settings`, which removes that server's tools from the model's tool list.
   The user's terminal and any other Claude Code instances are untouched, and
   the server's definition is never modified — disabling is purely a per-vault
   visibility gate.

   Server definitions (command, URL, env, auth) are owned by Claude Code and
   managed with `claude mcp add` / `claude mcp remove`; this modal intentionally
   does not edit them, so it can't drift from or corrupt the CLI's own config. */
export class MCPManagerModal extends PlatformModal {
  private plugin: PluginHost;
  private store: MCPConfigStore;
  /* Set on close so async list/toggle callbacks that resolve after the user
     dismissed the modal don't touch a torn-down DOM. */
  private closed = false;
  private loading = false;
  private servers: ParsedMcpServer[] | null = null;
  private listError: string | null = null;
  private disabled = new Set<string>();
  /* sanitizeMcpServerName() is many-to-one (e.g. "Foo Bar" and "Foo.Bar"
     both -> "Foo_Bar"), and the deny rule passed at spawn is built purely
     from that sanitized id (mcp__<sanitized>). Two colliding server names
     can't be fully disambiguated from inside this plugin — the CLI's own
     tool ids use the identical sanitize scheme — so this only detects and
     warns rather than attempting a fix. Set on every refresh(). */
  private collidingNames: string[] | null = null;
  /* Fires once from onClose. ClaudeChatView uses it to refresh the active
     tab's cost-surface pill in case toggles changed the enabled set. */
  private onClosed: (() => void) | null = null;

  constructor(app: AppHandle, plugin: PluginHost, onClosed?: () => void) {
    super(app);
    this.plugin = plugin;
    this.store = new MCPConfigStore(app);
    this.onClosed = onClosed ?? null;
  }

  async onOpen() {
    const { titleEl } = this;
    titleEl.setText("MCP servers");
    this.contentEl.addClass("claudian-mcp-modal");
    await this.refresh(false);
  }

  onClose() {
    this.closed = true;
    this.contentEl.empty();
    if (this.onClosed) {
      try { this.onClosed(); } catch { /* never let a refresh callback break teardown */ }
      this.onClosed = null;
    }
  }

  /* Load the server list (cached unless forced) and the per-vault disable
     set, then paint. Failures to list still render the disabled names so the
     user keeps a way to re-enable, plus an error banner. */
  private async refresh(force: boolean) {
    this.loading = true;
    this.listError = null;
    this.render();
    try {
      const [servers, disabledNames] = await Promise.all([
        this.plugin.getMcpServers(force),
        this.store.getDisabledServerNames(),
      ]);
      if (this.closed) return;
      this.servers = servers;
      this.disabled = new Set(disabledNames);
      this.collidingNames = this.detectCollisions(servers);
    } catch (err) {
      if (this.closed) return;
      this.listError = (err as Error).message || String(err);
      try { this.disabled = new Set(await this.store.getDisabledServerNames()); } catch { /* keep prior */ }
    } finally {
      this.loading = false;
      if (!this.closed) this.render();
    }
  }

  /* Returns the subset of display names whose sanitized id collides with
     at least one other server's. Empty when there's nothing to warn about
     (the overwhelmingly common case). */
  private detectCollisions(servers: ParsedMcpServer[]): string[] {
    const bySid = new Map<string, string[]>();
    for (const s of servers) {
      const sid = sanitizeMcpServerName(s.name);
      (bySid.get(sid) ?? bySid.set(sid, []).get(sid)!).push(s.name);
    }
    return [...bySid.values()].filter(names => names.length > 1).flat();
  }

  private render() {
    const { contentEl } = this;
    contentEl.empty();

    const intro = contentEl.createDiv({ cls: "claudian-mcp-intro" });
    intro.createEl("p", {
      text:
        "These are the MCP servers your Claude Code setup loads. Unchecking one "
        + "disables it for this vault's chats only — it stays available in your "
        + "terminal and every other Claude Code instance. Restart the active tab "
        + "(/clear) after a change to apply it.",
    });
    intro.createEl("p", {
      cls: "claudian-mcp-intro-sub",
      text:
        "Server definitions are managed by Claude Code (claude mcp add / remove); "
        + "this view only toggles per-vault availability.",
    });

    const headerRow = contentEl.createDiv({ cls: "claudian-mcp-header-row" });
    const all = this.servers ?? [];
    const enabledCount = all.filter(s => !this.disabled.has(s.name)).length;
    const disabledCount = all.length - enabledCount;
    const heading = this.loading && !this.servers
      ? "Loading servers…"
      : `${enabledCount} enabled` + (disabledCount > 0 ? ` · ${disabledCount} disabled` : "");
    headerRow.createEl("h3", { text: heading });
    const refreshBtn = headerRow.createEl("button", { text: this.loading ? "Refreshing…" : "Refresh", cls: "mod-cta" });
    refreshBtn.disabled = this.loading;
    refreshBtn.addEventListener("click", () => void this.refresh(true));

    if (this.listError) {
      contentEl.createDiv({
        cls: "claudian-mcp-empty",
        text: `Could not list servers: ${this.listError}`,
      });
    }

    if (this.collidingNames && this.collidingNames.length > 0) {
      contentEl.createDiv({
        cls: "claudian-mcp-empty",
        text:
          `These server names collide once sanitized for tool ids, so toggling one may also affect the other: `
          + `${this.collidingNames.join(", ")}. Rename one in your Claude Code MCP config (claude mcp) to tell them apart.`,
      });
    }

    if (this.loading && !this.servers) return;

    if (all.length === 0 && !this.listError) {
      contentEl.createDiv({
        cls: "claudian-mcp-empty",
        text: "No MCP servers found. Add one with `claude mcp add` in your terminal, then Refresh.",
      });
      return;
    }

    /* Enabled first, then disabled; alphabetical within each group. */
    const sorted = [...all].sort((a, b) => {
      const da = this.disabled.has(a.name) ? 1 : 0;
      const db = this.disabled.has(b.name) ? 1 : 0;
      if (da !== db) return da - db;
      return a.name.localeCompare(b.name);
    });

    const list = contentEl.createDiv({ cls: "claudian-mcp-server-list" });
    for (const server of sorted) this.renderServerRow(list, server);
  }

  private renderServerRow(parent: HTMLElement, server: ParsedMcpServer) {
    const enabled = !this.disabled.has(server.name);
    const row = parent.createDiv({ cls: "claudian-mcp-server-row" + (enabled ? "" : " is-disabled") });

    const head = row.createDiv({ cls: "claudian-mcp-server-head" });
    const checkbox = head.createEl("input", { attr: { type: "checkbox" }, cls: "claudian-mcp-server-toggle" });
    checkbox.checked = enabled;
    checkbox.addEventListener("change", () => void this.toggle(server.name, checkbox.checked, checkbox));

    /* The checkbox itself is a bare 16x16 native control — far under a 44pt
       target. On a coarse pointer, forward a tap anywhere on the row (name,
       type badge, status, endpoint line) to the checkbox rather than only the
       tiny box, mirroring what ApprovalModal's <label>-wrapped askuser rows
       get for free from the browser. Kept to a manual forward instead of a
       <label> wrap so desktop/plugin behavior — where only the checkbox is
       clickable today — is untouched. */
    if (isTouchHost()) {
      row.addClass("claudian-mcp-server-row-touch");
      row.addEventListener("click", (e) => {
        if (e.target === checkbox) return;
        checkbox.click();
      });
    }

    head.createSpan({ cls: "claudian-mcp-server-name", text: server.name });
    const typeBadge = head.createSpan({ cls: "claudian-mcp-server-type" });
    typeBadge.setText(server.transport === "remote" ? "remote" : server.transport === "stdio" ? "stdio" : "—");
    /* Live connection status from the CLI's health check, as a compact glyph
       + label so the user can tell a configured-but-broken server from a
       healthy one without leaving the modal. */
    head.createSpan({
      cls: `claudian-mcp-server-status is-${server.status}`,
      text: `${this.statusGlyph(server.status)} ${server.statusText || server.status}`,
    });

    const summary = row.createDiv({ cls: "claudian-mcp-server-summary" });
    summary.createSpan({ text: server.endpoint || "(no endpoint reported)" });
  }

  private statusGlyph(status: ParsedMcpServer["status"]): string {
    switch (status) {
      case "connected": return "✓";
      case "pending": return "⏸";
      case "failed": return "✗";
      default: return "•";
    }
  }

  /* Persist the toggle, recompute the plugin's cached deny patterns so the
     next spawn picks it up, and re-sort the rows. On failure, revert the
     checkbox so the UI never shows a state that didn't persist. */
  private async toggle(name: string, enabled: boolean, checkbox: HTMLInputElement) {
    try {
      const changed = await this.store.setServerDisabled(name, !enabled);
      if (changed) {
        if (enabled) this.disabled.delete(name);
        else this.disabled.add(name);
        await this.plugin.refreshMcpDenyPatterns();
        platform.notify(
          `${enabled ? "Enabled" : "Disabled"} "${name}" for this vault. Restart any active chats (/clear) to apply.`,
          6000,
        );
      }
      if (!this.closed) this.render();
    } catch (err) {
      checkbox.checked = !enabled; /* revert to the pre-click state */
      platform.notify(`Failed to toggle MCP server: ${(err as Error).message}`);
    }
  }
}
