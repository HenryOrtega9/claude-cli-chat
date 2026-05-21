import { SuggestModal, type App } from "obsidian";
import type { SubagentEntry } from "../claude/SubagentDiscovery";

/* Picker for subagent definitions. Mirrors SnippetPicker — Obsidian's
   SuggestModal gives fuzzy search, keyboard nav, and a metadata subtitle
   for free. Triggered by `/agent` alone (no name) or by the toolbar pill
   in InputBox. The caller passes the discovered catalog and a callback
   that receives the chosen entry. */
export class SubagentPicker extends SuggestModal<SubagentEntry> {
  private agents: SubagentEntry[];
  private onChoose: (entry: SubagentEntry) => void;

  constructor(app: App, agents: SubagentEntry[], onChoose: (entry: SubagentEntry) => void) {
    super(app);
    this.agents = agents;
    this.onChoose = onChoose;
    this.setPlaceholder("Launch subagent…");
  }

  getSuggestions(query: string): SubagentEntry[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.agents;
    return this.agents.filter(a => {
      if (a.name.toLowerCase().includes(q)) return true;
      if (a.description && a.description.toLowerCase().includes(q)) return true;
      return false;
    });
  }

  renderSuggestion(entry: SubagentEntry, el: HTMLElement): void {
    el.createDiv({ cls: "claudian-subagent-pick-primary", text: entry.name });
    const secondaryBits: string[] = [entry.source];
    if (entry.model) secondaryBits.push(`model: ${entry.model}`);
    if (entry.tools && entry.tools.length > 0) {
      secondaryBits.push(`tools: ${entry.tools.length}`);
    }
    el.createDiv({ cls: "claudian-subagent-pick-secondary", text: secondaryBits.join("  ·  ") });
    if (entry.description) {
      const trimmed = entry.description.length > 120
        ? entry.description.slice(0, 120) + "…"
        : entry.description;
      el.createDiv({ cls: "claudian-subagent-pick-description", text: trimmed });
    }
  }

  onChooseSuggestion(entry: SubagentEntry): void {
    this.onChoose(entry);
  }
}
