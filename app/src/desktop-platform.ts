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

import { marked } from "marked";

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
} from "../../src/platform/types";
import { nodeHttpRequest } from "./desktop-http";
import { renderIcon } from "./desktop-icons";
import { DomModalHost, DomSuggestModalHost, showContextMenuAt, showToast } from "./desktop-overlays";
import { installDomHelpers } from "./dom-polyfill";
import { NodeFileStorage } from "./desktop-storage";

/* `marked` passes raw HTML through verbatim (it has shipped no sanitizer
   since v5), and this renderer's input is NOT trustworthy local text: an
   assistant message routinely quotes a page WebFetch pulled down, an MCP
   response, or a file the model read, which is exactly where prompt-injected
   markup arrives. The panel runs with nodeIntegration and no contextIsolation,
   so an inline handler that fires here has `require` in scope.
   Obsidian's MarkdownRenderer sanitizes; this has to do it itself.

   Structural, not regex-based, and deliberately not a <script> filter: a
   script parsed into a <template> is already flagged "already started" and
   never runs, while the vectors that DO run — on* attributes (they fire the
   moment the node is adopted into the live document), javascript: hrefs,
   <iframe src> — all survived the old two-regex pass untouched. */
const BLOCKED_ELEMENTS = "script, iframe, frame, frameset, object, embed, link, meta, base, form, style";
/* Attributes whose value is fetched or navigated to. */
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href", "data", "ping"]);
const DANGEROUS_URL = /^(?:javascript|vbscript|data|blob|file):/i;
/* The one data: form the chat legitimately produces: MessageRenderer renders
   image attachments as data: URIs. */
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp);base64,/i;

function sanitizeFragment(root: DocumentFragment): void {
  for (const el of Array.from(root.querySelectorAll(BLOCKED_ELEMENTS))) el.remove();
  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      /* Covers onerror/onload/onclick and every other event handler, however
         the markup cased or spaced them. */
      if (name.startsWith("on")) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (!URL_ATTRS.has(name)) continue;
      /* Whitespace and control characters are ignored inside a scheme when
         the browser resolves the URL, so `java&#9;script:` is live — strip
         them before matching rather than anchoring on \s*. */
      const scheme = attr.value.replace(/[\u0000-\u0020]/g, "");
      if (DANGEROUS_URL.test(scheme) && !SAFE_DATA_IMAGE.test(scheme)) {
        el.removeAttribute(attr.name);
      }
    }
  }
}

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
    /* breaks:true reproduces Obsidian's "Strict line breaks: off" default,
       which the chat's streaming text depends on for paragraph shape. */
    const parsed = marked.parse(markdown, { gfm: true, breaks: true, async: false });
    /* A template parses without running anything and lets the whole tree be
       appended in one move, so partial renders never flash — and, critically,
       gives the sanitizer a pass over the tree BEFORE any node is adopted into
       the live document, which is what makes on* handlers inert. */
    const template = document.createElement("template");
    template.innerHTML = parsed;
    sanitizeFragment(template.content);
    el.appendChild(template.content);
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
