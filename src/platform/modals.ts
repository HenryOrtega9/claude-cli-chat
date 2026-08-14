/* Obsidian-free modal base classes.

   The shared modals (HistoryModal, MCPManagerModal, SubagentManagerModal,
   CreateSubagentModal, SubagentPicker) currently `extend Modal` /
   `extend SuggestModal` from obsidian. These bases preserve that exact
   authoring shape — subclasses keep `super(app)`, keep overriding
   onOpen/onClose (or the suggest cycle), keep reaching for this.contentEl /
   this.titleEl — while the actual modal machinery is supplied by the
   platform via composition (platform.createModal / createSuggestModal).
   Under Obsidian the host IS a real obsidian.Modal/SuggestModal, so runtime
   behavior (backdrop, Esc-to-close, focus trap, fuzzy list chrome) is
   byte-identical to today.

   The `app` constructor parameter is retained purely so existing call sites
   (`new HistoryModal(this.app, ...)`) compile unchanged; it is ignored —
   the host binds to the platform's own app context. */

import { platform } from "./registry";
import type { AppHandle, ModalHost, SuggestModalHost } from "./types";

export abstract class PlatformModal {
  private host: ModalHost;

  constructor(_app?: AppHandle) {
    /* Delegate methods are only invoked on open/close, well after the
       subclass constructor finishes, so `this` is fully initialized by the
       time they fire. */
    this.host = platform.createModal({
      onOpen: () => this.onOpen(),
      onClose: () => this.onClose(),
    });
  }

  get contentEl(): HTMLElement { return this.host.contentEl; }
  get titleEl(): HTMLElement { return this.host.titleEl; }

  open(): void { this.host.open(); }
  close(): void { this.host.close(); }

  /* Overridable lifecycle hooks, matching obsidian.Modal's contract. onOpen
     may be async (fired fire-and-forget, exactly like Obsidian does). */
  onOpen(): void | Promise<void> { /* subclass hook */ }
  onClose(): void { /* subclass hook */ }
}

export abstract class PlatformSuggestModal<T> {
  private host: SuggestModalHost;

  constructor(_app?: AppHandle) {
    this.host = platform.createSuggestModal<T>({
      getSuggestions: query => this.getSuggestions(query),
      renderSuggestion: (item, el) => this.renderSuggestion(item, el),
      onChooseSuggestion: (item, evt) => this.onChooseSuggestion(item, evt),
    });
  }

  /* Subclass constructors call this after super() (host exists by then),
     matching SuggestModal.setPlaceholder. */
  setPlaceholder(text: string): void { this.host.setPlaceholder(text); }

  open(): void { this.host.open(); }
  close(): void { this.host.close(); }

  abstract getSuggestions(query: string): T[] | Promise<T[]>;
  abstract renderSuggestion(item: T, el: HTMLElement): void;
  abstract onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;
}
