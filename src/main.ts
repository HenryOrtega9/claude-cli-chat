import { FileSystemAdapter, Plugin, WorkspaceLeaf, addIcon } from "obsidian";
import { ClaudeChatView, VIEW_TYPE_CLAUDE_CHAT } from "./view/ClaudeChatView";
import { ClaudeChatSettingTab, DEFAULT_SETTINGS, autodetectUserName, type ClaudeChatSettings } from "./settings";
import { SubprocessManager, spawnOptionsFromSettings } from "./claude/SubprocessManager";
import type { AssistantEvent, ResultEvent, StreamEvent } from "./claude/Events";
import { Persistence } from "./storage/Persistence";
import { CLAUDE_ASTERISK_ICON_SVG } from "./view/Welcome";
import { discoverSkillsAndCommands, type DiscoveryResult } from "./claude/SkillDiscovery";
import { StateEmitter } from "./claude/StateEmitter";

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

    /* TC001 status display: configure from persisted settings and emit
       idle once at load. No network calls happen unless the user has
       toggled the integration on. */
    StateEmitter.configure(this.settings.tc001Enabled, this.settings.tc001Ip);
    if (this.settings.tc001Enabled) StateEmitter.setState("idle");
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
       populated it; try the OS account once and save. Validate the result
       — if dscl misbehaves and leaks an error string into stdout, the
       truthy check would otherwise save the garbage forever. Whitelist:
       starts with a letter, allows letters / spaces / common punctuation,
       caps at 50 chars, must contain a letter. Falls through to USER env. */
    if (!this.settings.userName) {
      const detected = autodetectUserName();
      const looksLikeName = /^[A-Za-z][A-Za-z .'-]{0,49}$/.test(detected) && /[A-Za-z]/.test(detected);
      if (detected && looksLikeName) {
        this.settings.userName = detected;
        await this.saveSettings();
      } else {
        /* Fall through to capitalized $USER as a safer secondary source. */
        const u = process.env.USER ?? "";
        const fallback = u ? u.charAt(0).toUpperCase() + u.slice(1) : "";
        if (fallback && /^[A-Za-z][A-Za-z .'-]{0,49}$/.test(fallback)) {
          this.settings.userName = fallback;
          await this.saveSettings();
        }
      }
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /* Programmatic one-shot prompt for other plugins (e.g. obsidian-docx-claude).
     Spawns a transient TabSession with systemPrompt appended via
     --append-system-prompt, sends userPrompt once, accumulates assistant text
     from `assistant` events, resolves on the `result` event, and disposes the
     session in finally. */
  async runHeadlessPrompt(
    systemPrompt: string,
    userPrompt: string,
    opts?: { timeoutMs?: number; cwd?: string },
  ): Promise<string> {
    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const tabId = `headless-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cwd = opts?.cwd ?? this.getVaultPath() ?? process.cwd();
    const spawnOpts = spawnOptionsFromSettings(this.settings, cwd, undefined, {
      appendSystemPrompt: systemPrompt,
    });
    const session = this.subprocessManager.spawn(tabId, spawnOpts);

    let resolved = false;
    let assistantText = "";

    return new Promise<string>((resolve, reject) => {
      const finish = (value: string | null, err?: Error) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        session.dispose().finally(() => {
          if (err) reject(err);
          else resolve(value ?? "");
        });
      };

      const timer = setTimeout(() => {
        finish(null, new Error(`runHeadlessPrompt timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      session.onEvent((e: StreamEvent) => {
        if (e.type === "assistant") {
          const ae = e as AssistantEvent;
          for (const block of ae.message.content) {
            if (block.type === "text") assistantText += block.text;
          }
        } else if (e.type === "result") {
          const re = e as ResultEvent;
          if (re.is_error) {
            finish(null, new Error(`Claude returned error: ${re.subtype}`));
            return;
          }
          if (typeof re.result === "string" && re.result.length > 0) {
            finish(re.result);
          } else if (re.result && typeof re.result === "object") {
            const textBlocks = re.result.content
              .filter((b): b is { type: "text"; text: string } => b.type === "text")
              .map((b) => b.text)
              .join("");
            finish(textBlocks || assistantText);
          } else {
            finish(assistantText);
          }
        }
      });
      session.onError((err) => finish(null, err));
      session.onExit((code) => {
        if (!resolved) finish(null, new Error(`Claude subprocess exited (code=${code}) before result`));
      });

      try {
        session.sendUserText(userPrompt);
      } catch (err) {
        finish(null, err instanceof Error ? err : new Error(String(err)));
      }
    });
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
