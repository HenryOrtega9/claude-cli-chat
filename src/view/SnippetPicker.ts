import { SuggestModal, type App } from "obsidian";
import { MODEL_LABELS, EFFORT_LABELS, PERMISSION_MODE_LABELS, type EnvSnippet } from "../settings";

/* Picker for environment snippets. Uses Obsidian's SuggestModal so the user
   gets fuzzy search + keyboard nav for free. The picker also includes a
   sentinel "(none)" entry that clears any applied snippet on the active tab. */
export class SnippetPicker extends SuggestModal<EnvSnippet | "__clear__"> {
  private snippets: EnvSnippet[];
  private currentSnippetId: string | undefined;
  private onChoose: (choice: EnvSnippet | "__clear__") => void;

  constructor(
    app: App,
    snippets: EnvSnippet[],
    currentSnippetId: string | undefined,
    onChoose: (choice: EnvSnippet | "__clear__") => void
  ) {
    super(app);
    this.snippets = snippets;
    this.currentSnippetId = currentSnippetId;
    this.onChoose = onChoose;
    this.setPlaceholder("Apply environment snippet…");
  }

  getSuggestions(query: string): Array<EnvSnippet | "__clear__"> {
    const q = query.toLowerCase();
    const matches = this.snippets.filter(s => !q || s.name.toLowerCase().includes(q));
    /* Append clear sentinel when a snippet is currently applied so the user
       can revert to default settings without leaving the picker. */
    if (this.currentSnippetId) return [...matches, "__clear__"];
    return matches;
  }

  renderSuggestion(item: EnvSnippet | "__clear__", el: HTMLElement) {
    if (item === "__clear__") {
      el.createDiv({ cls: "claudian-snippet-pick-primary", text: "Clear applied snippet" });
      el.createDiv({ cls: "claudian-snippet-pick-secondary", text: "Restore tab to plugin defaults" });
      return;
    }
    const primary = el.createDiv({ cls: "claudian-snippet-pick-primary", text: item.name });
    if (item.id === this.currentSnippetId) {
      primary.createSpan({ cls: "claudian-snippet-pick-applied-tag", text: " · applied" });
    }
    const summary = [
      MODEL_LABELS[item.model],
      `effort: ${EFFORT_LABELS[item.effort]}`,
      `mode: ${PERMISSION_MODE_LABELS[item.permissionMode]}`,
    ].join("  ·  ");
    el.createDiv({ cls: "claudian-snippet-pick-secondary", text: summary });
    if (item.systemPromptAddendum.trim()) {
      const preview = item.systemPromptAddendum.length > 80
        ? item.systemPromptAddendum.slice(0, 80) + "…"
        : item.systemPromptAddendum;
      el.createDiv({ cls: "claudian-snippet-pick-prompt", text: `"${preview}"` });
    }
  }

  onChooseSuggestion(item: EnvSnippet | "__clear__") {
    this.onChoose(item);
  }
}
