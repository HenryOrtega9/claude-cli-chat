import { platform } from "../platform";
import {
  MODEL_LABELS,
  MODEL_GROUPS,
  MODEL_NOTES,
  EFFORT_LABELS,
  effortLevelsForModel,
  contextWindowForModel,
  PERMISSION_MODE_ORDER,
  PERMISSION_MODE_LABELS,
  PERMISSION_MODE_DESCRIPTIONS,
  nextPermissionMode,
  type ClaudeChatSettings,
  type ModelKey,
  type EffortLevel,
  type PermissionMode,
  type TrustedFolder,
} from "../settings-data";
import type { UsageSnapshot } from "../claude/Events";
import { CLAUDE_ASTERISK_DATA_URI } from "./Welcome";
import type { Attachment } from "./state";
import type { ActiveSelection } from "../platform/host";

/* Resolve a picked File to its absolute on-disk path inside Obsidian's
   Electron environment. Two APIs may apply:
     - `File.path` (Electron-specific extension) — available through
       Electron 31. Removed in Electron 32+.
     - `webUtils.getPathForFile(file)` — the replacement, available from
       Electron 28 onward via `require("electron").webUtils`.
   We try `.path` first because it's a free check on older builds, then
   fall back to webUtils. Returns "" when neither yields a path so the
   caller can surface a precise error to the user rather than a generic
   "couldn't read" — most often that means the renderer isn't seeing the
   `electron` module (sandboxed context, packaged build without node
   integration), which calls for a different remedy than a code fix. */
function resolveElectronFilePath(file: File): string {
  const fromExtension = (file as File & { path?: string }).path;
  if (fromExtension) return fromExtension;
  try {
    const electron = (window as unknown as { require?: (id: string) => unknown }).require?.("electron") as
      | { webUtils?: { getPathForFile?: (file: File) => string } }
      | undefined;
    const resolved = electron?.webUtils?.getPathForFile?.(file);
    if (resolved) return resolved;
  } catch (err) {
    console.warn("[claude-cli-chat] electron.webUtils.getPathForFile threw:", err);
  }
  return "";
}

/* True on hosts whose primary input is a finger (the iOS app), false in
   Obsidian on the desktop. Used only to decide whether a control needs a
   touch-reachable equivalent of a keyboard-only affordance; evaluated once
   because the answer cannot change for the lifetime of a window. Guarded for
   the non-browser environments that import this module's siblings. */
const TOUCH_PRIMARY: boolean = (() => {
  try {
    return window.matchMedia?.("(hover: none) and (pointer: coarse)").matches === true;
  } catch {
    return false;
  }
})();

/* btoa() needs a binary string. Building one with String.fromCharCode(...arr)
   blows the call stack on large images, so feed it in chunks. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(binary);
}

/* Common image MIME types — Finder drops sometimes give an empty `file.type`
   (especially for less-common formats), so we sniff the extension as a fallback
   so the file still rides as an image block instead of getting decoded as text. */
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
};

function guessMimeFromName(name: string): string {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return EXT_MIME[ext] ?? "";
}

/* Cap on bytes a single attachment may carry. Base64 inflates by ~4/3, and
   text attachments get re-embedded into wireText, so very large files would
   blow past Claude's per-turn input limit and waste tokens regardless. 10MB
   is comfortably above typical PDFs/screenshots and well under any model's
   per-turn budget. */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/* Obsidian's dragManager sets text/plain (and text/uri-list) to an
   `obsidian://open?vault=<enc>&file=<enc>` URL when a note is dragged —
   from the file explorer, search results, backlinks, bookmarks, or a tab
   header. Multi-select drags join one URL per line. Extract the vault-
   relative `file` param from one such line, or null if the line isn't an
   obsidian://open URL. Decoding is done per-param with decodeURIComponent
   (matching Obsidian's encodeURIComponent) rather than URLSearchParams,
   which would corrupt literal `+` characters in note names into spaces. */
function parseObsidianOpenUrl(line: string): string | null {
  if (!line.startsWith("obsidian://open?")) return null;
  const query = line.slice("obsidian://open?".length);
  for (const pair of query.split("&")) {
    const eq = pair.indexOf("=");
    if (eq === -1 || pair.slice(0, eq) !== "file") continue;
    try {
      const decoded = decodeURIComponent(pair.slice(eq + 1));
      return decoded || null;
    } catch {
      return null;
    }
  }
  return null;
}

/* Extracts vault paths from an obsidian://open URL payload. Returns one
   path per line ONLY when every non-empty line is an obsidian://open URL
   (the shape dragFile/dragFiles produce) — a mixed payload is treated as
   free text and gets []. The `file` param may omit the `.md` extension,
   so callers must resolve through getFirstLinkpathDest, not just a direct
   path lookup. */
export function extractObsidianUrlPaths(text: string): string[] {
  const lines = text.split("\n").map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return [];
  const paths: string[] = [];
  for (const line of lines) {
    const p = parseObsidianOpenUrl(line);
    if (p === null) return [];
    paths.push(p);
  }
  return paths;
}

/* Pulls a candidate vault path out of an arbitrary drag payload. Handles
   the formats Obsidian's drag source produces:
   - bare path (file explorer):   `MBA/Note.md`
   - wikilink:                    `[[Note]]`
   - wikilink with alias:         `[[Note|Alias]]`
   - wikilink with subpath/alias: `[[Note#Section|Alias]]`
   Returns null for things that obviously aren't a single path (multi-line,
   empty, has internal whitespace at line bounds). The caller still has to
   verify the result resolves in the vault — this only extracts the candidate. */
function extractVaultPathCandidate(text: string): string | null {
  const t = text.trim();
  if (!t || t.includes("\n")) return null;
  const wl = t.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]$/);
  if (wl) return wl[1].trim();
  return t;
}

export type SubmitPayload = {
  text: string;
  attachments: Attachment[];
  /* If set, the user had this editor selection pinned at submit time. The
     tab controller inlines it into the prompt before sending to Claude. */
  selection?: ActiveSelection;
};

/* Suggestion shown in the @-mention or /-command popup. */
export type Suggestion = {
  id: string;
  primary: string;     // main label
  secondary?: string;  // muted subtitle (path, hint, etc.)
  icon?: string;       // Obsidian icon name
  insert: string;      // text to insert at the trigger position
  /* When set to "folder", acceptSuggestion routes the selection to the
     onPinFolder callback (rendering as a pinned pill at the top) instead of
     inserting `insert` into the textarea. Files and slash commands continue
     to use text insertion. Other kinds are reserved for future use. */
  kind?: "file" | "folder" | "command" | "skill";
};

export type InputBoxCallbacks = {
  onSubmit: (payload: SubmitPayload) => void;
  onModelChange: (model: ModelKey) => void;
  onEffortChange: (effort: EffortLevel) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
  /* Fired when the user toggles the incognito pill. Only fires while the pill
     is unlocked (no live session yet). */
  onIncognitoChange: (incognito: boolean) => void;
  /* Fired when the user toggles the voice pill (speak responses aloud).
     Never locked — voice can flip mid-conversation, even mid-stream. */
  onVoiceChange: (voice: boolean) => void;
  /* Fired when the user clicks the play/pause button that accompanies an
     active voice pill. Caller (TabController) toggles the speech
     controller's pause state and reports it back via setVoicePaused. */
  onVoicePauseToggle: () => void;
  /* Fired with the composer's current text so the caller can persist it as
     TabState.draft. Debounced ~500ms while typing (see scheduleDraftPublish)
     and flushed immediately on blur, visibilitychange, and TabController.hide
     (tab switch) via the public flushDraft(). Also fired with "" immediately
     on a successful submit. Optional — without it drafts simply aren't
     persisted, which is how this behaved before draft persistence existed. */
  onDraftChange?: (draft: string) => void;
  /* Return vault file matches for an @-mention query. Caller (TabController)
     reads from app.vault and ranks. Limit to ~20 results. */
  onMentionQuery: (query: string) => Suggestion[];
  /* Return slash-command matches. Static list curated by the plugin. */
  onSlashQuery: (query: string) => Suggestion[];
  /* Fired when the user presses Esc while Claude is streaming (busy=true).
     Caller is expected to interrupt the in-flight turn. */
  onCancel: () => void;
  /* Fired when the user dismisses the selection chip via its (×) button.
     CONTRACT (consumed by Agent C / TabController): wire this to
     SelectionTracker.clear() so the next selectionchange refresh doesn't
     re-push the same selection back into the chip. Optional — InputBox
     keeps working without it but the chip will reappear on the next cursor
     move in the source editor. */
  onSelectionDismissed?: () => void;
  /* Fired when the user clicks the agents pill in the bottom toolbar.
     Caller (TabController) is expected to open the SubagentPicker. Optional —
     when undefined the pill stays hidden regardless of catalog count. */
  onAgentLaunch?: () => void;
  /* Fired when a folder is picked from the @-mention popup. Caller
     (TabController) is expected to add the folder path to the pinned-pill
     bar. Without this callback the folder suggestion silently no-ops on
     accept — InputBox doesn't know how to render pinned items itself. */
  onPinFolder?: (path: string) => void;
  /* Fired when something with a text/plain payload is dropped on the input
     and InputBox wants to know whether it's a vault item that should be
     pinned (as opposed to free text that should be inserted at the cursor).
     Return true if the path was recognized and pinned — InputBox will then
     skip its text-insertion fallback. Return false to fall through. Used by
     the Obsidian file-explorer drag path (files and folders both route here;
     pill rendering picks the kind via vault lookup). */
  onTryPinVaultPath?: (path: string) => boolean;
  /* Called from `dragover` so InputBox can decide whether to preventDefault
     (and show the drop-target affordance) when the browser-level dataTransfer
     is empty. Obsidian's file-explorer drags often don't populate
     `dataTransfer.types` at all — the dragged TFile/TFolder lives on
     `app.dragManager.draggable` instead. Without this hook the dragover skips
     preventDefault, the browser rejects the target, and the `drop` event
     never fires. TabController implements it by peeking at the dragManager. */
  onIsVaultDragActive?: () => boolean;
  /* Called from `drop` BEFORE the text/plain fallback. Lets TabController
     consume the drop directly from `app.dragManager.draggable` (the canonical
     source for files/folders dragged from Obsidian's file explorer). Return
     true if the drag was consumed and pinned. Pairs with onIsVaultDragActive. */
  onTryConsumeVaultDrag?: () => boolean;
  /* Trusted-folder bridge. InputBox renders the list inside the attach
     popup; the parent (TabController) owns the persisted state and the
     permissions writes. Callbacks let the popup query the list on each
     open (no state sync needed) and request mutations. All are optional —
     when undefined, the popup degrades to "Pick a file…" only. */
  onListTrustedFolders?: () => TrustedFolder[];
  onToggleTrustedFolder?: (path: string, enabled: boolean) => void;
  onAddTrustedFolder?: (path: string) => void;
  onRemoveTrustedFolder?: (path: string) => void;
};

/* Payload TabController hands to InputBox.setCostSurface() to populate the
   cost-surface pill and its hover popup. mcpServers lists every server
   configured in mcp.json (enabled or disabled) — the popup renders only
   the enabled ones; tools is the live tool list announced by the most
   recent init event (empty until the first turn). Enable/disable lives
   in the MCP servers settings modal, not here. */
export type CostSurfacePayload = {
  pinCount: number;
  mcpServers: Array<{
    name: string;
    enabled: boolean;
    tools: string[];
  }>;
};

/* Map a raw Anthropic model id ("claude-opus-4-7", "claude-sonnet-4-6",
   "claude-haiku-4-5-20251001") to the short family label used in the pill
   "via" badge. Unknown ids return null so the badge stays hidden rather
   than printing a useless raw id. */
function friendlySubModelLabel(modelId: string): "Opus" | "Sonnet" | "Haiku" | null {
  const id = modelId.toLowerCase();
  if (id.includes("opus")) return "Opus";
  if (id.includes("sonnet")) return "Sonnet";
  if (id.includes("haiku")) return "Haiku";
  return null;
}

export class InputBox {
  private root: HTMLElement;
  private wrapper: HTMLElement;
  private contextRow: HTMLElement;
  private textarea: HTMLTextAreaElement;
  /* Two-row layout: topToolbar frames the input from above with the
     mode + model pills (the "what's running" pair); bottomToolbar carries
     effort + usage + send (the "knobs + action" row). Split makes mode
     read as the primary risk control rather than buried mid-row. */
  private topToolbar: HTMLElement;
  private bottomToolbar: HTMLElement;
  private modelPill: HTMLElement;
  private modelPillLabel: HTMLElement;
  private modelPillVia: HTMLElement;
  private effortPill: HTMLElement;
  private effortPillValue: HTMLElement;
  private modePill: HTMLElement;
  private modePillValue: HTMLElement;
  /* Incognito ("temporary chat") toggle pill. Active = this tab persists
     nothing. Editable only before the first message; locked once a session
     exists (the --no-session-persistence decision is fixed at spawn time). */
  private incognitoPill: HTMLElement;
  private currentIncognito = false;
  /* Voice ("speak responses") toggle pill. Active = assistant text is read
     aloud as it streams. Per-tab, persisted, never locked. */
  private voicePill: HTMLElement;
  private currentVoice = false;
  /* Play/pause transport next to the voice pill. Only visible while voice
     is on; the pill stays the mode switch, this controls the sound. */
  private voicePauseBtn: HTMLElement;
  private voicePaused = false;
  /* Animated equalizer bars shown while audio is actually playing —
     the visual "Claude is talking" cue. Frozen (not hidden) while paused
     mid-playback so it still reads as "there's speech to resume". */
  private voiceSpeakingEl: HTMLElement;
  private voiceSpeaking = false;
  private incognitoLocked = false;
  private usageChip: HTMLElement;
  private usageDonutCircle: SVGCircleElement;
  private usagePercentEl: HTMLElement;
  private usagePill: HTMLElement;
  /* "Cost surface" pill — shows how much configuration ships with every turn
     (pinned files + connected MCP servers). Hidden when both counts are zero
     so empty tabs stay quiet. See setCostSurface(). */
  private costPill: HTMLElement;
  private costPillText: HTMLElement;
  /* Agents pill — shows the count of discovered subagent definitions and
     opens the SubagentPicker on click. Hidden when the catalog is empty or
     when the parent hasn't wired onAgentLaunch. */
  private agentsPill: HTMLElement | null = null;
  private agentsPillValue: HTMLElement | null = null;
  /* Two distinct numbers feed the pill:
     - agentsCount: total user-defined subagents discovered on disk (catalog
       size — set by TabController on mount and on /agent refresh).
     - runningAgentsCount: Task/Agent tools currently in-flight in this tab.
       Updated by TabController whenever a Task tool starts or completes.
     The pill is visible when either is > 0, so an empty catalog with a live
     subagent in flight still surfaces activity. */
  private agentsCount = 0;
  private runningAgentsCount = 0;
  /* Hover popup anchored to the costPill, showing per-server MCP details
     and an enable/disable checkbox per server. Built lazily on first
     hover and re-rendered when setCostSurface lands a new payload.
     Visibility driven by mouseenter/leave on pill+popup with a small
     grace window so cursor travel between the two doesn't close it. */
  private costPopup: HTMLElement | null = null;
  private costPopupHideTimer: number | null = null;
  /* Most-recent cost-surface payload, retained so the hover popup can
     re-render itself when shown without needing a fresh data load. */
  private costPayload: CostSurfacePayload | null = null;
  private sendBtn: HTMLElement;
  /* True while the send button is showing its stop affordance (touch hosts
     only — see setBusy). Kept so the icon swap runs on transitions rather
     than on every setBusy call. */
  private sendBtnIsStop = false;
  /* Floating "+" button at the bottom-left of the textarea — opens the native
     OS file picker. Pairs with the Finder drop handler so both ingest paths
     land in the same addFiles() pipeline. */
  private attachBtn: HTMLElement;
  private hiddenFileInput: HTMLInputElement;
  /* Mirror of hiddenFileInput but with webkitdirectory set — surfaces the
     OS directory chooser for the "Add folder…" row in the attach popup. */
  private hiddenDirInput!: HTMLInputElement;
  private callbacks: InputBoxCallbacks;
  private currentModel: ModelKey;
  private currentEffort: EffortLevel;
  private currentMode: PermissionMode;
  private busy = false;
  private attachments: Attachment[] = [];
  /* The active editor selection captured by SelectionTracker. Lives across
     keystrokes so the user can type a question without losing context. */
  private currentSelection: ActiveSelection | null = null;
  private openPopup: { el: HTMLElement; outsideHandler: (e: MouseEvent) => void; keyHandler: (e: KeyboardEvent) => void } | null = null;
  /* Active @ / slash suggestion popup. Tracked separately from `openPopup`
     (which handles the model/effort/mode pill popups) because suggestions are
     keyboard-driven by the textarea, not by clicks on a pill. */
  private suggestion: {
    el: HTMLElement;
    trigger: "@" | "/";
    triggerStart: number;  // index in textarea.value where the trigger char sits
    items: Suggestion[];
    activeIndex: number;
    /* Row elements from the last renderSuggestionRows(), index-aligned with
       `items`, reused across renders instead of rebuilt every keystroke. */
    rows: HTMLElement[];
    /* activeIndex as of the last actual scrollIntoView(), so renders that
       don't move the highlight don't re-trigger the scroll. */
    renderedActiveIndex: number;
  } | null = null;
  /* destroy() flips this so late-firing callbacks (FileReader.onload after a
     tab close, deferred setTimeout handlers, etc.) can no-op safely. */
  private destroyed = false;
  /* Debounce timer for onDraftChange — see scheduleDraftPublish(). 500ms,
     matching Persistence's own per-tab save debounce downstream. */
  private draftDebounceTimer: number | null = null;
  /* Last draft value actually handed to onDraftChange (or restored from),
     so publishDraft() can skip a redundant call — e.g. the debounce firing
     after a blur-triggered flushDraft() already sent the same text. */
  private lastPublishedDraft = "";
  /* Bound once so add/removeEventListener in the constructor/destroy() refer
     to the same function. Flushes the draft the moment the app backgrounds —
     the moment a relaunch or an iOS background-kill can follow before the
     500ms debounce would otherwise have fired. */
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === "hidden") this.flushDraft();
  };

  constructor(
    container: HTMLElement,
    settings: ClaudeChatSettings,
    callbacks: InputBoxCallbacks,
    initial?: { model?: ModelKey; effort?: EffortLevel; permissionMode?: PermissionMode; incognito?: boolean; voice?: boolean; draft?: string }
  ) {
    this.callbacks = callbacks;
    this.currentModel = initial?.model ?? settings.defaultModel;
    this.currentEffort = initial?.effort ?? settings.defaultEffort;
    this.currentMode = initial?.permissionMode ?? settings.permissionMode;
    this.currentIncognito = initial?.incognito ?? false;
    this.currentVoice = initial?.voice ?? false;

    this.root = container.createDiv({ cls: "claudian-input-container" });
    this.wrapper = this.root.createDiv({ cls: "claudian-input-wrapper" });

    /* Top toolbar — mode pill (left) + model pill (right). Created BEFORE
       the textarea so DOM order matches visual order. mountTopBar still
       prepends the active-file indicator above this row. */
    this.topToolbar = this.wrapper.createDiv({ cls: "claudian-input-toolbar claudian-input-toolbar-top" });

    this.contextRow = this.wrapper.createDiv({ cls: "claudian-context-row" });

    this.textarea = this.wrapper.createEl("textarea", {
      cls: "claudian-input",
      attr: { placeholder: "How can I help you today?", rows: "3", dir: "auto" },
    });
    this.textarea.addEventListener("keydown", e => this.handleKeydown(e));
    this.textarea.addEventListener("input", () => {
      this.autoResize();
      this.updateSuggestion();
      this.scheduleDraftPublish();
    });
    this.textarea.addEventListener("click", () => this.updateSuggestion());
    this.textarea.addEventListener("blur", () => {
      /* A blur is exactly the moment the user might switch apps next —
         flush immediately rather than trusting the 500ms debounce. */
      this.flushDraft();
      /* Defer so a click on a suggestion row can still register. */
      window.setTimeout(() => this.hideSuggestion(), 150);
    });
    this.textarea.addEventListener("paste", e => this.handlePaste(e));

    /* Backgrounding (app switch, iOS home button, tab-away in a browser host)
       can be followed by the OS killing the process before any timer fires.
       Torn down in destroy(). */
    document.addEventListener("visibilitychange", this.onVisibilityChange);

    /* Drop handler on the wrapper covers both the textarea and the chip row.
       Adds a `.is-drop-target` class during a file drag so the user gets
       visible feedback that the drop will be accepted. `dragenter` /
       `dragleave` fire per-child as the cursor moves through descendants —
       gating on `containsFiles` keeps the affordance off for non-file drags
       (vault @-mention drags, text selections from other apps). */
    const containsFiles = (e: DragEvent) =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types ?? []).includes("Files");
    this.wrapper.addEventListener("dragover", e => {
      /* Obsidian's file-explorer drag leaves dataTransfer.types empty (the
         payload lives on app.dragManager.draggable). Without preventDefault
         on dragover the browser rejects the target and the drop event never
         fires — so we ask the parent whether an Obsidian vault drag is
         currently in flight and accept on that signal too. */
      const vaultDrag = this.callbacks.onIsVaultDragActive?.() ?? false;
      if (e.dataTransfer?.types?.length || vaultDrag) e.preventDefault();
      if (containsFiles(e) || vaultDrag) this.wrapper.addClass("is-drop-target");
    });
    this.wrapper.addEventListener("dragleave", e => {
      /* Fired on every child boundary. Only clear when leaving the wrapper
         entirely — relatedTarget is null or outside when truly leaving. */
      const related = e.relatedTarget as Node | null;
      if (!related || !this.wrapper.contains(related)) {
        this.wrapper.removeClass("is-drop-target");
      }
    });
    this.wrapper.addEventListener("drop", e => {
      this.wrapper.removeClass("is-drop-target");
      this.handleDrop(e);
    });

    /* Hidden <input type=file> kept at wrapper-level so the attach button
       (which now lives in the bottom toolbar — see further down) can trigger
       it via .click(). Both the picker and Finder drops route through
       addFiles(). */
    this.hiddenFileInput = this.wrapper.createEl("input", {
      cls: "claudian-attach-input",
      attr: { type: "file", multiple: "true" },
    });
    this.hiddenFileInput.addEventListener("change", () => {
      const files = Array.from(this.hiddenFileInput.files ?? []);
      /* Clear so re-picking the same file fires change again. */
      this.hiddenFileInput.value = "";
      if (files.length > 0) void this.addFiles(files);
    });

    /* Hidden directory picker for the "Add folder…" row in the attach
       popup. webkitdirectory is the Electron-supported way to surface the
       OS folder chooser without pulling in @electron/remote. The browser
       hands back File objects for every entry under the chosen folder; we
       only need the first one's absolute path (resolved via the
       Electron-specific `File.path` extension on older Electron, or
       `webUtils.getPathForFile(file)` on Electron 32+ where `File.path`
       was removed) to derive the folder by stripping its
       webkitRelativePath tail. */
    this.hiddenDirInput = this.wrapper.createEl("input", {
      cls: "claudian-attach-input",
      attr: { type: "file", webkitdirectory: "true", directory: "true" },
    });
    this.hiddenDirInput.addEventListener("change", () => {
      const files = Array.from(this.hiddenDirInput.files ?? []);
      this.hiddenDirInput.value = "";
      if (files.length === 0) return;
      const first = files[0];
      const rel = first.webkitRelativePath ?? "";
      if (!rel) {
        platform.notify("Couldn't read the folder path (no webkitRelativePath).");
        return;
      }
      const abs = resolveElectronFilePath(first);
      if (!abs) {
        platform.notify("Couldn't read the folder path (Electron didn't expose an absolute path).");
        console.error("[claude-cli-chat] No File.path and no webUtils.getPathForFile available for picked folder; first file:", first);
        return;
      }
      /* webkitRelativePath is "<folderName>/<...children>" — it INCLUDES the
         chosen folder's own name as its first segment. Strip only the
         children part (everything after that first segment) from the absolute
         path; stripping the full rel would yield the folder's PARENT and
         silently trust one directory too wide. */
      const slash = rel.indexOf("/");
      const childTail = slash === -1 ? rel : rel.slice(slash + 1);
      const folderPath = abs.slice(0, Math.max(0, abs.length - childTail.length - 1));
      if (!folderPath) {
        platform.notify("Couldn't resolve the folder's absolute path.");
        return;
      }
      this.callbacks.onAddTrustedFolder?.(folderPath);
      /* Re-open the popup so the user sees the new entry land without
         needing a second click. Defer one tick so the file-input close
         doesn't swallow the popup-mount. */
      window.setTimeout(() => this.openAttachPopup(), 0);
    });

    /* Floating "42k / 1000k" chip — positioned absolutely just above the
       toolbar, right side. Hidden until the first usage snapshot arrives. */
    this.usageChip = this.wrapper.createDiv({ cls: "claudian-context-window-chip" });
    this.usageChip.style.display = "none";

    this.bottomToolbar = this.wrapper.createDiv({ cls: "claudian-input-toolbar claudian-input-toolbar-bottom" });

    /* ---- TOP ROW: mode (left) + model (right) ---------------------- */

    /* Permission-mode pill is loud on purpose — it's the runtime control
       with the highest blast radius (controls whether tools fire). Sits
       leftmost so the eye lands on it first. Cycle with Shift+Tab from
       the textarea or click to open a popup with all options. */
    this.modePill = this.topToolbar.createSpan({
      cls: "claudian-toolbar-pill claudian-mode-pill",
      attr: { "aria-label": "Permission mode (Shift+Tab to cycle)", title: "Permission mode — Shift+Tab to cycle" },
    });
    this.modePillValue = this.modePill.createSpan({ cls: "claudian-toolbar-pill-value" });
    this.modePill.createSpan({ cls: "claudian-toolbar-pill-label", text: "Mode" });
    this.modePill.addEventListener("click", e => {
      e.stopPropagation();
      this.toggleModePopup();
    });

    /* Incognito pill — sits right of the mode pill. A binary toggle (no
       popup): click flips temporary-chat on/off. Disabled once a session
       exists, since --no-session-persistence is fixed at spawn time. */
    this.incognitoPill = this.topToolbar.createSpan({
      cls: "claudian-toolbar-pill claudian-incognito-pill",
      attr: {
        "aria-label": "Incognito (temporary chat) — leaves nothing on disk",
        title: "Incognito — temporary chat that is never saved to history or disk",
      },
    });
    this.incognitoPill.createSpan({ cls: "claudian-toolbar-pill-value", text: "🕶" });
    this.incognitoPill.createSpan({ cls: "claudian-toolbar-pill-label", text: "Incognito" });
    this.incognitoPill.addEventListener("click", e => {
      e.stopPropagation();
      this.toggleIncognito();
    });

    /* Voice pill — sits right of incognito. Binary toggle: when active,
       this tab's assistant responses are spoken aloud as they stream.
       Toggling off mid-response also stops any in-flight speech (handled
       by TabController's onVoiceChange). */
    this.voicePill = this.topToolbar.createSpan({
      cls: "claudian-toolbar-pill claudian-voice-pill",
      attr: {
        "aria-label": "Voice — speak responses aloud",
        title: "Voice — read Claude's responses aloud as they stream",
      },
    });
    this.voicePill.createSpan({ cls: "claudian-toolbar-pill-value", text: "🔊" });
    this.voicePill.createSpan({ cls: "claudian-toolbar-pill-label", text: "Voice" });
    this.voicePill.addEventListener("click", e => {
      e.stopPropagation();
      this.toggleVoice();
    });

    /* Play/pause button — appears only while the voice pill is active, so
       the pill can stay on as the mode switch while this controls the
       sound (pause freezes mid-word, play resumes in place). */
    this.voicePauseBtn = this.topToolbar.createSpan({
      cls: "claudian-toolbar-pill claudian-voice-pause-btn",
      attr: { "aria-label": "Pause speech", title: "Pause speech" },
    });
    this.voicePauseBtn.addEventListener("click", e => {
      e.stopPropagation();
      this.callbacks.onVoicePauseToggle();
    });

    /* Speaking indicator — three animated bars, visible only while speech
       is playing (or frozen while paused mid-playback). */
    this.voiceSpeakingEl = this.topToolbar.createSpan({
      cls: "claudian-voice-speaking",
      attr: { "aria-label": "Claude is speaking" },
    });
    for (let i = 0; i < 3; i++) this.voiceSpeakingEl.createSpan({ cls: "claudian-voice-speaking-bar" });
    this.refreshVoicePill();

    this.topToolbar.createDiv({ cls: "claudian-input-toolbar-spacer" });

    /* Model pill — Claude logo popup on click. Sits at the right edge of
       the top row. The optional "via" badge to the right surfaces the
       actual model resolved for the most recent assistant turn — only
       diverges from the pill label when Opus Plan is selected (Opus in
       plan mode, Sonnet elsewhere). */
    this.modelPill = this.topToolbar.createSpan({
      cls: "claudian-toolbar-pill claudian-model-pill",
      attr: { "aria-label": "Choose model", title: "Choose model" },
    });
    this.modelPillLabel = this.modelPill.createSpan({ cls: "claudian-toolbar-pill-value" });
    this.modelPillVia = this.modelPill.createSpan({ cls: "claudian-model-pill-via" });
    this.modelPillVia.style.display = "none";
    this.modelPill.addEventListener("click", e => {
      e.stopPropagation();
      this.toggleModelPopup();
    });

    /* ---- BOTTOM ROW: effort + usage + spacer + send ---------------- */

    /* Effort pill — "Effort: <Value>" with the label muted and value orange. */
    this.effortPill = this.bottomToolbar.createSpan({
      cls: "claudian-toolbar-pill claudian-effort-pill",
      attr: { "aria-label": "Reasoning effort", title: "Reasoning effort" },
    });
    this.effortPill.createSpan({ cls: "claudian-toolbar-pill-label", text: "Effort" });
    this.effortPillValue = this.effortPill.createSpan({ cls: "claudian-toolbar-pill-value" });
    this.effortPill.addEventListener("click", e => {
      e.stopPropagation();
      this.toggleEffortPopup();
    });

    this.refreshModelPill();
    this.refreshEffortPill();
    this.refreshModePill();
    this.refreshIncognitoPill();

    /* Cost-surface pill — sits between effort and usage. Shows pinned-file
       count + connected MCP server count, both of which ride on every turn's
       input as cache-discounted but real tokens. Compact dual-count format
       keeps it scannable; tooltip carries the fuller explanation. Hidden
       until populated by TabController.refreshCostSurface(). */
    this.costPill = this.bottomToolbar.createSpan({
      cls: "claudian-toolbar-pill claudian-cost-pill",
      attr: {
        "aria-label": "Per-turn cost surface (pinned files + MCP servers)",
        title: "Pinned files and connected MCP servers ride on every turn. Hover for details.",
      },
    });
    this.costPillText = this.costPill.createSpan({ cls: "claudian-toolbar-pill-value" });
    this.costPill.style.display = "none";

    /* Agents pill — persistent toolbar entry. Always visible when the parent
       wired onAgentLaunch (which becomes "open Create-subagent dialog" by
       contract; legacy name kept to avoid churning the callback API). The
       value shows running count when subagents are in flight, otherwise
       catalog size — so an empty-catalog tab reads "Agents 0" inviting the
       user to click and create one. */
    if (this.callbacks.onAgentLaunch) {
      this.agentsPill = this.bottomToolbar.createSpan({
        cls: "claudian-toolbar-pill claudian-agents-pill",
        attr: {
          "aria-label": "Create a subagent",
          title: "Create a subagent definition. Click to open the creation dialog.",
        },
      });
      this.agentsPill.createSpan({ cls: "claudian-toolbar-pill-label", text: "Agents" });
      this.agentsPillValue = this.agentsPill.createSpan({ cls: "claudian-toolbar-pill-value", text: "0" });
      this.agentsPill.addEventListener("click", e => {
        e.stopPropagation();
        this.callbacks.onAgentLaunch?.();
      });
      /* Paint the initial value so the pill doesn't read blank before the
         first setAgentCount/setRunningAgentCount lands. */
      this.refreshAgentsPill();
    }
    /* Popup-trigger wiring: enter shows, leave schedules a close that the
       popup's own enter handler cancels — that handoff is what lets the
       cursor travel from pill to popup without the popup vanishing
       mid-flight. closeNow / scheduleClose live as instance methods so
       the popup-side handlers can call into them too. */
    this.costPill.addEventListener("mouseenter", () => this.openCostPopup());
    this.costPill.addEventListener("mouseleave", () => this.scheduleCostPopupClose());
    /* Click also toggles the popup (in addition to hover) so keyboard /
       touch users have a stable affordance. Tapping the pill while the
       popup is open closes it. */
    this.costPill.addEventListener("click", e => {
      e.stopPropagation();
      if (this.costPopup && this.costPopup.style.display !== "none") {
        this.closeCostPopupNow();
      } else {
        this.openCostPopup();
      }
    });

    /* Attach button — small icon button in the bottom toolbar. Sits between
       the MCP/agents pills and the usage donut, so it reads as "things you
       add to this turn" alongside the cost-surface controls. Clicking opens
       the OS file picker; the same addFiles() pipeline also receives Finder
       drops. Keyboard accessible via role + tabindex (span, not <button>,
       to keep visual parity with the toolbar pills). */
    this.attachBtn = this.bottomToolbar.createSpan({
      cls: "claudian-attach-button",
      attr: {
        "aria-label": "Attach file",
        title: "Attach file from your computer",
        role: "button",
        tabindex: "0",
      },
    });
    platform.setIcon(this.attachBtn, "plus");
    this.attachBtn.addEventListener("click", e => {
      e.stopPropagation();
      this.toggleAttachPopup();
    });
    this.attachBtn.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        e.stopPropagation();
        this.toggleAttachPopup();
      }
    });

    /* Usage donut + percentage — inline in the bottom toolbar. Hidden
       until the first usage snapshot lands. */
    this.usagePill = this.bottomToolbar.createSpan({
      cls: "claudian-toolbar-pill claudian-usage-pill",
      attr: { "aria-label": "Context window usage", title: "Context window usage" },
    });
    this.usagePill.style.display = "none";
    const svgNS = "http://www.w3.org/2000/svg";
    const donut = document.createElementNS(svgNS, "svg");
    donut.setAttribute("class", "claudian-usage-donut");
    donut.setAttribute("viewBox", "0 0 16 16");
    donut.setAttribute("width", "14");
    donut.setAttribute("height", "14");
    const track = document.createElementNS(svgNS, "circle");
    track.setAttribute("cx", "8");
    track.setAttribute("cy", "8");
    track.setAttribute("r", "6");
    track.setAttribute("fill", "none");
    track.setAttribute("stroke", "currentColor");
    track.setAttribute("stroke-opacity", "0.2");
    track.setAttribute("stroke-width", "2.5");
    donut.appendChild(track);
    this.usageDonutCircle = document.createElementNS(svgNS, "circle");
    this.usageDonutCircle.setAttribute("cx", "8");
    this.usageDonutCircle.setAttribute("cy", "8");
    this.usageDonutCircle.setAttribute("r", "6");
    this.usageDonutCircle.setAttribute("fill", "none");
    this.usageDonutCircle.setAttribute("stroke", "currentColor");
    this.usageDonutCircle.setAttribute("stroke-width", "2.5");
    this.usageDonutCircle.setAttribute("stroke-linecap", "round");
    this.usageDonutCircle.setAttribute("pathLength", "100");
    this.usageDonutCircle.setAttribute("stroke-dasharray", "0 100");
    this.usageDonutCircle.setAttribute("transform", "rotate(-90 8 8)");
    donut.appendChild(this.usageDonutCircle);
    this.usagePill.appendChild(donut);
    this.usagePercentEl = this.usagePill.createSpan({ cls: "claudian-toolbar-pill-value claudian-usage-percent", text: "0%" });

    /* The "Nk / Mk" chip is a hover-revealed tooltip on the donut pill, not
       a permanent label. Show it only while the cursor is over the pill, and
       only if we have actual usage data to display. */
    this.usagePill.addEventListener("mouseenter", () => {
      if (this.usageChip.textContent && this.usageChip.textContent.length > 0) {
        this.usageChip.style.display = "";
      }
    });
    this.usagePill.addEventListener("mouseleave", () => {
      this.usageChip.style.display = "none";
    });

    this.bottomToolbar.createDiv({ cls: "claudian-input-toolbar-spacer" });

    this.sendBtn = this.bottomToolbar.createSpan({
      cls: "claudian-send-button",
      /* "(Enter)" is only true on a pointer host — see handleKeydown, where
         a touch host leaves Enter as a plain newline. VoiceOver reads the
         title along with the label, so a phone gets the plain word rather
         than a hint that no longer describes what the key does. */
      attr: { "aria-label": "Send", title: TOUCH_PRIMARY ? "Send" : "Send (Enter)" },
    });
    platform.setIcon(this.sendBtn, "send");
    this.sendBtn.addEventListener("click", () => {
      if (this.sendBtnIsStop) this.callbacks.onCancel();
      else this.submit();
    });

    /* Restore whatever draft this tab had when it was last torn down (app
       relaunch, plugin reload, iOS background-kill). Seed lastPublishedDraft
       to the same value so the debounce's first tick is a no-op instead of
       re-publishing the exact text it was just read back from. Placed at the
       very end of the constructor so autoResize() sees the fully-laid-out
       wrapper rather than a partially-built one. */
    if (initial?.draft) {
      this.textarea.value = initial.draft;
      this.autoResize();
    }
    this.lastPublishedDraft = initial?.draft ?? "";
  }

  setBusy(busy: boolean) {
    this.busy = busy;
    /* On a touch host the send button doubles as the stop control while a
       turn runs, because cancelling is otherwise Escape-only and a phone has
       no Escape key. On a pointer host nothing changes: the button greys out
       exactly as before and Escape stays the way to cancel. */
    const asStop = busy && TOUCH_PRIMARY;
    this.sendBtn.toggleClass("is-disabled", busy && !asStop);
    if (asStop !== this.sendBtnIsStop) {
      this.sendBtnIsStop = asStop;
      this.sendBtn.toggleClass("is-stop", asStop);
      platform.setIcon(this.sendBtn, asStop ? "square" : "send");
      this.sendBtn.setAttr("aria-label", asStop ? "Stop" : "Send");
      this.sendBtn.setAttr("title", asStop ? "Stop this turn" : (TOUCH_PRIMARY ? "Send" : "Send (Enter)"));
    }
  }

  /* Update the cost-surface pill and refresh the hover popup. Caller
     passes a structured payload (see CostSurfacePayload). The pill shows
     a compact "Pinned N · MCP M (T tools)" summary; the popup expands
     into per-server detail with enable/disable checkboxes. Pill hides
     entirely when there's nothing to surface.

     Tool count is the sum across ENABLED servers only — disabled servers
     don't contribute to the on-wire token cost, so they shouldn't show
     up in the headline number even though they appear in the popup. */
  setCostSurface(payload: CostSurfacePayload) {
    this.costPayload = payload;
    const pinCount = payload.pinCount;
    const enabledServers = payload.mcpServers.filter(s => s.enabled);
    const mcpCount = enabledServers.length;
    const toolCount = enabledServers.reduce((sum, s) => sum + s.tools.length, 0);

    if (pinCount <= 0 && payload.mcpServers.length <= 0) {
      this.costPill.style.display = "none";
      this.closeCostPopupNow();
      return;
    }
    const parts: string[] = [];
    if (pinCount > 0) parts.push(`Pinned ${pinCount}`);
    if (payload.mcpServers.length > 0) {
      /* "MCP 2 (5 tools)" once we know tool counts; just "MCP 2" before
         the first init lands. Singular tool stays "tool".

         On a touch host the suffix is dropped: the bottom toolbar (effort,
         this pill, agents, attach, usage, send) is a single unwrapped row at
         390px, and "(103 tools)" alone is wider than the send button needs to
         stay reachable. The count still lives one tap away — the popup header
         and every card in it repeat it — so nothing is actually lost, only
         moved off the row that has no room for it. */
      const mcpLabel = toolCount > 0 && !TOUCH_PRIMARY
        ? `MCP ${mcpCount} (${toolCount} tool${toolCount === 1 ? "" : "s"})`
        : `MCP ${mcpCount}`;
      parts.push(mcpLabel);
    }
    this.costPillText.setText(parts.join(" · "));
    this.costPill.setAttribute(
      "title",
      `${pinCount} pinned file${pinCount === 1 ? "" : "s"} + ${mcpCount} active MCP server${mcpCount === 1 ? "" : "s"} (${toolCount} tool${toolCount === 1 ? "" : "s"}) ride on every turn. Hover for details + toggles.`
    );
    this.costPill.style.display = "";
    /* If the popup is currently visible, re-render its contents so the
       checkbox states / tool counts stay in sync with the new payload. */
    if (this.costPopup && this.costPopup.style.display !== "none") {
      this.renderCostPopupContent();
    }
  }

  /* Updates the catalog count (user-defined subagents on disk). Visibility
     is decided by the combined catalog+running state in refreshAgentsPill. */
  setAgentCount(count: number): void {
    this.agentsCount = count;
    this.refreshAgentsPill();
  }

  /* Updates the running count (Task/Agent tools currently in flight in this
     tab). Drives the .is-running tone on the pill and forces visibility even
     when the catalog is empty, so users see subagent activity at a glance. */
  setRunningAgentCount(count: number): void {
    this.runningAgentsCount = count;
    this.refreshAgentsPill();
  }

  private refreshAgentsPill(): void {
    if (!this.agentsPill || !this.agentsPillValue) return;
    const catalog = this.agentsCount;
    const running = this.runningAgentsCount;
    /* Pill is persistent — always shown when the parent wired onAgentLaunch
       (we only get here if the constructor created the element). Four display
       states; the rest button is what the user clicks to open the Create
       dialog regardless of count. */
    let valueText: string;
    let title: string;
    if (running > 0 && catalog > 0) {
      valueText = `${running} / ${catalog}`;
      title = `${running} subagent${running === 1 ? "" : "s"} running · ${catalog} in catalog. Click to create a new one (use /agent to launch an existing one).`;
    } else if (running > 0) {
      valueText = String(running);
      title = `${running} subagent${running === 1 ? "" : "s"} running. Click to create a new one (use /agent to launch an existing one).`;
    } else if (catalog > 0) {
      valueText = String(catalog);
      title = `${catalog} subagent${catalog === 1 ? "" : "s"} in catalog. Click to create another (use /agent to launch an existing one).`;
    } else {
      valueText = "0";
      title = "No subagents yet. Click to create your first one.";
    }
    this.agentsPillValue.setText(valueText);
    this.agentsPill.setAttribute("title", title);
    this.agentsPill.toggleClass("is-running", running > 0);
    this.agentsPill.style.display = "";
  }

  private openCostPopup() {
    if (!this.costPayload) return;
    if (this.costPopupHideTimer !== null) {
      window.clearTimeout(this.costPopupHideTimer);
      this.costPopupHideTimer = null;
    }
    if (!this.costPopup) {
      this.costPopup = this.wrapper.createDiv({ cls: "claudian-cost-popup" });
      /* Stop clicks inside the popup from bubbling — checkbox clicks
         shouldn't propagate to outside listeners that might close us. */
      this.costPopup.addEventListener("click", e => e.stopPropagation());
      /* Hover handoff: cursor moving from pill onto the popup cancels
         the scheduled close, so the user can actually click checkboxes
         without the popup vanishing under their cursor. */
      this.costPopup.addEventListener("mouseenter", () => {
        if (this.costPopupHideTimer !== null) {
          window.clearTimeout(this.costPopupHideTimer);
          this.costPopupHideTimer = null;
        }
      });
      this.costPopup.addEventListener("mouseleave", () => this.scheduleCostPopupClose());
    }
    this.renderCostPopupContent();
    this.costPopup.style.display = "";
    /* Re-anchor on every open — the pill's position can shift between
       opens (window resize, toolbar items added/removed). Same anchoring
       contract as anchorPopup() for click-driven popups: pin to the pill
       horizontally, sit just above the wrapper edge so the popup grows
       upward into the message area. */
    const pillRect = this.costPill.getBoundingClientRect();
    const wrapperRect = this.wrapper.getBoundingClientRect();
    this.costPopup.style.position = "absolute";
    const wrapperMidX = (wrapperRect.left + wrapperRect.right) / 2;
    const pillMidX = (pillRect.left + pillRect.right) / 2;
    const costPinRight = pillMidX > wrapperMidX;
    if (costPinRight) {
      this.costPopup.style.right = `${wrapperRect.right - pillRect.right}px`;
      this.costPopup.style.left = "";
    } else {
      this.costPopup.style.left = `${pillRect.left - wrapperRect.left}px`;
      this.costPopup.style.right = "";
    }
    this.costPopup.style.bottom = `${wrapperRect.bottom - pillRect.top + 6}px`;
    this.costPopup.style.top = "";
    /* Cap the height to the gap between the viewport top and the popup's
       bottom edge (which sits just above the pill). The popup grows upward
       from a bottom anchor, so without this a server with many tools — e.g.
       webull's 68 — would overflow off the top of the screen with no way to
       scroll to the hidden servers/footer. 8px keeps it off the very edge;
       160px floor stops it collapsing to nothing in a tiny window. The inner
       server list (.claudian-cost-popup-server-list) is the scroll region. */
    const available = pillRect.top - 6 - 8;
    this.costPopup.style.maxHeight = `${Math.max(160, available)}px`;
    this.publishPopupHeadroom(
      this.costPopup,
      pillRect.top,
      costPinRight ? pillRect.right - 8 : window.innerWidth - pillRect.left - 8,
    );
  }

  private scheduleCostPopupClose() {
    if (this.costPopupHideTimer !== null) window.clearTimeout(this.costPopupHideTimer);
    /* 250ms grace gives enough time for cursor travel between pill and
       popup; longer feels sluggish, shorter races with normal hand
       motion. */
    this.costPopupHideTimer = window.setTimeout(() => {
      this.closeCostPopupNow();
    }, 250);
  }

  private closeCostPopupNow() {
    if (this.costPopupHideTimer !== null) {
      window.clearTimeout(this.costPopupHideTimer);
      this.costPopupHideTimer = null;
    }
    if (this.costPopup) this.costPopup.style.display = "none";
  }

  /* Build the popup body from the cached payload. Cleared and rebuilt
     on every render so toggle state transitions land cleanly without
     having to diff individual checkboxes. */
  private renderCostPopupContent() {
    if (!this.costPopup || !this.costPayload) return;
    this.costPopup.empty();
    const payload = this.costPayload;

    /* Header line summarizing the on-wire cost surface. Same info as the
       pill text but expanded — gives context for the controls below. */
    const header = this.costPopup.createDiv({ cls: "claudian-cost-popup-header" });
    const enabledServers = payload.mcpServers.filter(s => s.enabled);
    const toolCount = enabledServers.reduce((sum, s) => sum + s.tools.length, 0);
    header.createDiv({
      cls: "claudian-cost-popup-title",
      text: `MCP: ${enabledServers.length} active · ${toolCount} tool${toolCount === 1 ? "" : "s"}`,
    });
    header.createDiv({
      cls: "claudian-cost-popup-subtitle",
      text: "Every turn ships these tool definitions.",
    });

    if (enabledServers.length === 0) {
      this.costPopup.createDiv({
        cls: "claudian-cost-popup-empty",
        text: "No MCP servers enabled.",
      });
      return;
    }

    /* One card per enabled server. Disabled servers are omitted here;
       enable/disable lives in the MCP servers settings modal. */
    const list = this.costPopup.createDiv({ cls: "claudian-cost-popup-server-list" });
    for (const server of enabledServers) {
      const card = list.createDiv({ cls: "claudian-cost-popup-server" });
      const head = card.createDiv({ cls: "claudian-cost-popup-server-head" });
      head.createSpan({ cls: "claudian-cost-popup-server-name", text: server.name });
      head.createSpan({
        cls: "claudian-cost-popup-server-count",
        text: `${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`,
      });

      if (server.tools.length > 0) {
        /* Servers with big tool surfaces (webull ships 68) would otherwise
           stretch the popup to full screen height; past 10 tools the list
           becomes its own scroll region capped at ~10 rows. */
        const toolList = card.createDiv({
          cls: "claudian-cost-popup-tool-list" +
            (server.tools.length > 10 ? " is-scrollable" : ""),
        });
        for (const tool of server.tools) {
          toolList.createDiv({ cls: "claudian-cost-popup-tool", text: tool });
        }
      } else {
        /* Enabled but no tools yet means the init event hasn't landed
           (brand-new tab, no first message). Surface this so the user
           doesn't think the server is broken. */
        card.createDiv({
          cls: "claudian-cost-popup-tool-list claudian-cost-popup-pending",
          text: "Tool list arrives after first message.",
        });
      }
    }

    this.costPopup.createDiv({
      cls: "claudian-cost-popup-footer",
      text: "Manage servers in Settings → MCP servers.",
    });
  }

  /* Tear down the InputBox cleanly. Removes any document-level listeners that
     popups installed, closes any visible popup/suggestion (which also pulls
     their listeners), and flips `destroyed` so late callbacks (deferred
     setTimeout-installed listeners, FileReader.onload after a paste while the
     tab is being closed) short-circuit instead of touching detached DOM.
     CONTRACT (consumed by Agent C / TabController): call on tab close BEFORE
     the parent DOM is removed so the global document.removeEventListener
     handles in closePopup/hideSuggestion are still wired to live references. */
  public destroy(): void {
    this.destroyed = true;
    if (this.openPopup) this.closePopup();
    if (this.suggestion) this.hideSuggestion();
    /* The cost popup's 250ms close-grace timer is not owned by closePopup/
       hideSuggestion. Left pending, it fires after teardown and touches the
       already-detached costPopup node. */
    if (this.costPopupHideTimer !== null) {
      window.clearTimeout(this.costPopupHideTimer);
      this.costPopupHideTimer = null;
    }
    if (this.draftDebounceTimer !== null) {
      window.clearTimeout(this.draftDebounceTimer);
      this.draftDebounceTimer = null;
    }
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
  }

  /* Mounts an external element (e.g. the active-file pill bar) just
     above the textarea, inside the framed input box but below the top
     toolbar. Sits between contextRow and the textarea for two reasons:
     (1) it visually groups with the input itself ("these are the files
     the upcoming message will reference") rather than reading as part of
     the toolbar; (2) keeps the mode/model pills as the very first row,
     which is what the layout decision optimized for. */
  mountTopBar(el: HTMLElement) {
    this.wrapper.insertBefore(el, this.contextRow);
  }

  setVisible(visible: boolean) {
    this.root.style.display = visible ? "" : "none";
  }

  setModel(model: ModelKey) {
    this.currentModel = model;
    /* Switching to a non-opus-plan model clears the "via" badge — the badge
       only carries meaning when the user-selected model is the opusplan alias. */
    if (model !== "opus-plan") this.clearActiveSubModel();
    this.refreshModelPill();
  }

  /* Called with the `model` field from each assistant event. When the user
     picked Opus Plan, the CLI resolves to Opus (in plan mode) or Sonnet
     (otherwise) and reports the chosen model on every assistant message —
     surfacing it here makes the mid-turn swap visible.

     For any other selected model the actual model always equals the selected
     one, so the badge stays hidden to avoid visual noise. */
  setActiveSubModel(actualModelId: string | undefined) {
    if (!actualModelId || this.currentModel !== "opus-plan") {
      this.clearActiveSubModel();
      return;
    }
    const label = friendlySubModelLabel(actualModelId);
    if (!label) {
      this.clearActiveSubModel();
      return;
    }
    this.modelPillVia.setText(`→ ${label}`);
    this.modelPillVia.style.display = "";
    /* Tone the badge so the swap is obvious at a glance: Opus = brand orange,
       Sonnet = muted blue. */
    this.modelPillVia.removeClass("is-opus");
    this.modelPillVia.removeClass("is-sonnet");
    if (label === "Opus") this.modelPillVia.addClass("is-opus");
    else if (label === "Sonnet") this.modelPillVia.addClass("is-sonnet");
  }

  private clearActiveSubModel() {
    this.modelPillVia.setText("");
    this.modelPillVia.style.display = "none";
  }

  setEffort(effort: EffortLevel) {
    this.currentEffort = effort;
    this.refreshEffortPill();
  }

  setPermissionMode(mode: PermissionMode) {
    this.currentMode = mode;
    this.refreshModePill();
  }

  /* Update the context-window indicators from a usage snapshot. Reads either
     snake_case (raw stream-json) or camelCase (Agent SDK normalized) token
     fields, sums them for the "context tokens" numerator, and uses the
     model's default window as the denominator unless the snapshot includes
     an explicit contextWindow. */
  setUsage(usage: UsageSnapshot | undefined) {
    if (!usage) {
      this.usageChip.style.display = "none";
      this.usagePill.style.display = "none";
      return;
    }
    const inputTokens      = usage.input_tokens                 ?? usage.inputTokens               ?? 0;
    const outputTokens     = usage.output_tokens                ?? usage.outputTokens              ?? 0;
    const cacheReadTokens  = usage.cache_read_input_tokens      ?? usage.cacheReadInputTokens      ?? 0;
    const cacheCreateTokens = usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens  ?? 0;

    const window = usage.contextWindow ?? contextWindowForModel(this.currentModel);
    /* Tokens currently loaded in context = input + cached + output of the
       last turn (the output becomes context for the next turn). */
    const contextTokens = usage.contextTokens ?? (inputTokens + cacheReadTokens + cacheCreateTokens + outputTokens);

    if (contextTokens <= 0 || window <= 0) {
      this.usageChip.style.display = "none";
      this.usageChip.setText("");
      this.usagePill.style.display = "none";
      return;
    }
    const percent = Math.min(100, Math.max(0, (contextTokens / window) * 100));
    /* Refresh the chip text but don't toggle its visibility — the donut
       pill's mouseenter handler shows it on hover only. */
    this.usageChip.setText(`${this.formatTokens(contextTokens)} / ${this.formatTokens(window)}`);
    this.usagePill.style.display = "";
    this.usageDonutCircle.setAttribute("stroke-dasharray", `${percent.toFixed(2)} 100`);
    this.usagePercentEl.setText(percent < 1 ? "<1%" : `${Math.round(percent)}%`);
    /* Heat-tone the donut + percentage as the window fills. Stays brand
       orange until 75%, then amber, then red past 90%. */
    this.usagePill.removeClass("warn");
    this.usagePill.removeClass("danger");
    if (percent >= 90) this.usagePill.addClass("danger");
    else if (percent >= 75) this.usagePill.addClass("warn");
  }

  private formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
    return `${n}`;
  }

  focus() {
    this.textarea.focus();
  }

  insertAtCursor(text: string) {
    const start = this.textarea.selectionStart ?? this.textarea.value.length;
    const end = this.textarea.selectionEnd ?? this.textarea.value.length;
    const before = this.textarea.value.slice(0, start);
    const after = this.textarea.value.slice(end);
    this.textarea.value = before + text + after;
    const cursor = start + text.length;
    this.textarea.selectionStart = this.textarea.selectionEnd = cursor;
    this.textarea.focus();
    this.autoResize();
  }

  private refreshModelPill() {
    this.modelPillLabel.setText(MODEL_LABELS[this.currentModel]);
  }

  private refreshEffortPill() {
    this.effortPillValue.setText(EFFORT_LABELS[this.currentEffort]);
  }

  private refreshModePill() {
    this.modePillValue.setText(PERMISSION_MODE_LABELS[this.currentMode]);
    /* Drop any prior mode-tone classes so the warning state turns off when
       cycling back to safer modes. */
    this.modePill.removeClass("mode-plan");
    this.modePill.removeClass("mode-bypass");
    this.modePill.removeClass("mode-auto");
    if (this.currentMode === "plan") this.modePill.addClass("mode-plan");
    else if (this.currentMode === "bypassPermissions") this.modePill.addClass("mode-bypass");
    else if (this.currentMode === "auto") this.modePill.addClass("mode-auto");
  }

  private refreshIncognitoPill() {
    this.incognitoPill.toggleClass("is-active", this.currentIncognito);
    this.incognitoPill.toggleClass("is-disabled", this.incognitoLocked);
  }

  private toggleIncognito() {
    if (this.incognitoLocked) return;
    this.currentIncognito = !this.currentIncognito;
    this.refreshIncognitoPill();
    this.callbacks.onIncognitoChange(this.currentIncognito);
  }

  private refreshVoicePill() {
    this.voicePill.toggleClass("is-active", this.currentVoice);
    this.voicePauseBtn.toggleClass("is-hidden", !this.currentVoice);
    platform.setIcon(this.voicePauseBtn, this.voicePaused ? "play" : "pause");
    const label = this.voicePaused ? "Resume speech" : "Pause speech";
    this.voicePauseBtn.setAttribute("aria-label", label);
    this.voicePauseBtn.setAttribute("title", label);
    /* Bars show whenever there's live playback (speaking, or paused with
       speech held); the animation itself only runs while unpaused. */
    this.voiceSpeakingEl.toggleClass("is-hidden", !(this.currentVoice && this.voiceSpeaking));
    this.voiceSpeakingEl.toggleClass("is-paused", this.voicePaused);
  }

  private toggleVoice() {
    this.currentVoice = !this.currentVoice;
    this.refreshVoicePill();
    this.callbacks.onVoiceChange(this.currentVoice);
  }

  /* Programmatic voice toggle (commands / restore). Does NOT fire the
     callback — callers already know. */
  setVoice(voice: boolean) {
    this.currentVoice = voice;
    this.refreshVoicePill();
  }

  /* Reflect the speech controller's pause state on the transport button.
     Called by TabController after toggles and after anything that resets
     playback (new submit, cancel, voice off). */
  setVoicePaused(paused: boolean) {
    if (this.voicePaused === paused) return;  /* notify fires per chunk — skip the setIcon rebuild */
    this.voicePaused = paused;
    this.refreshVoicePill();
  }

  /* Reflect live playback on the speaking indicator. Driven by
     TabController's SpeechController subscription. */
  setVoiceSpeaking(speaking: boolean) {
    if (this.voiceSpeaking === speaking) return;
    this.voiceSpeaking = speaking;
    this.refreshVoicePill();
  }

  /* Lock/unlock the incognito pill. TabController locks once a session exists
     (the decision is fixed at spawn time) and on restore of a tab that already
     has history. */
  setIncognitoLocked(locked: boolean) {
    this.incognitoLocked = locked;
    this.refreshIncognitoPill();
  }

  private toggleModePopup() {
    if (this.openPopup) {
      const wasMode = this.openPopup.el.classList.contains("claudian-popup-mode");
      this.closePopup();
      if (wasMode) return;
    }
    const popup = this.createPopup("claudian-popup-mode");
    popup.createDiv({ cls: "claudian-popup-header", text: "PERMISSION MODE" });
    for (const key of PERMISSION_MODE_ORDER) {
      const row = popup.createDiv({
        cls: "claudian-popup-row claudian-popup-row-stacked" + (key === this.currentMode ? " is-selected" : ""),
      });
      row.createDiv({ cls: "claudian-popup-row-label", text: PERMISSION_MODE_LABELS[key] });
      row.createDiv({ cls: "claudian-popup-row-sublabel", text: PERMISSION_MODE_DESCRIPTIONS[key] });
      row.addEventListener("click", e => {
        e.stopPropagation();
        this.setModeAndNotify(key);
        this.closePopup();
      });
    }
    this.anchorPopup(popup, this.modePill);
  }

  /* Advance one step through PERMISSION_MODE_ORDER. Bound to Shift+Tab. */
  private cyclePermissionMode() {
    this.setModeAndNotify(nextPermissionMode(this.currentMode));
  }

  private setModeAndNotify(mode: PermissionMode) {
    if (mode === this.currentMode) return;
    this.currentMode = mode;
    this.refreshModePill();
    this.callbacks.onPermissionModeChange(mode);
  }

  private toggleModelPopup() {
    if (this.openPopup) {
      const wasModel = this.openPopup.el.classList.contains("claudian-popup-model");
      this.closePopup();
      if (wasModel) return;
    }
    const popup = this.createPopup("claudian-popup-model");
    for (const group of MODEL_GROUPS) {
      popup.createDiv({ cls: "claudian-popup-header", text: group.header });
      for (const key of group.keys) {
        const row = popup.createDiv({
          cls: "claudian-popup-row" + (key === this.currentModel ? " is-selected" : ""),
        });
        const icon = row.createSpan({ cls: "claudian-popup-row-icon" });
        const img = icon.createEl("img");
        img.src = CLAUDE_ASTERISK_DATA_URI;
        img.alt = "";
        const note = MODEL_NOTES[key];
        if (note) {
          /* Models with an availability caveat stack label over the note,
             reusing the icon + labels-column shell from folder rows. */
          const labels = row.createDiv({ cls: "claudian-popup-row-labels" });
          labels.createDiv({ cls: "claudian-popup-row-label", text: MODEL_LABELS[key] });
          labels.createDiv({ cls: "claudian-popup-row-sublabel", text: note });
        } else {
          row.createSpan({ cls: "claudian-popup-row-label", text: MODEL_LABELS[key] });
        }
        row.addEventListener("click", e => {
          e.stopPropagation();
          this.selectModel(key);
          this.closePopup();
        });
      }
    }
    this.anchorPopup(popup, this.modelPill);
  }

  /* Switching off Opus while X-High is selected would leave an effort the
     new model doesn't expose in the UI — silently demote to High so the
     pill and the spawned subprocess stay in sync. */
  private selectModel(model: ModelKey) {
    const allowed = effortLevelsForModel(model);
    if (!allowed.includes(this.currentEffort)) {
      this.currentEffort = "high";
      this.refreshEffortPill();
      this.callbacks.onEffortChange("high");
    }
    this.currentModel = model;
    this.refreshModelPill();
    this.callbacks.onModelChange(model);
  }

  private toggleEffortPopup() {
    if (this.openPopup) {
      const wasEffort = this.openPopup.el.classList.contains("claudian-popup-effort");
      this.closePopup();
      if (wasEffort) return;
    }
    const popup = this.createPopup("claudian-popup-effort");
    for (const key of effortLevelsForModel(this.currentModel)) {
      const row = popup.createDiv({
        cls: "claudian-popup-row" + (key === this.currentEffort ? " is-selected" : ""),
        text: EFFORT_LABELS[key],
      });
      row.addEventListener("click", e => {
        e.stopPropagation();
        this.currentEffort = key;
        this.refreshEffortPill();
        this.callbacks.onEffortChange(key);
        this.closePopup();
      });
    }
    this.anchorPopup(popup, this.effortPill);
  }

  /* Attach popup — anchored to the + button. Mirrors the
     model/effort/mode popup pattern but carries two sections:
       1) "Pick a file…" row that fires the OS file picker (current
          behavior of the bare + button, preserved here).
       2) Trusted folders list with per-row checkboxes that toggle
          Read/Glob/Grep allowlist patterns for that absolute path,
          plus an "Add folder…" row that surfaces the OS directory
          chooser. The list persists across sessions in plugin settings.

     Toggling the same + click again closes the popup (true toggle, same
     contract as the toolbar pills). */
  private toggleAttachPopup() {
    if (this.openPopup) {
      const wasAttach = this.openPopup.el.classList.contains("claudian-popup-attach");
      this.closePopup();
      if (wasAttach) return;
    }
    this.openAttachPopup();
  }

  private openAttachPopup() {
    if (this.openPopup) this.closePopup();
    const popup = this.createPopup("claudian-popup-attach");

    /* "Pick a file…" — first row so it stays the keyboard-default action
       and dominates muscle memory for users who just want what + used to
       do. Routes through the same hiddenFileInput / addFiles pipeline as
       Finder drops. */
    const pickRow = popup.createDiv({ cls: "claudian-popup-row claudian-popup-row-action" });
    const pickIcon = pickRow.createSpan({ cls: "claudian-popup-row-icon" });
    platform.setIcon(pickIcon, "folder-open");
    pickRow.createSpan({ cls: "claudian-popup-row-label", text: "Pick a file…" });
    pickRow.addEventListener("click", e => {
      e.stopPropagation();
      this.closePopup();
      this.openFilePicker();
    });

    /* Trusted folders section — only renders when the parent wired the
       list callback. Without onListTrustedFolders, the popup degrades
       gracefully to "Pick a file…" alone. */
    const list = this.callbacks.onListTrustedFolders?.() ?? null;
    if (list !== null) {
      popup.createDiv({ cls: "claudian-popup-divider" });
      popup.createDiv({ cls: "claudian-popup-section-header", text: "Trusted folders" });

      if (list.length === 0) {
        popup.createDiv({
          cls: "claudian-popup-section-empty",
          text: "None yet — add a folder below to let Claude read it on demand.",
        });
      } else {
        for (const folder of list) {
          this.renderTrustedFolderRow(popup, folder);
        }
      }

      const addRow = popup.createDiv({ cls: "claudian-popup-row claudian-popup-row-action" });
      const addIcon = addRow.createSpan({ cls: "claudian-popup-row-icon" });
      platform.setIcon(addIcon, "plus");
      addRow.createSpan({ cls: "claudian-popup-row-label", text: "Add folder…" });
      addRow.addEventListener("click", e => {
        e.stopPropagation();
        this.hiddenDirInput.click();
      });
    }

    this.anchorPopup(popup, this.attachBtn);
  }

  /* One row per trusted folder. Checkbox toggles enabled/disabled (which in
     turn writes/removes the permission patterns). The label shows the
     folder's basename for scannability; the full absolute path lives in the
     row's title attribute and as the secondary line under the basename when
     space allows. Trash button removes the entry entirely. */
  private renderTrustedFolderRow(popup: HTMLElement, folder: TrustedFolder) {
    const row = popup.createDiv({
      cls: "claudian-popup-row claudian-popup-row-folder" + (folder.enabled ? " is-enabled" : ""),
    });
    row.setAttr("title", folder.path);

    const checkbox = row.createEl("input", {
      cls: "claudian-popup-row-checkbox",
      attr: { type: "checkbox" },
    });
    checkbox.checked = folder.enabled;
    checkbox.addEventListener("click", e => e.stopPropagation());
    checkbox.addEventListener("change", () => {
      this.callbacks.onToggleTrustedFolder?.(folder.path, checkbox.checked);
      row.toggleClass("is-enabled", checkbox.checked);
    });

    const labels = row.createDiv({ cls: "claudian-popup-row-labels" });
    const basename = folder.path.split("/").filter(Boolean).pop() ?? folder.path;
    labels.createSpan({ cls: "claudian-popup-row-label", text: basename });
    labels.createSpan({ cls: "claudian-popup-row-sublabel", text: folder.path });

    const removeBtn = row.createSpan({
      cls: "claudian-popup-row-remove",
      attr: { "aria-label": "Remove folder", title: "Remove from trusted folders" },
    });
    platform.setIcon(removeBtn, "x");
    removeBtn.addEventListener("click", e => {
      e.stopPropagation();
      this.callbacks.onRemoveTrustedFolder?.(folder.path);
      row.remove();
    });
  }

  /* Publish, as a CSS custom property on the popup, how much room actually
     exists between its bottom anchor and the top of the nearest CLIPPING
     ancestor (.claudian-tab-content-container is `overflow: hidden`).

     Every popup here grows upward from a bottom anchor, so a tall one runs
     under the header / tab bar and gets cut off with no way to scroll to the
     hidden rows. On a phone that is the common case rather than the edge one:
     the model list alone is taller than the space above the composer, and its
     first entry ends up under the tab bar where a tap hits a tab badge.

     Only a custom property is written, never a max-height, because the
     desktop stylesheet does not reference the variable — the plugin's popups
     keep behaving exactly as before, and ios.css turns the value into a
     max-height plus a scroll region. */
  private publishPopupHeadroom(popup: HTMLElement, anchorTop: number, availWidth?: number) {
    const clip = this.wrapper.closest(".claudian-tab-content-container");
    const clipTop = clip ? clip.getBoundingClientRect().top : 0;
    /* 8px keeps the popup off the clip edge; the 160px floor stops it
       collapsing to nothing in a very short viewport. */
    const available = Math.max(160, Math.round(anchorTop - clipTop - 8));
    popup.style.setProperty("--claudian-popup-avail", `${available}px`);
    /* Same idea horizontally: a popup wider than the gap between its pinned
       edge and the far side of the screen hangs off it. The attach popup's
       280px minimum does exactly that when pinned to the + button. */
    if (availWidth !== undefined) {
      popup.style.setProperty("--claudian-popup-avail-width", `${Math.max(160, Math.round(availWidth))}px`);
    }
  }

  private createPopup(extraClass: string): HTMLElement {
    const popup = this.wrapper.createDiv({ cls: `claudian-popup ${extraClass}` });
    /* Stop clicks inside the popup from being treated as "outside" clicks. */
    popup.addEventListener("click", e => e.stopPropagation());
    return popup;
  }

  /* Position the popup so it sits just above its trigger, growing upward.
     The vertical anchor is `wrapperBottom - triggerTop`, which places the
     popup's bottom edge 4px above the trigger's top:
       - For TOP-row triggers (mode/model), that puts the popup above the
         wrapper itself, floating into the chat scroll area.
       - For BOTTOM-row triggers (effort), it puts the popup just above the
         effort button, overlapping the textarea — close to the click target
         like a normal dropdown rather than floating against the chat.

     Horizontal anchor flips based on which half of the wrapper the trigger
     sits in: triggers in the left half pin the popup's LEFT edge to the
     trigger's left; triggers in the right half pin the popup's RIGHT edge
     to the trigger's right. Without this flip the model pill (top-right)
     extends rightward off-screen. */
  private anchorPopup(popup: HTMLElement, trigger: HTMLElement) {
    const triggerRect = trigger.getBoundingClientRect();
    const wrapperRect = this.wrapper.getBoundingClientRect();
    popup.style.position = "absolute";

    const wrapperMidX = (wrapperRect.left + wrapperRect.right) / 2;
    const triggerMidX = (triggerRect.left + triggerRect.right) / 2;
    const pinRight = triggerMidX > wrapperMidX;
    if (pinRight) {
      popup.style.right = `${wrapperRect.right - triggerRect.right}px`;
      popup.style.left = "";
    } else {
      popup.style.left = `${triggerRect.left - wrapperRect.left}px`;
      popup.style.right = "";
    }

    popup.style.bottom = `${wrapperRect.bottom - triggerRect.top + 4}px`;
    popup.style.top = "";
    this.publishPopupHeadroom(
      popup,
      triggerRect.top,
      pinRight ? triggerRect.right - 8 : window.innerWidth - triggerRect.left - 8,
    );

    /* outsideHandler closes the popup when the user clicks anywhere else
       on the page — EXCEPT on a toolbar pill or the attach + button, which
       have their own click handlers that run after this one. Letting those
       clicks bubble through without closing here keeps the toggle behavior
       correct:
         - Click the SAME trigger again → its toggle handler sees openPopup
           still set and closes it (true toggle).
         - Click a DIFFERENT trigger → its toggle handler closes this popup
           and opens the new one in one frame.
       Without the skip, the mousedown here would close the popup BEFORE
       the trigger's click handler runs, and the click handler would then
       see openPopup as null and pop the same popup right back open. */
    const outsideHandler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popup.contains(target)) return;
      const el = e.target as HTMLElement;
      if (el && typeof el.closest === "function" && el.closest(".claudian-toolbar-pill, .claudian-attach-button")) return;
      this.closePopup();
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") this.closePopup();
    };
    /* Defer attaching so the click that opened the popup doesn't immediately
       close it via the document listener firing in the same tick. Guard the
       deferred attach: if the box was destroyed or a different popup opened
       during this tick, closePopup already ran (for this popup or the one that
       replaced it) and these handlers would leak on document with nothing left
       to remove them. */
    this.openPopup = { el: popup, outsideHandler, keyHandler };
    window.setTimeout(() => {
      if (this.destroyed || this.openPopup?.el !== popup) return;
      document.addEventListener("mousedown", outsideHandler);
      document.addEventListener("keydown", keyHandler);
    }, 0);
  }

  private closePopup() {
    if (!this.openPopup) return;
    document.removeEventListener("mousedown", this.openPopup.outsideHandler);
    document.removeEventListener("keydown", this.openPopup.keyHandler);
    this.openPopup.el.remove();
    this.openPopup = null;
  }

  private handleKeydown(e: KeyboardEvent) {
    /* When the suggestion popup is open, arrow keys + Enter/Tab navigate it.
       Esc closes it. Everything else falls through to normal typing. */
    if (this.suggestion) {
      /* Mid-IME-composition, ArrowUp/Down move the IME candidate window and Esc
         dismisses it — those keystrokes belong to the IME, not the popup. The
         Enter/Tab branch below already guards on isComposing; do the same for
         the whole block so a CJK/accent composition isn't hijacked. */
      if (e.isComposing) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.moveSuggestion(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this.moveSuggestion(-1);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (e.isComposing) return;
        e.preventDefault();
        e.stopPropagation();
        this.acceptSuggestion();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        this.hideSuggestion();
        return;
      }
    }

    /* Esc while Claude is streaming = cancel the current turn. Only fires
       when busy so a stray Esc on an idle input doesn't fire a no-op.
       During IME composition Escape is the user dismissing the candidate
       window — never an interrupt request — so bail before we'd otherwise
       kill the turn behind their back. */
    if (e.key === "Escape" && this.busy) {
      if (e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      this.callbacks.onCancel();
      return;
    }

    /* Shift+Tab cycles through permission modes — matches the Claude Code
       terminal's Normal → Accept Edits → Plan → Auto → Bypass cycle.
       stopPropagation prevents Obsidian's focus-cycling from stealing the key. */
    if (e.key === "Tab" && e.shiftKey && !e.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      this.cyclePermissionMode();
      return;
    }
    if (e.key !== "Enter") return;
    if (e.isComposing) return;
    if (e.shiftKey) return;
    /* On a touch host there is no Shift key riding along with the software
       keyboard's return key, so "Enter submits, Shift+Enter newlines" — the
       desktop convention this handler otherwise implements — would make
       every return keystroke send the message, with no way to type a second
       line short of pasting one in. Phones instead get the opposite default,
       matching every other iOS chat app: return inserts a newline (the
       textarea's native behavior, so nothing here needs to run) and the send
       button in the toolbar is the only way to submit. */
    if (TOUCH_PRIMARY) return;
    e.preventDefault();
    e.stopPropagation();
    this.submit();
  }

  /* Scan the text up to the cursor for an active `@` or `/` trigger and show
     the matching suggestion popup, or hide if no trigger is active. */
  private updateSuggestion() {
    const cursor = this.textarea.selectionStart ?? 0;
    const before = this.textarea.value.slice(0, cursor);

    /* `@` trigger: preceded by start-of-text or whitespace, followed by chars
       that could plausibly be part of a vault path (alphanumerics, `_.-/`).
       Restricted from `[^\s@]*` to avoid firing on things like email handles
       (`user@host.com`) or other non-path tokens, and to cut down on stray
       vault-index lookups for queries that can never resolve. */
    const atMatch = before.match(/(?:^|\s)@([A-Za-z0-9_.\-\/]*)$/);
    if (atMatch) {
      const query = atMatch[1];
      const triggerStart = cursor - query.length - 1;  // index of "@"
      const items = this.callbacks.onMentionQuery(query);
      this.showSuggestion("@", triggerStart, items);
      return;
    }

    /* `/` trigger: only at the very start of the textarea (slash commands
       are first-token). */
    const slashMatch = before.match(/^\/([\w-]*)$/);
    if (slashMatch) {
      const query = slashMatch[1];
      const items = this.callbacks.onSlashQuery(query);
      this.showSuggestion("/", 0, items);
      return;
    }

    this.hideSuggestion();
  }

  private showSuggestion(trigger: "@" | "/", triggerStart: number, items: Suggestion[]) {
    if (items.length === 0) {
      this.hideSuggestion();
      return;
    }
    /* If we already have an open popup of the same trigger, just update items
       in place — avoids tearing down and rebuilding on each keystroke. */
    if (this.suggestion && this.suggestion.trigger === trigger) {
      this.suggestion.triggerStart = triggerStart;
      this.suggestion.items = items;
      this.suggestion.activeIndex = Math.min(this.suggestion.activeIndex, items.length - 1);
      this.renderSuggestionRows();
      return;
    }
    this.hideSuggestion();
    const el = this.wrapper.createDiv({ cls: `claudian-suggestion-popup claudian-suggestion-${trigger === "@" ? "mention" : "slash"}` });
    this.suggestion = { el, trigger, triggerStart, items, activeIndex: 0, rows: [], renderedActiveIndex: -1 };
    this.renderSuggestionRows();
  }

  private renderSuggestionRows() {
    if (!this.suggestion) return;
    const { el, items, activeIndex, rows } = this.suggestion;
    /* The @ / slash list is CSS-anchored to the wrapper's top edge and grows
       upward, so it needs the same headroom hint as the click-driven popups.
       Recomputed on every render because the wrapper moves as the textarea
       grows. */
    this.publishPopupHeadroom(el, this.wrapper.getBoundingClientRect().top);
    /* Patch existing rows in place by index rather than emptying and
       rebuilding the whole list (and its inline SVG icons) on every
       keystroke. A row's mousedown handler closes over its index, not its
       item, and acceptSuggestion() always reads `items[activeIndex]` fresh —
       so a row reused at the same index stays correct even once the item
       behind it has changed; only its label/icon content needs refreshing,
       and only when the item id at that index actually changed. */
    items.forEach((item, i) => {
      let row = rows[i];
      if (!row) {
        row = el.createDiv({ cls: "claudian-suggestion-row" });
        /* mousedown not click — by the time click fires the textarea's blur
           handler has already torn down the popup. Bound once at creation;
           never rebound on reuse (see comment above). */
        row.addEventListener("mousedown", e => {
          e.preventDefault();
          if (!this.suggestion) return;
          this.suggestion.activeIndex = i;
          this.acceptSuggestion();
        });
        rows[i] = row;
      }
      if (row.dataset.suggestionId !== item.id) {
        row.dataset.suggestionId = item.id;
        row.empty();
        if (item.icon) {
          const iconEl = row.createSpan({ cls: "claudian-suggestion-icon" });
          platform.setIcon(iconEl, item.icon);
        }
        const labels = row.createDiv({ cls: "claudian-suggestion-labels" });
        labels.createDiv({ cls: "claudian-suggestion-primary", text: item.primary });
        if (item.secondary) {
          labels.createDiv({ cls: "claudian-suggestion-secondary", text: item.secondary });
        }
      }
      row.toggleClass("is-active", i === activeIndex);
    });
    /* Drop any leftover rows from a longer previous list. */
    for (let i = items.length; i < rows.length; i++) {
      rows[i].remove();
    }
    rows.length = items.length;

    /* Keep the active row visible when the user arrow-keys past the fold.
       `nearest` block avoids jumpiness when the row is already on-screen.
       Gated on the active index having actually moved since the last
       render, so a same-index re-render triggered by typing doesn't force
       a scroll (and the forced layout that comes with it). */
    if (activeIndex !== this.suggestion.renderedActiveIndex) {
      this.suggestion.renderedActiveIndex = activeIndex;
      rows[activeIndex]?.scrollIntoView({ block: "nearest" });
    }
  }

  private moveSuggestion(delta: number) {
    if (!this.suggestion) return;
    const { rows, items } = this.suggestion;
    const len = items.length;
    const prevIndex = this.suggestion.activeIndex;
    const nextIndex = (prevIndex + delta + len) % len;
    this.suggestion.activeIndex = nextIndex;
    this.suggestion.renderedActiveIndex = nextIndex;
    /* Swap the highlight directly instead of routing through
       renderSuggestionRows(): only which row carries `is-active` changed
       here, so rebuilding rows or republishing popup headroom (no geometry
       moved) on every held-down arrow-key repeat would be wasted work.
       Mirrors DomSuggestModalHost.setSelection's handling of the sibling
       desktop suggest overlay (src/platform/dom/desktop-overlays.ts). */
    rows[prevIndex]?.removeClass("is-active");
    rows[nextIndex]?.addClass("is-active");
    rows[nextIndex]?.scrollIntoView({ block: "nearest" });
  }

  private acceptSuggestion() {
    if (!this.suggestion) return;
    const item = this.suggestion.items[this.suggestion.activeIndex];
    if (!item) return;
    /* Folders are sideloaded into the pinned-pill bar rather than typed into
       the textarea. We still strip the `@query` fragment the user typed
       (otherwise it lingers as orphaned text) but the pill bar becomes the
       canonical reference. If the caller didn't wire onPinFolder we fall
       through to plain text insertion so the popup remains useful. */
    if (item.kind === "folder" && this.callbacks.onPinFolder) {
      const cursor = this.textarea.selectionStart ?? this.textarea.value.length;
      const before = this.textarea.value.slice(0, this.suggestion.triggerStart);
      const after = this.textarea.value.slice(cursor);
      this.textarea.value = before + after;
      this.textarea.selectionStart = this.textarea.selectionEnd = before.length;
      this.callbacks.onPinFolder(item.id);
      this.hideSuggestion();
      this.autoResize();
      this.textarea.focus();
      return;
    }
    const cursor = this.textarea.selectionStart ?? this.textarea.value.length;
    const before = this.textarea.value.slice(0, this.suggestion.triggerStart);
    const after = this.textarea.value.slice(cursor);
    const insert = item.insert + " ";
    this.textarea.value = before + insert + after;
    const newCursor = before.length + insert.length;
    this.textarea.selectionStart = this.textarea.selectionEnd = newCursor;
    this.hideSuggestion();
    this.autoResize();
    this.textarea.focus();
  }

  private hideSuggestion() {
    if (!this.suggestion) return;
    this.suggestion.el.remove();
    this.suggestion = null;
  }

  private async handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageItems = Array.from(items).filter(it => it.kind === "file" && it.type.startsWith("image/"));
    if (imageItems.length === 0) return;
    /* Many sources (screenshot tools, browsers copying images with alt text,
       rich editors) populate the clipboard with BOTH a text payload and an
       image. Previous behavior preventDefault()'d unconditionally on image
       presence, silently dropping the text. Instead: only preventDefault when
       the clipboard is image-only. When text is also present, let the browser
       handle the text paste normally and process the image asynchronously into
       the attachment list (Blob.arrayBuffer() is async, so the text paste
       lands first regardless). */
    const hasText = Array.from(items).some(it => it.kind === "string" && it.type === "text/plain");
    if (!hasText) e.preventDefault();
    /* Materialize every File synchronously BEFORE the first await: once the
       paste handler yields, the clipboard's data store is disabled and
       getAsFile() returns null for the remaining items — pasting multiple
       images would silently keep only the first. */
    const files = imageItems
      .map(it => it.getAsFile())
      .filter((f): f is File => f !== null);
    /* Snapshot the array identity so a submit() that lands mid-decode (which
       rebinds this.attachments to a fresh array for the next message) doesn't
       cause the decoded image to ride on the next turn. */
    const target = this.attachments;
    for (const file of files) {
      /* Same cap addFiles enforces for the picker/drop paths. Without it a
         huge pasted image base64-inflates into one stream-json stdin line
         and the turn fails at the CLI/API layer with an opaque error. */
      if (file.size > MAX_ATTACHMENT_BYTES) {
        platform.notify(`Pasted image is too large (max 10MB)`);
        continue;
      }
      /* Avoid FileReader: in some Obsidian/Electron renderer configurations
         the FileReader instance is missing readAsDataURL, which silently
         broke image paste. Blob.arrayBuffer() works universally. */
      try {
        const buf = await file.arrayBuffer();
        if (this.destroyed || this.attachments !== target) return;
        const data = bytesToBase64(new Uint8Array(buf));
        this.attachments.push({ kind: "image", mediaType: file.type, data });
        this.renderAttachmentChips();
      } catch (err) {
        console.error("claude-cli-chat: failed to read pasted image", err);
      }
    }
  }

  private handleDrop(e: DragEvent) {
    const dt = e.dataTransfer;
    if (!dt) return;
    /* Always swallow the drop if dataTransfer carries anything — without
       this Electron may navigate to a dropped file:// URL or open it in a
       new window. Matches the dragover preventDefault gate. We also swallow
       when an Obsidian vault drag is active (which leaves dt.types empty). */
    const vaultDrag = this.callbacks.onIsVaultDragActive?.() ?? false;
    if (dt.types?.length || vaultDrag) e.preventDefault();
    /* Finder drops carry File objects on dt.files. Take that path first.
       Falls through to the text/plain branch only when no files were
       dropped — that branch still handles vault file drag-ins (which arrive
       as a path string) and editor selection drops. */
    const files = Array.from(dt.files ?? []);
    if (files.length > 0) {
      void this.addFiles(files);
      return;
    }
    /* Obsidian internal drags (file explorer): the TFile/TFolder lives on
       app.dragManager.draggable, not on the dataTransfer. Ask the parent
       to consume the drop from there before falling through to text/plain
       (which Obsidian sometimes populates with a wikilink, sometimes not). */
    if (this.callbacks.onTryConsumeVaultDrag?.()) return;
    const text = dt.getData("text/plain");
    if (!text) return;
    /* Obsidian drags whose payload never reaches dragManager.draggable's
       file/files fields (note links dragged from an editor, search results,
       backlinks, bookmarks, tab headers) still put obsidian://open URLs on
       text/plain — one per line for multi-select. Pin every one that
       resolves; swallow the drop if any did so a raw URL never lands in the
       textarea. */
    const urlPaths = extractObsidianUrlPaths(text);
    if (urlPaths.length > 0) {
      let pinnedAny = false;
      for (const p of urlPaths) {
        if (this.callbacks.onTryPinVaultPath?.(p)) pinnedAny = true;
      }
      if (pinnedAny) return;
    }
    /* Obsidian's file explorer puts the vault-relative path on text/plain
       when you drag a note or folder. Strip wikilink wrappers and alias
       suffixes so [[Foo|Bar]] resolves the same as a bare Foo path. If the
       result resolves to a vault item, route through the pin callback —
       the pill bar handles file-vs-folder styling via its own vault lookup.
       Anything else (external app text, multi-line, unresolved path) falls
       through to the original cursor-insert behavior. */
    const candidate = extractVaultPathCandidate(text);
    if (candidate && this.callbacks.onTryPinVaultPath?.(candidate)) return;
    const sel = this.textarea.selectionStart ?? this.textarea.value.length;
    const prevChar = this.textarea.value.charAt(sel - 1);
    const needsSpace = sel > 0 && prevChar && !/\s/.test(prevChar);
    this.insertAtCursor((needsSpace ? " " : "") + text + " ");
  }

  private openFilePicker() {
    this.hiddenFileInput.click();
  }

  /* Public entry for OS-file drops landing OUTSIDE the input wrapper (the
     TabController's whole-tab drop zone). Routes through the same addFiles
     pipeline as the + button and wrapper drops. */
  ingestDroppedFiles(files: File[]) {
    if (files.length > 0) void this.addFiles(files);
  }

  /* Public entry for images that already arrive pre-encoded as data: URIs —
     today only the iOS Share Extension (ShareInbox.swift's payload, routed
     through `ios-web/src/shell.ts`'s `share` dispatch handler), which has
     already downscaled and JPEG-encoded on the native side, so there is
     nothing left to read off disk or a clipboard. Distinct from
     addFiles/handlePaste (File-object driven, needs an ArrayBuffer read):
     this just strips the `data:...;base64,` prefix and pushes straight onto
     the same `attachments` array, so the resulting chip and the outgoing
     ImageBlock are identical to any other attachment path. Synchronous (no
     File/Blob decode step), so — unlike addFiles/handlePaste — there is no
     mid-decode submit() race to guard against with an array-identity
     snapshot. */
  addImageAttachments(items: { mediaType: string; dataUri: string }[]): void {
    if (this.destroyed || items.length === 0) return;
    let added = 0;
    for (const item of items) {
      const data = item.dataUri.replace(/^data:[^,]*,/, "");
      if (!data) continue;
      /* Base64 inflates 3 bytes to 4 chars; estimate decoded size without
         actually decoding, same cap addFiles/handlePaste enforce so a huge
         shared image can't blow up the stream-json stdin line either. */
      if (data.length * 0.75 > MAX_ATTACHMENT_BYTES) {
        platform.notify(`Shared image is too large (max 10MB)`);
        continue;
      }
      this.attachments.push({ kind: "image", mediaType: item.mediaType, data });
      added += 1;
    }
    if (added > 0) this.renderAttachmentChips();
  }

  /* Shared ingest path for both the + button and Finder drops. Decides per
     file whether it rides as an image block, a PDF document block, or as
     inlined text. Anything that fails the size cap or can't be decoded
     surfaces a Notice and is skipped so one bad file doesn't abort the rest. */
  private async addFiles(files: File[]) {
    /* Snapshot the array identity so a submit() that lands mid-decode (which
       rebinds this.attachments to a fresh array for the next message) doesn't
       cause the decoded file to ride on the next turn. */
    const target = this.attachments;
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        platform.notify(`${file.name} is too large (max 10MB)`);
        continue;
      }
      try {
        const att = await this.fileToAttachment(file);
        if (this.destroyed || this.attachments !== target) return;
        this.attachments.push(att);
      } catch (err) {
        console.error("claude-cli-chat: failed to attach file", file.name, err);
        const msg = err instanceof Error ? err.message : String(err);
        platform.notify(`Couldn't attach ${file.name}: ${msg}`);
      }
    }
    if (this.destroyed) return;
    this.renderAttachmentChips();
  }

  private async fileToAttachment(file: File): Promise<Attachment> {
    const mime = file.type || guessMimeFromName(file.name);
    if (mime.startsWith("image/")) {
      const buf = await file.arrayBuffer();
      return {
        kind: "image",
        mediaType: mime,
        data: bytesToBase64(new Uint8Array(buf)),
        filename: file.name,
      };
    }
    if (mime === "application/pdf") {
      const buf = await file.arrayBuffer();
      return {
        kind: "pdf",
        mediaType: "application/pdf",
        data: bytesToBase64(new Uint8Array(buf)),
        filename: file.name,
      };
    }
    /* Everything else is best-effort text. Binaries will look like noise to
       Claude but won't crash the pipeline — the user explicitly chose this
       file, so we let them try rather than silently rejecting. */
    const content = await file.text();
    return {
      kind: "text",
      mediaType: mime || "text/plain",
      content,
      filename: file.name,
    };
  }

  /* Push the active editor selection into the input as a pinned chip.
     `null` clears the chip. Selection text and line range are remembered
     across keystrokes so the user can type a question without it dropping. */
  setSelection(selection: ActiveSelection | null) {
    this.currentSelection = selection;
    this.renderContextRow();
  }

  getSelection(): ActiveSelection | null { return this.currentSelection; }

  /* Renders both the editor-selection chip (if any) and the attachment
     chips. Single entry point so the row's visual state always matches what
     the user is actually carrying. */
  private renderContextRow() {
    this.contextRow.empty();
    const hasAny = this.attachments.length > 0 || this.currentSelection !== null;
    this.contextRow.toggleClass("has-content", hasAny);

    if (this.currentSelection) {
      const sel = this.currentSelection;
      const chip = this.contextRow.createDiv({ cls: "claudian-context-chip claudian-context-chip-selection" });
      const iconEl = chip.createSpan({ cls: "claudian-context-chip-icon" });
      platform.setIcon(iconEl, "text-cursor");
      const fileName = sel.filePath.split("/").pop() ?? sel.filePath;
      const rangeLabel = sel.startLine === sel.endLine
        ? `line ${sel.startLine}`
        : `lines ${sel.startLine}–${sel.endLine}`;
      chip.createSpan({
        cls: "claudian-context-chip-label",
        text: `${fileName} · ${rangeLabel}`,
        attr: { title: sel.filePath },
      });
      const remove = chip.createSpan({
        cls: "claudian-context-chip-remove",
        attr: { "aria-label": "Detach selection", title: "Detach selection" },
      });
      platform.setIcon(remove, "x");
      remove.addEventListener("click", e => {
        e.stopPropagation();
        this.currentSelection = null;
        this.renderContextRow();
        /* Notify the caller so SelectionTracker can be cleared in lockstep.
           Without this, the next refresh() in SelectionTracker re-emits the
           same selection and the chip pops back into view. See
           InputBoxCallbacks.onSelectionDismissed for the contract. */
        this.callbacks.onSelectionDismissed?.();
      });
    }

    this.attachments.forEach((att, i) => {
      const chip = this.contextRow.createDiv({ cls: "claudian-context-chip" });
      const iconEl = chip.createSpan({ cls: "claudian-context-chip-icon" });
      const kind = att.kind ?? "image";
      let iconName: string;
      let label: string;
      if (kind === "image") {
        iconName = "image";
        if (att.filename) label = att.filename;
        else {
          const subtype = att.mediaType.split("/")[1] || "image";
          label = `${subtype.toUpperCase()} attachment`;
        }
      } else if (kind === "pdf") {
        iconName = "file-text";
        label = att.filename ?? "document.pdf";
      } else {
        iconName = "file";
        label = att.filename ?? "text file";
      }
      platform.setIcon(iconEl, iconName);
      chip.createSpan({
        cls: "claudian-context-chip-label",
        text: label,
        attr: att.filename ? { title: att.filename } : {},
      });
      const remove = chip.createSpan({ cls: "claudian-context-chip-remove", attr: { "aria-label": "Remove", title: "Remove" } });
      platform.setIcon(remove, "x");
      remove.addEventListener("click", e => {
        e.stopPropagation();
        this.attachments.splice(i, 1);
        this.renderContextRow();
      });
    });
  }

  /* Back-compat shim — earlier callers still reference renderAttachmentChips.
     Both attachments and selection chips render through renderContextRow now. */
  private renderAttachmentChips() {
    this.renderContextRow();
  }

  private submit() {
    if (this.busy) return;
    const text = this.textarea.value.trim();
    if (!text && this.attachments.length === 0 && !this.currentSelection) return;
    this.textarea.value = "";
    this.autoResize();
    /* A successful submit definitively ends this draft. Cancel any pending
       debounce (it would otherwise republish the just-cleared text a moment
       later) and publish the clear immediately rather than waiting. */
    if (this.draftDebounceTimer !== null) {
      window.clearTimeout(this.draftDebounceTimer);
      this.draftDebounceTimer = null;
    }
    if (this.lastPublishedDraft !== "") {
      this.lastPublishedDraft = "";
      this.callbacks.onDraftChange?.("");
    }
    const attachments = this.attachments;
    const selection = this.currentSelection ?? undefined;
    this.attachments = [];
    this.currentSelection = null;
    this.renderContextRow();
    this.callbacks.onSubmit({ text, attachments, selection });
  }

  /* Debounce the composer's current text out to onDraftChange. Called on
     every `input` event; the 500ms window means a burst of keystrokes yields
     one call after typing pauses rather than one per character. */
  private scheduleDraftPublish(): void {
    if (this.draftDebounceTimer !== null) window.clearTimeout(this.draftDebounceTimer);
    this.draftDebounceTimer = window.setTimeout(() => {
      this.draftDebounceTimer = null;
      this.publishDraft();
    }, 500);
  }

  private publishDraft(): void {
    if (this.destroyed) return;
    const value = this.textarea.value;
    if (value === this.lastPublishedDraft) return;
    this.lastPublishedDraft = value;
    this.callbacks.onDraftChange?.(value);
  }

  /* Force any pending debounced draft out right now, bypassing the 500ms
     window. Called on blur, visibilitychange (backgrounding), and
     TabController.hide() (switching to another tab) — the moments a
     relaunch or an iOS background-kill can follow before the debounce would
     otherwise have fired. Public so TabController can call it from hide(). */
  public flushDraft(): void {
    if (this.draftDebounceTimer !== null) {
      window.clearTimeout(this.draftDebounceTimer);
      this.draftDebounceTimer = null;
    }
    this.publishDraft();
  }

  /* Wipe the composer for a `/clear` or the header's "New chat" reset.
     Cancels any pending debounce and resets the textarea; does NOT call
     onDraftChange — TabController.clear() already owns state.draft directly
     for this path and persists the clear itself via its own
     onStateChangeCb() call. */
  public clearDraftUi(): void {
    if (this.draftDebounceTimer !== null) {
      window.clearTimeout(this.draftDebounceTimer);
      this.draftDebounceTimer = null;
    }
    this.lastPublishedDraft = "";
    this.textarea.value = "";
    this.autoResize();
  }

  private autoResize() {
    this.textarea.style.height = "auto";
    const max = Math.floor(window.innerHeight * 0.45);
    /* Add a 4px buffer so the last wrapped line's descenders (j, g, y, p)
       have room to clear the textarea's bottom padding. Browsers' textarea
       scrollHeight is computed against line-height alone — it ignores the
       extra pixels glyph descenders need below the baseline. Capped
       against max (45% of viewport) so a very long message still scrolls. */
    const desired = this.textarea.scrollHeight + 4;
    const newHeight = Math.min(desired, max);
    this.textarea.style.height = newHeight + "px";
    /* Always anchor scroll to the bottom. Two reasons:
       1. Browsers' textarea scrollHeight can be a few pixels short of
          what's actually needed (descender-clip bug). Pinning scrollTop
          to scrollHeight pushes the last line to the bottom of the
          content area, where the padding-bottom of the textarea frame
          is always visually present below it — so the gap survives even
          when our height calculation is a hair too small.
       2. The user is typing at the end of text in a chat composer, so
          the caret is at the bottom anyway — keeping the textarea
          scrolled to the bottom matches caret position. */
    this.textarea.scrollTop = this.textarea.scrollHeight;
  }
}
