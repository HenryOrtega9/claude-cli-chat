import { Modal, Notice, Setting, type App, setIcon } from "obsidian";
import { spawn } from "node:child_process";
import { MCPConfigStore, type MCPServerConfig } from "../mcp/MCPConfig";
import { autodetectClaudePath } from "../settings";

/* Modal for managing MCP servers in <vault>/.claude/mcp.json. Lists configured
   servers, lets you add/edit/remove, and offers a "Check status" button that
   spawns `claude mcp list` to verify the CLI sees them. The actual MCP
   runtime is owned by Claude Code itself — this UI is just a friendlier
   editor than hand-writing JSON.

   Tool introspection / individual-tool test harness deliberately not in V1:
   it would require speaking MCP's JSON-RPC ourselves or driving an
   out-of-band Claude session, which is meaningfully more complex than the
   editing workflow most users actually need. */
export class MCPManagerModal extends Modal {
  private store: MCPConfigStore;
  private claudePath: string;
  /* Tracks the in-flight `claude mcp list` invocation. Single-flighted: if a
     check is running, additional clicks are no-ops (button is also visually
     disabled). Aborted on modal close to avoid orphan child processes that
     write their Notice into the void after the user has moved on. */
  private inflightCheck: AbortController | null = null;
  private checkBtn: HTMLButtonElement | null = null;
  /* Optional close callback. Fires once from onClose. Used by ClaudeChatView
     to refresh the active tab's cost-surface pill in case the user added or
     removed servers while the modal was open. */
  private onClosed: (() => void) | null = null;

  constructor(app: App, claudePath: string, onClosed?: () => void) {
    super(app);
    this.store = new MCPConfigStore(app);
    this.claudePath = claudePath || autodetectClaudePath() || "claude";
    this.onClosed = onClosed ?? null;
  }

  async onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("MCP servers");
    contentEl.empty();
    contentEl.addClass("claudian-mcp-modal");
    await this.render();
  }

  onClose() {
    /* Cancel any in-flight status check so its child process and Notice
       don't outlive the modal. */
    if (this.inflightCheck) {
      this.inflightCheck.abort();
      this.inflightCheck = null;
    }
    this.contentEl.empty();
    if (this.onClosed) {
      try { this.onClosed(); } catch { /* never let a refresh callback take down modal teardown */ }
      this.onClosed = null;
    }
  }

  private async render() {
    this.contentEl.empty();
    const all = await this.store.listAllServers();
    const enabled = all.filter(s => s.enabled);
    const disabled = all.filter(s => !s.enabled);

    const intro = this.contentEl.createDiv({ cls: "claudian-mcp-intro" });
    intro.createEl("p", {
      text: `Edits <vault>/.claude/mcp.json. Claude Code reads this file on each subprocess spawn; restart the active tab (clear chat) after editing to pick up changes.`,
    });

    const headerRow = this.contentEl.createDiv({ cls: "claudian-mcp-header-row" });
    /* Headline shows active count so the user sees how many actually
       ship tool defs per turn, with the disabled count surfaced as a
       muted suffix when present. */
    const heading = `${enabled.length} active`
      + (disabled.length > 0 ? ` · ${disabled.length} disabled` : "");
    headerRow.createEl("h3", { text: heading });
    const checkBtn = headerRow.createEl("button", { text: "Check status", cls: "mod-cta" });
    this.checkBtn = checkBtn;
    /* Carry over the disabled state across re-renders triggered by an
       add/edit/delete landing while a check is mid-flight. */
    if (this.inflightCheck) {
      checkBtn.disabled = true;
      checkBtn.setText("Checking…");
    }
    checkBtn.addEventListener("click", () => this.runStatusCheck());
    const addBtn = headerRow.createEl("button", { text: "Add server" });
    addBtn.addEventListener("click", () => this.editServer(null));

    if (all.length === 0) {
      this.contentEl.createDiv({
        cls: "claudian-mcp-empty",
        text: "No MCP servers configured yet. Click \"Add server\" to register one.",
      });
      return;
    }

    if (enabled.length > 0) {
      const enabledList = this.contentEl.createDiv({ cls: "claudian-mcp-server-list" });
      for (const { name, config } of enabled) {
        this.renderServerRow(enabledList, name, config, true);
      }
    }
    if (disabled.length > 0) {
      this.contentEl.createDiv({
        cls: "claudian-mcp-section-divider",
        text: "Disabled — kept in config but not loaded by the CLI",
      });
      const disabledList = this.contentEl.createDiv({ cls: "claudian-mcp-server-list" });
      for (const { name, config } of disabled) {
        this.renderServerRow(disabledList, name, config, false);
      }
    }
  }

  private renderServerRow(parent: HTMLElement, name: string, config: MCPServerConfig, enabled: boolean) {
    const row = parent.createDiv({ cls: "claudian-mcp-server-row" + (enabled ? "" : " is-disabled") });
    const head = row.createDiv({ cls: "claudian-mcp-server-head" });
    /* Inline checkbox — toggling persists the change to mcp.json
       immediately and re-renders the modal so the row jumps between
       the enabled and disabled sections. Mirror of the popup behavior
       on the cost-surface pill. */
    const checkbox = head.createEl("input", { attr: { type: "checkbox" }, cls: "claudian-mcp-server-toggle" });
    checkbox.checked = enabled;
    checkbox.addEventListener("change", async () => {
      try {
        const changed = await this.store.setEnabled(name, checkbox.checked);
        if (changed) {
          new Notice(
            `${checkbox.checked ? "Enabled" : "Disabled"} MCP server "${name}". Restart any active chats (/clear) for the change to take effect.`,
            6000
          );
        }
      } catch (err) {
        new Notice(`Failed to toggle MCP server: ${(err as Error).message}`);
      }
      await this.render();
    });
    head.createSpan({ cls: "claudian-mcp-server-name", text: name });
    const typeBadge = head.createSpan({ cls: "claudian-mcp-server-type" });
    typeBadge.setText(this.describeServerType(config));

    const summary = row.createDiv({ cls: "claudian-mcp-server-summary" });
    if (config.command) {
      summary.createSpan({ text: `${config.command}${config.args && config.args.length ? " " + config.args.join(" ") : ""}` });
    } else if (config.url) {
      summary.createSpan({ text: config.url });
    } else {
      summary.createSpan({ text: "(no command or URL configured)" });
    }

    const actions = row.createDiv({ cls: "claudian-mcp-server-actions" });
    const editBtn = actions.createEl("button", { text: "Edit" });
    editBtn.addEventListener("click", () => this.editServer({ name, config }));
    const deleteBtn = actions.createEl("button", { cls: "mod-warning", text: "Delete" });
    deleteBtn.addEventListener("click", async () => {
      if (!confirm(`Remove MCP server "${name}"?`)) return;
      await this.store.removeServer(name);
      await this.render();
      new Notice(`Removed MCP server: ${name}`);
    });
  }

  private describeServerType(config: MCPServerConfig): string {
    if (config.type) return config.type;
    if (config.url) return "remote";
    if (config.command) return "stdio";
    return "—";
  }

  private editServer(existing: { name: string; config: MCPServerConfig } | null) {
    new MCPServerEditModal(this.app, existing, async (name, config) => {
      /* TODO(bugfix-sweep): rename is currently two writes (removeServer + upsertServer);
         if the second write fails the config is left missing the server entirely.
         The fix lives in MCPConfigStore (Agent A's scope): add a
         renameServer(oldName, newName, config) helper that mutates the JSON
         in memory and persists once. Until then, we accept the race here. */
      if (existing && existing.name !== name) {
        await this.store.removeServer(existing.name);
      }
      await this.store.upsertServer(name, config);
      await this.render();
      new Notice(`Saved MCP server: ${name}`);
    }).open();
  }

  /* Spawns `claude mcp list` to verify the CLI can see the servers and what
     state they're in. Output is shown in a Notice — for V1 this gives the
     user signal without needing a full status pane in the modal.
     Single-flighted via this.inflightCheck so rapid clicks don't fan out into
     N parallel child processes; a 30s timeout aborts hung invocations so
     we don't leave zombie children behind. */
  private runStatusCheck() {
    if (this.inflightCheck) return;
    const controller = new AbortController();
    this.inflightCheck = controller;
    if (this.checkBtn) {
      this.checkBtn.disabled = true;
      this.checkBtn.setText("Checking…");
    }

    const child = spawn(this.claudePath, ["mcp", "list"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH ?? ""}` },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (this.inflightCheck === controller) this.inflightCheck = null;
      if (this.checkBtn) {
        this.checkBtn.disabled = false;
        this.checkBtn.setText("Check status");
      }
    };

    const timer = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }, 30_000);

    controller.signal.addEventListener("abort", () => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    });

    child.stdout.on("data", chunk => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
    child.on("exit", code => {
      cleanup();
      if (controller.signal.aborted && !timedOut) return;  /* user closed modal */
      const message = timedOut
        ? "claude mcp list timed out after 30s (process killed)."
        : code === 0
          ? `claude mcp list:\n\n${stdout.trim() || "(no output)"}`
          : `claude mcp list failed (exit ${code}):\n${stderr.trim() || stdout.trim() || "(no output)"}`;
      new Notice(message, 12000);
    });
    child.on("error", err => {
      cleanup();
      if (controller.signal.aborted && !timedOut) return;
      new Notice(`Failed to spawn claude: ${err.message}`, 8000);
    });
  }
}

/* Editor sub-modal for one server. Form-based so the user doesn't hand-edit
   JSON. */
class MCPServerEditModal extends Modal {
  private name: string;
  private config: MCPServerConfig;
  private onSave: (name: string, config: MCPServerConfig) => void;
  private existingName: string | null;

  constructor(
    app: App,
    existing: { name: string; config: MCPServerConfig } | null,
    onSave: (name: string, config: MCPServerConfig) => void
  ) {
    super(app);
    this.existingName = existing?.name ?? null;
    this.name = existing?.name ?? "";
    /* Deep-clone the existing config so cancel-without-save reverts cleanly. */
    this.config = existing ? JSON.parse(JSON.stringify(existing.config)) : { type: "stdio", command: "", args: [], env: {} };
    this.onSave = onSave;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText(this.existingName ? `Edit MCP server: ${this.existingName}` : "Add MCP server");
    contentEl.empty();
    contentEl.addClass("claudian-mcp-edit-modal");

    new Setting(contentEl)
      .setName("Name")
      .setDesc("Unique identifier the CLI uses to reference this server.")
      .addText(t => t.setValue(this.name).onChange(v => { this.name = v.trim(); }));

    new Setting(contentEl)
      .setName("Type")
      .addDropdown(dd => {
        dd.addOption("stdio", "stdio (local command)");
        dd.addOption("sse", "sse (remote, server-sent events)");
        dd.addOption("http", "http (remote)");
        dd.setValue(this.config.type ?? "stdio");
        dd.onChange(v => { this.config.type = v as MCPServerConfig["type"]; this.refresh(); });
      });

    this.refresh();
  }

  /* Re-render the bottom half when the server type changes — stdio shows
     command/args/env; remote shows url/headers. */
  private refresh() {
    const oldBody = this.contentEl.querySelector(".claudian-mcp-edit-body");
    if (oldBody) oldBody.remove();
    const body = this.contentEl.createDiv({ cls: "claudian-mcp-edit-body" });
    const type = this.config.type ?? "stdio";
    if (type === "stdio") this.renderStdioFields(body);
    else this.renderRemoteFields(body);
    this.renderFooter(body);
  }

  private renderStdioFields(body: HTMLElement) {
    new Setting(body)
      .setName("Command")
      .setDesc("Executable to spawn. Use the absolute path if not on PATH.")
      .addText(t => t.setValue(this.config.command ?? "").onChange(v => { this.config.command = v.trim(); }));

    new Setting(body)
      .setName("Arguments")
      .setDesc("Space-separated. Use quotes for args containing spaces.")
      .addText(t => t.setValue((this.config.args ?? []).join(" ")).onChange(v => {
        this.config.args = this.parseArgs(v);
      }));

    new Setting(body)
      .setName("Environment variables")
      .setDesc("One KEY=value per line.")
      .addTextArea(t => {
        const lines = Object.entries(this.config.env ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
        t.setValue(lines).onChange(v => {
          this.config.env = this.parseEnv(v);
        });
        t.inputEl.rows = 4;
        t.inputEl.style.width = "100%";
      });
  }

  private renderRemoteFields(body: HTMLElement) {
    new Setting(body)
      .setName("URL")
      .addText(t => t.setValue(this.config.url ?? "").onChange(v => { this.config.url = v.trim(); }));

    new Setting(body)
      .setName("Headers")
      .setDesc("One Header-Name: value per line.")
      .addTextArea(t => {
        const lines = Object.entries(this.config.headers ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n");
        t.setValue(lines).onChange(v => {
          this.config.headers = this.parseHeaders(v);
        });
        t.inputEl.rows = 4;
        t.inputEl.style.width = "100%";
      });
  }

  private renderFooter(body: HTMLElement) {
    const footer = body.createDiv({ cls: "claudian-mcp-edit-footer" });
    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const save = footer.createEl("button", { cls: "mod-cta", text: "Save" });
    save.addEventListener("click", () => {
      if (!this.name) { new Notice("Name is required."); return; }
      const type = this.config.type ?? "stdio";
      if (type === "stdio" && !this.config.command) { new Notice("Command is required for stdio servers."); return; }
      if (type !== "stdio" && !this.config.url) { new Notice("URL is required for remote servers."); return; }
      /* Strip the irrelevant half of the config so we don't persist stale
         remote fields on a stdio server or vice versa. */
      const sanitized: MCPServerConfig = { type };
      if (type === "stdio") {
        sanitized.command = this.config.command;
        if (this.config.args && this.config.args.length) sanitized.args = this.config.args;
        if (this.config.env && Object.keys(this.config.env).length) sanitized.env = this.config.env;
      } else {
        sanitized.url = this.config.url;
        if (this.config.headers && Object.keys(this.config.headers).length) sanitized.headers = this.config.headers;
      }
      this.onSave(this.name, sanitized);
      this.close();
    });
  }

  /* Parse a single-line shell-ish arg string, e.g.
       arg1 arg2 'arg with space' "quoted" --regex='it\'s'
     Hand-rolled char-by-char state machine so escaped quotes inside a quoted
     section don't terminate the section early — the previous regex broke on
     `--regex='it\'s'` and similar. Supports `\` as a generic escape both
     inside and outside quoted runs; unquoted whitespace separates args. */
  private parseArgs(text: string): string[] {
    const out: string[] = [];
    let current = "";
    let inSingle = false;
    let inDouble = false;
    let escaped = false;
    let started = false;  /* true once `current` has been opened by any char */

    const flush = () => {
      if (started) {
        out.push(current);
        current = "";
        started = false;
      }
    };

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        current += ch;
        started = true;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (inSingle) {
        if (ch === "'") { inSingle = false; continue; }
        current += ch;
        started = true;
        continue;
      }
      if (inDouble) {
        if (ch === "\"") { inDouble = false; continue; }
        current += ch;
        started = true;
        continue;
      }
      if (ch === "'") { inSingle = true; started = true; continue; }
      if (ch === "\"") { inDouble = true; started = true; continue; }
      if (/\s/.test(ch)) { flush(); continue; }
      current += ch;
      started = true;
    }
    flush();
    return out;
  }

  private parseEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim();
      if (k) out[k] = v;
    }
    return out;
  }

  private parseHeaders(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(":");
      if (idx === -1) continue;
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim();
      if (k) out[k] = v;
    }
    return out;
  }
}
