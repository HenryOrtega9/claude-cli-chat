/* obsidian.setIcon, reimplemented against lucide directly.

   Obsidian ships the same lucide set and resolves an icon id by kebab-case
   name, emitting an inline <svg class="svg-icon lucide lucide-<id>"> with the
   stroke preset lucide's own renderer uses. Shared code only ever passes
   plain lucide ids plus the one id main.ts registers via addIcon
   ("claude-asterisk"), so this module reproduces both paths and nothing
   else.

   The asterisk is stored as INNER svg content pre-scaled for Obsidian's
   0-100 addIcon viewBox (see the comment on CLAUDE_ASTERISK_ICON_SVG), so it
   gets that viewBox here rather than lucide's 0 0 24 24, and paints with
   fill instead of stroke. */

import { icons } from "lucide";
import { CLAUDE_ASTERISK_ICON_SVG } from "../../src/view/Welcome";

/* lucide types `icons` as a namespace object of named exports, so a runtime
   lookup by id needs the index signature its own internal `Icons` type has
   (not exported). IconNode is likewise internal — restated here. */
type IconNode = [tag: string, attrs: Record<string, string | number | undefined>][];
const iconMap = icons as unknown as Record<string, IconNode | undefined>;

const SVG_NS = "http://www.w3.org/2000/svg";

/* Mirrors main.ts's CLAUDE_ICON_ID. Duplicated as a literal rather than
   imported because src/main.ts is Obsidian-only and must never reach the
   app bundle. */
const CLAUDE_ICON_ID = "claude-asterisk";

/* Ids that resolved to nothing, so a typo warns once instead of per frame
   (setIcon runs inside streaming render loops). */
const warned = new Set<string>();

/* "chevron-down" -> "ChevronDown", matching lucide's export naming. */
function toPascalCase(iconId: string): string {
  return iconId
    .split(/[-_]/)
    .filter(part => part.length > 0)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function newIconSvg(cls: string, viewBox: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  /* Obsidian emits 24x24 and lets `.svg-icon { width/height: var(--icon-size) }`
     do the real sizing, so the desktop stylesheet keeps that lever. */
  svg.setAttribute("width", "24");
  svg.setAttribute("height", "24");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("class", cls);
  return svg;
}

export function renderIcon(el: HTMLElement, iconId: string): void {
  /* setIcon replaces whatever the element held; callers rely on this to swap
     a chevron between up and down in place. */
  while (el.firstChild) el.removeChild(el.firstChild);

  if (iconId === CLAUDE_ICON_ID) {
    const svg = newIconSvg(`svg-icon ${CLAUDE_ICON_ID}`, "0 0 100 100");
    svg.setAttribute("fill", "currentColor");
    svg.innerHTML = CLAUDE_ASTERISK_ICON_SVG;
    el.appendChild(svg);
    return;
  }

  const node = iconMap[toPascalCase(iconId)];
  if (!node) {
    if (!warned.has(iconId)) {
      warned.add(iconId);
      console.warn(`[claude-cli-chat] unknown icon id: ${iconId}`);
    }
    return;
  }

  const svg = newIconSvg(`svg-icon lucide lucide-${iconId}`, "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const [tag, attrs] of node) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value !== undefined) child.setAttribute(key, String(value));
    }
    svg.appendChild(child);
  }
  el.appendChild(svg);
}
