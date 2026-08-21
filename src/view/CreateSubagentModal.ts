import { platform, PlatformModal, type AppHandle } from "../platform";
import type { PluginHost } from "../platform/host";

/* Captures the fields needed to write a subagent definition (.md with YAML
   frontmatter) to disk in either the user-global agents dir or the project
   agents dir. After save we re-scan the catalog so the toolbar pill and the
   /agent picker pick up the new entry without a plugin reload.

   Frontmatter shape matches what SubagentDiscovery parses:
     ---
     description: <one-liner — when should Claude invoke this agent?>
     ---
     <system prompt body>
   `tools:` and `model:` are intentionally omitted from this v1 form; users
   who need them can edit the file directly after creation. */

type SaveLocation = "project" | "user";

const FILENAME_SAFE = /^[a-z0-9][a-z0-9_-]*$/i;

export class CreateSubagentModal extends PlatformModal {
  private plugin: PluginHost;
  /* Called after a successful save so the caller (TabController) can refresh
     the toolbar pill count without reaching into plugin internals from here. */
  private onCreated: () => void;
  private nameInput!: HTMLInputElement;
  private descInput!: HTMLInputElement;
  private bodyInput!: HTMLTextAreaElement;
  private locationSelect!: HTMLSelectElement;
  private saveBtn!: HTMLButtonElement;

  constructor(app: AppHandle, plugin: PluginHost, onCreated: () => void) {
    super(app);
    this.plugin = plugin;
    this.onCreated = onCreated;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Create a subagent");
    contentEl.empty();
    contentEl.addClass("claudian-create-subagent-modal");

    const intro = contentEl.createDiv({ cls: "claudian-create-subagent-intro" });
    intro.createEl("p", {
      text:
        "Subagents are short markdown files that describe a focused helper Claude can invoke via the Task tool. " +
        "Give it a name, a description telling Claude when to use it, and a system prompt that defines its behavior.",
    });
    intro.createEl("p", {
      cls: "claudian-create-subagent-intro-secondary",
      text:
        "Project agents live in <vault>/.claude/agents/ (committed alongside your notes); " +
        "user agents live in ~/.claude/agents/ and are available across every vault on this machine.",
    });

    /* Name field — becomes the filename. Keep it ASCII + dashes/underscores
       so cross-OS sync (the user's vault is on iCloud) doesn't trip on case
       collisions or reserved characters. */
    const nameField = this.field("Name", "Lowercase, no spaces. Becomes the filename and how Claude refers to the agent.");
    this.nameInput = nameField.createEl("input", { attr: { type: "text", placeholder: "e.g. summarizer" } });
    this.nameInput.addEventListener("input", () => this.updateSaveEnabled());

    /* Description — what shows up in the /agent picker and what Claude sees
       when deciding whether to invoke this agent. Front-load the trigger. */
    const descField = this.field("Description", "When should Claude invoke this agent? One sentence. This is what the model reads when picking.");
    this.descInput = descField.createEl("input", {
      attr: { type: "text", placeholder: "e.g. Use when the user asks to summarize a vault note" },
    });
    this.descInput.addEventListener("input", () => this.updateSaveEnabled());

    /* System prompt body — the agent's actual instructions. Larger textarea
       since real prompts run 5–20 lines. Resize: vertical so the user can
       expand if they're writing a long one. */
    const bodyField = this.field("System prompt", "The instructions Claude follows while acting as this agent. Plain markdown.");
    this.bodyInput = bodyField.createEl("textarea", {
      attr: { rows: "10", placeholder: "You are a concise summarizer. When asked to summarize a file, ..." },
    });
    this.bodyInput.addEventListener("input", () => this.updateSaveEnabled());

    /* Save location — defaults to project so a brand-new user lands a
       discoverable file inside their vault. User location is one click away
       for cross-vault agents. */
    const locField = this.field("Save location", "Project keeps the agent with this vault. User makes it available everywhere.");
    this.locationSelect = locField.createEl("select", { cls: "dropdown" });
    const projectOpt = this.locationSelect.createEl("option", { value: "project", text: "Project (<vault>/.claude/agents/)" });
    this.locationSelect.createEl("option", { value: "user", text: "User (~/.claude/agents/)" });
    projectOpt.selected = true;

    /* Footer with Cancel + Save. Save button stays disabled until the three
       required fields are non-empty and the name passes filename validation,
       so the user can't accidentally write an unusable file. */
    const footer = contentEl.createDiv({ cls: "claudian-create-subagent-footer" });
    const cancelBtn = footer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
    this.saveBtn = footer.createEl("button", { text: "Create agent", cls: "mod-cta" });
    this.saveBtn.disabled = true;
    this.saveBtn.addEventListener("click", () => this.handleSave());

    /* Submit via Cmd/Ctrl+Enter from anywhere in the form — power-user
       affordance, matches Obsidian's modal conventions. */
    contentEl.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!this.saveBtn.disabled) this.handleSave();
      }
    });

    this.nameInput.focus();
  }

  onClose() {
    this.contentEl.empty();
  }

  /* Builds a labeled field block. Returns the wrapper element so the caller
     can append the actual input/textarea/select to it. */
  private field(label: string, hint: string): HTMLElement {
    const wrap = this.contentEl.createDiv({ cls: "claudian-create-subagent-field" });
    wrap.createEl("label", { cls: "claudian-create-subagent-label", text: label });
    wrap.createEl("div", { cls: "claudian-create-subagent-hint", text: hint });
    return wrap;
  }

  private updateSaveEnabled(): void {
    const name = this.nameInput.value.trim();
    const desc = this.descInput.value.trim();
    const body = this.bodyInput.value.trim();
    const validName = FILENAME_SAFE.test(name);
    this.saveBtn.disabled = !(validName && desc.length > 0 && body.length > 0);
  }

  private handleSave(): void {
    const name = this.nameInput.value.trim();
    const desc = this.descInput.value.trim();
    const body = this.bodyInput.value.trim();
    if (!FILENAME_SAFE.test(name)) {
      platform.notify("Name must start with a letter or number; use letters, digits, _ or -.");
      return;
    }
    const scope = this.locationSelect.value as SaveLocation;
    /* YAML frontmatter quote-escape: descriptions often contain colons
       (e.g. "Use when: …") which would break a bare YAML scalar. Wrap in
       double quotes and escape embedded double quotes + backslashes. */
    const safeDesc = `"${desc.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const fileContents =
      `---\n` +
      `description: ${safeDesc}\n` +
      `---\n` +
      `${body}\n`;

    /* The write itself is the host's job — this modal renders in the browser
       client too, where there is no local agents dir. */
    const write = this.plugin.createSubagentFile;
    if (!write) {
      platform.notify("Creating subagents isn't available in this app.");
      return;
    }
    const result = write.call(this.plugin, { scope, name, contents: fileContents });
    if (!result.ok) {
      if (result.kind === "no_vault") {
        platform.notify("Couldn't resolve the vault path for project-scoped save. Pick User instead.");
      } else if (result.kind === "exists") {
        /* Refuse to clobber. If the user really wants to overwrite they can
           delete or rename the existing file first. */
        platform.notify(`A ${scope} subagent named "${name}" already exists. Pick a different name.`);
      } else {
        platform.notify(`Couldn't create subagent: ${result.message}`);
      }
      return;
    }

    /* Rescan so the new agent shows up everywhere it should: the toolbar
       pill (via onCreated callback), the /agent picker, and the SubagentManager
       modal next time it opens. Cheap and synchronous — same call the
       Refresh button in the manager modal uses. */
    this.plugin.refreshSubagentCatalog();
    this.onCreated();
    platform.notify(`Created ${scope} subagent "${name}".`);
    this.close();
  }
}
