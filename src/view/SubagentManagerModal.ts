import { platform, PlatformModal, type AppHandle } from "../platform";
import type { PluginHost } from "../platform/host";
import type { SubagentEntry } from "../claude/SubagentDiscovery";

/* Read-only manager for subagent definitions discovered on disk. Mirrors
   MCPManagerModal's surface area (intro paragraph, header row with refresh
   button, grouped list of rows) but skips the inline editor since YAML
   frontmatter is a footgun and the user is better served by opening the
   file directly. */
export class SubagentManagerModal extends PlatformModal {
  private plugin: PluginHost;

  constructor(app: AppHandle, plugin: PluginHost) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Subagents");
    contentEl.empty();
    contentEl.addClass("claudian-subagent-modal");
    /* Re-scan on open so edits made outside the modal land without a plugin
       reload. The refresh helper handles its own errors. */
    this.plugin.refreshSubagentCatalog();
    this.render();
  }

  onClose() {
    this.contentEl.empty();
  }

  private render() {
    this.contentEl.empty();
    const agents = this.plugin.subagentCatalog.agents;

    const intro = this.contentEl.createDiv({ cls: "claudian-subagent-intro" });
    intro.createEl("p", {
      text:
        "Subagents are markdown files with YAML frontmatter that Claude can invoke via the Task tool. " +
        "This plugin scans <vault>/.claude/agents, ~/.claude/agents, and installed-plugin agents/ dirs. " +
        "V1 is read-only — click Open to edit the file in its default app.",
    });

    const headerRow = this.contentEl.createDiv({ cls: "claudian-subagent-header-row" });
    headerRow.createEl("h3", { text: `${agents.length} discovered` });
    const refreshBtn = headerRow.createEl("button", { text: "Refresh", cls: "mod-cta" });
    refreshBtn.addEventListener("click", () => {
      this.plugin.refreshSubagentCatalog();
      this.render();
      platform.notify(`Rescanned subagents: ${this.plugin.subagentCatalog.agents.length} discovered.`);
    });

    if (agents.length === 0) {
      this.contentEl.createDiv({
        cls: "claudian-subagent-empty",
        text:
          "No subagents discovered. Add a markdown file under <vault>/.claude/agents/ or ~/.claude/agents/ " +
          "with `description:` in its YAML frontmatter and a system prompt body.",
      });
      return;
    }

    /* Group by source so the user sees provenance at a glance. */
    const groups: Array<{ label: string; entries: SubagentEntry[] }> = [
      { label: "Project", entries: agents.filter(a => a.source === "project") },
      { label: "User", entries: agents.filter(a => a.source === "user") },
      { label: "Plugin", entries: agents.filter(a => a.source === "plugin") },
    ];

    for (const group of groups) {
      if (group.entries.length === 0) continue;
      this.contentEl.createDiv({
        cls: "claudian-subagent-section-divider",
        text: `${group.label} (${group.entries.length})`,
      });
      const list = this.contentEl.createDiv({ cls: "claudian-subagent-list" });
      for (const entry of group.entries) {
        this.renderAgentRow(list, entry);
      }
    }
  }

  private renderAgentRow(parent: HTMLElement, entry: SubagentEntry) {
    const row = parent.createDiv({ cls: "claudian-subagent-row" });

    const head = row.createDiv({ cls: "claudian-subagent-row-head" });
    head.createSpan({ cls: "claudian-subagent-name", text: entry.name });
    if (entry.pluginName) {
      head.createSpan({ cls: "claudian-subagent-plugin-tag", text: `· ${entry.pluginName}` });
    }
    if (entry.model) {
      head.createSpan({ cls: "claudian-subagent-model-tag", text: `model: ${entry.model}` });
    }

    if (entry.description) {
      row.createDiv({ cls: "claudian-subagent-description", text: entry.description });
    }

    if (entry.tools && entry.tools.length > 0) {
      const toolsRow = row.createDiv({ cls: "claudian-subagent-tools" });
      toolsRow.createSpan({ cls: "claudian-subagent-tools-label", text: "tools: " });
      toolsRow.createSpan({ text: entry.tools.join(", ") });
    }

    const meta = row.createDiv({ cls: "claudian-subagent-meta" });
    meta.createSpan({ text: entry.filePath });

    const actions = row.createDiv({ cls: "claudian-subagent-row-actions" });
    const openBtn = actions.createEl("button", { text: "Open" });
    openBtn.addEventListener("click", () => this.openFile(entry.filePath));
    const revealBtn = actions.createEl("button", { text: "Reveal in Finder" });
    revealBtn.addEventListener("click", () => this.revealInFinder(entry.filePath));
  }

  /* macOS `open <path>` defers to the file's default app — usually a
     markdown editor. Plugin is macOS-only so the bare `open` is safe. */
  private openFile(filePath: string) {
    try {
      this.plugin.openPathExternally?.(filePath, "open");
    } catch (err) {
      platform.notify(`Failed to open file: ${(err as Error).message}`);
    }
  }

  private revealInFinder(filePath: string) {
    try {
      this.plugin.openPathExternally?.(filePath, "reveal");
    } catch (err) {
      platform.notify(`Failed to reveal file: ${(err as Error).message}`);
    }
  }
}
