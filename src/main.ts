import { FileSystemAdapter, Plugin, WorkspaceLeaf, addIcon } from "obsidian";
import { ClaudeChatView, VIEW_TYPE_CLAUDE_CHAT } from "./view/ClaudeChatView";
import { ClaudeChatSettingTab, DEFAULT_SETTINGS, autodetectUserName, type ClaudeChatSettings } from "./settings";
import { SubprocessManager } from "./claude/SubprocessManager";
import { Persistence } from "./storage/Persistence";
import { CLAUDE_ASTERISK_ICON_SVG } from "./view/Welcome";
import { discoverSkillsAndCommands, type DiscoveryResult } from "./claude/SkillDiscovery";

/* Icon id we register with Obsidian's icon registry. Used by the ribbon
   button, the view's tab/breadcrumb icon, and any setIcon() call that wants
   the Claude asterisk. */
export const CLAUDE_ICON_ID = "claude-asterisk";

export default class ClaudeChatPlugin extends Plugin {
  settings: ClaudeChatSettings = DEFAULT_SETTINGS;
  subprocessManager = new SubprocessManager();
  persistence!: Persistence;
  /* Disk-scanned skill + slash-command catalog. Populated on load so the
     `/`-suggestion popup is non-empty before the first message ever fires
     the CLI's system/init event. Re-runnable via refreshSkillCatalog() so
     freshly added skills can be picked up without a plugin reload. */
  skillCatalog: DiscoveryResult = { skills: [], commands: [] };

  async onload() {
    await this.loadSettings();
    this.persistence = new Persistence(this.app);
    this.refreshSkillCatalog();

    /* Register the Claude asterisk icon BEFORE any UI that references it.
       Obsidian's addIcon takes inner SVG content; the asterisk is pre-scaled
       in CLAUDE_ASTERISK_ICON_SVG to fit the default 0-100 viewBox. */
    addIcon(CLAUDE_ICON_ID, CLAUDE_ASTERISK_ICON_SVG);

    this.registerView(VIEW_TYPE_CLAUDE_CHAT, (leaf: WorkspaceLeaf) => new ClaudeChatView(leaf, this));

    this.addRibbonIcon(CLAUDE_ICON_ID, "Open Claude", () => this.activateView());

    this.addCommand({
      id: "open-claude-chat",
      name: "Open Claude",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "new-claude-tab",
      name: "New Claude tab",
      callback: () => {
        const view = this.getActiveView();
        if (view) view.newTab();
        else this.activateView();
      },
    });

    this.addCommand({
      id: "close-claude-tab",
      name: "Close active Claude tab",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        if (!checking) view.closeActiveTab();
        return true;
      },
    });

    this.addCommand({
      id: "next-claude-tab",
      name: "Next Claude tab",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        if (!checking) view.nextTab();
        return true;
      },
    });

    this.addCommand({
      id: "prev-claude-tab",
      name: "Previous Claude tab",
      checkCallback: (checking) => {
        const view = this.getActiveView();
        if (!view) return false;
        if (!checking) view.prevTab();
        return true;
      },
    });

    this.addSettingTab(new ClaudeChatSettingTab(this.app, this));
  }

  async onunload() {
    await this.persistence?.flush();
    await this.subprocessManager.killAll();
  }

  getVaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    return "";
  }

  refreshSkillCatalog(): void {
    try {
      this.skillCatalog = discoverSkillsAndCommands(this.getVaultPath());
    } catch (err) {
      /* eslint-disable no-console */
      console.warn("[claude-cli-chat] skill discovery failed:", err);
      this.skillCatalog = { skills: [], commands: [] };
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    /* First-install user name autodetect. Empty userName means we've never
       populated it; try the OS account once and save. */
    if (!this.settings.userName) {
      const detected = autodetectUserName();
      if (detected) {
        this.settings.userName = detected;
        await this.saveSettings();
      }
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async activateView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_CHAT);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_CLAUDE_CHAT, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private getActiveView(): ClaudeChatView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDE_CHAT);
    if (leaves.length === 0) return null;
    const view = leaves[0].view;
    return view instanceof ClaudeChatView ? view : null;
  }
}
