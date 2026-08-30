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

import {
  Check, CheckCircle2, ChevronDown, ChevronUp, Circle, CircleHelp, CircleX, Copy,
  ExternalLink, File, FileEdit, FilePlus, FileSpreadsheet, FileText, Folder,
  FolderOpen, Gauge, GitBranch, Globe, History, Image, Layers, LayoutGrid,
  ListChecks, LoaderCircle, LocateFixed, Paperclip, Pause, Pin, Play, PlugZap,
  Plus, Presentation, RefreshCw, RotateCcw, Search, Send, Settings, ShieldCheck,
  ShieldOff, Smartphone, Sparkles, Square, SquarePen, SquarePlus, Terminal,
  TerminalSquare, TextCursor, Trash2, Users, Volume2, Wrench, X, Zap,
} from "lucide";
import { CLAUDE_ASTERISK_ICON_SVG } from "../../view/Welcome";

/* IconNode is internal to lucide (not exported), restated here. */
type IconNode = [tag: string, attrs: Record<string, string | number | undefined>][];

/* Curated ids only — one named import per icon actually reachable from
   setIcon() call sites, iconForTool/iconForStatus/iconForTodoStatus,
   officeIconName, and the slash-command catalog. Importing the whole
   `icons` namespace (as this file used to) makes every one of lucide's ~1600
   icons reachable and defeats esbuild's tree-shaking — this way only the ids
   below are bundled. Keep sorted by kebab id; add a new entry (import above,
   plus a line here) whenever a new icon id is passed to setIcon anywhere in
   the app. A missing id still fails safely: renderIcon warns once and
   renders nothing, exactly as an unresolved icon did before. */
const iconMap: Record<string, IconNode | undefined> = {
  "check": Check,
  "check-circle-2": CheckCircle2,
  "chevron-down": ChevronDown,
  "chevron-up": ChevronUp,
  "circle": Circle,
  "circle-help": CircleHelp,
  "circle-x": CircleX,
  "copy": Copy,
  "external-link": ExternalLink,
  "file": File,
  "file-edit": FileEdit,
  "file-plus": FilePlus,
  "file-spreadsheet": FileSpreadsheet,
  "file-text": FileText,
  "folder": Folder,
  "folder-open": FolderOpen,
  "gauge": Gauge,
  "git-branch": GitBranch,
  "globe": Globe,
  "history": History,
  "image": Image,
  "layers": Layers,
  "layout-grid": LayoutGrid,
  "list-checks": ListChecks,
  "loader-circle": LoaderCircle,
  "locate-fixed": LocateFixed,
  "paperclip": Paperclip,
  "pause": Pause,
  "pin": Pin,
  "play": Play,
  "plug-zap": PlugZap,
  "plus": Plus,
  "presentation": Presentation,
  "refresh-cw": RefreshCw,
  "rotate-ccw": RotateCcw,
  "search": Search,
  "send": Send,
  "settings": Settings,
  "shield-check": ShieldCheck,
  "shield-off": ShieldOff,
  "smartphone": Smartphone,
  "sparkles": Sparkles,
  "square": Square,
  "square-pen": SquarePen,
  "square-plus": SquarePlus,
  "terminal": Terminal,
  "terminal-square": TerminalSquare,
  "text-cursor": TextCursor,
  "trash-2": Trash2,
  "users": Users,
  "volume-2": Volume2,
  "wrench": Wrench,
  "x": X,
  "zap": Zap,
};

const SVG_NS = "http://www.w3.org/2000/svg";

/* Mirrors main.ts's CLAUDE_ICON_ID. Duplicated as a literal rather than
   imported because src/main.ts is Obsidian-only and must never reach the
   app bundle. */
const CLAUDE_ICON_ID = "claude-asterisk";

/* Ids that resolved to nothing, so a typo warns once instead of per frame
   (setIcon runs inside streaming render loops). */
const warned = new Set<string>();

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

  const node = iconMap[iconId];
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
