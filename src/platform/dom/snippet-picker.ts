/* Environment-snippet picker for the standalone shell.

   src/view/SnippetPicker.ts extends obsidian's SuggestModal directly and is
   classified Obsidian-only (MIGRATION.md), so the shell cannot reuse it. This
   is the same picker rewritten on PlatformSuggestModal — identical suggestion
   set, identical markup and class names, identical "(none)" clear sentinel —
   so the styles in styles.css apply unchanged. Keep the two in sync. */

import { PlatformSuggestModal } from "../index";
import {
  EFFORT_LABELS,
  MODEL_LABELS,
  PERMISSION_MODE_LABELS,
  type EnvSnippet,
} from "../../settings-data";

export type SnippetChoice = EnvSnippet | "__clear__";

export class DesktopSnippetPicker extends PlatformSuggestModal<SnippetChoice> {
  private snippets: EnvSnippet[];
  private currentSnippetId: string | undefined;
  private onChoose: (choice: SnippetChoice) => void;

  constructor(
    snippets: EnvSnippet[],
    currentSnippetId: string | undefined,
    onChoose: (choice: SnippetChoice) => void,
  ) {
    super(null);
    this.snippets = snippets;
    this.currentSnippetId = currentSnippetId;
    this.onChoose = onChoose;
    this.setPlaceholder("Apply environment snippet…");
  }

  getSuggestions(query: string): SnippetChoice[] {
    const q = query.toLowerCase();
    const matches = this.snippets.filter(s => !q || s.name.toLowerCase().includes(q));
    /* Append the clear sentinel when a snippet is applied so the user can
       revert to defaults without leaving the picker. */
    if (this.currentSnippetId) return [...matches, "__clear__"];
    return matches;
  }

  renderSuggestion(item: SnippetChoice, el: HTMLElement): void {
    if (item === "__clear__") {
      el.createDiv({ cls: "claudian-snippet-pick-primary", text: "Clear applied snippet" });
      el.createDiv({ cls: "claudian-snippet-pick-secondary", text: "Restore tab to app defaults" });
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
        ? `${item.systemPromptAddendum.slice(0, 80)}…`
        : item.systemPromptAddendum;
      el.createDiv({ cls: "claudian-snippet-pick-prompt", text: `"${preview}"` });
    }
  }

  onChooseSuggestion(item: SnippetChoice): void {
    this.onChoose(item);
  }
}
