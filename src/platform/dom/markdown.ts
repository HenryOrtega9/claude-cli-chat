/* Markdown rendering + HTML sanitizing for the non-Obsidian hosts.

   Lifted verbatim out of app/src/desktop-platform.ts so the browser client
   can reuse it: `marked` is browser-safe, and everything here is plain DOM.
   Both DesktopPlatform and the iOS platform back `Platform.renderMarkdown`
   with renderMarkdownInto(). */

import { marked } from "marked";

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

export function sanitizeFragment(root: DocumentFragment): void {
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


/* MarkdownRenderer's stand-in for hosts without Obsidian. `sourcePath` and
   the render lifecycle have no meaning here (they exist so Obsidian can
   resolve relative links and own post-processors), so the caller keeps them
   in its own signature and drops them. */
export function renderMarkdownInto(markdown: string, el: HTMLElement): void {
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
