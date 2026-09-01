/* Platform implementation for the standalone Electron shell.

   The counterpart to src/platform/obsidian.ts: same interface, no Obsidian
   anywhere. Each capability is backed by the thinnest thing that reproduces
   the observable behavior shared code was written against — node fs for
   storage, lucide for icons, marked for markdown, node http for HTTP, plain
   DOM for toast / menu / modals.

   vaultFeatures is deliberately absent. There is no vault here, and every
   shared consumer already reaches it through `platform.vaultFeatures?.` with
   a neutral fallback, so the mention index, wikilink resolution, hover
   preview and file drags simply feature-flag off. */

import type {
  FileStorage,
  HttpRequestOptions,
  HttpResponse,
  MenuItemSpec,
  ModalDelegate,
  ModalHost,
  Platform,
  RenderLifecycle,
  SuggestModalDelegate,
  SuggestModalHost,
} from "../../../src/platform/types";
import { nodeHttpRequest } from "./desktop-http";
import { renderIcon } from "../../../src/platform/dom/desktop-icons";
import { DomModalHost, DomSuggestModalHost, showContextMenuAt, showToast } from "../../../src/platform/dom/desktop-overlays";
import { installDomHelpers } from "../../../src/platform/dom/dom-polyfill";
import { NodeFileStorage } from "./desktop-storage";
import { renderMarkdownInto } from "../../../src/platform/dom/markdown";

export class DesktopPlatform implements Platform {
  readonly storage: FileStorage;

  constructor(opts: { baseDir: string }) {
    /* Idempotent, and cheap insurance: nothing this class builds can render
       before the prototype helpers exist, no matter what order the renderer
       boots in. */
    installDomHelpers();
    this.storage = new NodeFileStorage(opts.baseDir);
  }

  notify(message: string, timeoutMs?: number): void {
    showToast(message, timeoutMs);
  }

  setIcon(el: HTMLElement, iconId: string): void {
    renderIcon(el, iconId);
  }

  /* MarkdownRenderer's stand-in. `sourcePath` has no meaning without a vault
     (it exists so Obsidian can resolve relative links) and `lifecycle` is an
     opaque Component the Obsidian impl needs to own post-processors; neither
     has a job here. Kept in the signature because the interface is shared. */
  async renderMarkdown(
    markdown: string,
    el: HTMLElement,
    _sourcePath: string,
    _lifecycle?: RenderLifecycle,
  ): Promise<void> {
    renderMarkdownInto(markdown, el);
  }

  /* Delegated to node:http rather than the renderer's fetch, so a LAN POST
     carries no CORS preflight — requestUrl is exempt and this must match.
     ./desktop-http.ts owns the requestUrl semantics. */
  httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
    return nodeHttpRequest(options);
  }

  showContextMenu(evt: MouseEvent, items: MenuItemSpec[]): void {
    showContextMenuAt(evt, items);
  }

  createModal(delegate: ModalDelegate): ModalHost {
    return new DomModalHost(delegate);
  }

  createSuggestModal<T>(delegate: SuggestModalDelegate<T>): SuggestModalHost {
    return new DomSuggestModalHost<T>(delegate);
  }
}
