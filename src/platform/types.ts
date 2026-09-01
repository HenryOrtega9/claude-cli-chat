/* Platform abstraction layer — capability interfaces.

   Goal: shared code (everything outside main.ts / ClaudeChatView /
   ActiveFileIndicator / SelectionTracker / SnippetPicker / the settings-tab
   UI) must compile and run with ZERO imports from the `obsidian` package, so
   the same source can later power a standalone Electron shell. Every Obsidian
   API a shared file touches is expressed here as a capability on the
   `Platform` interface; the Obsidian implementation lives in ./obsidian.ts
   (the ONLY platform file allowed to import obsidian) and is installed once
   at plugin load via initializePlatform() in ./registry.ts.

   Invariants:
   - This file imports NOTHING. Not obsidian, not node builtins, not other
     src modules. It is pure types plus the shapes they reference.
   - Method shapes mirror the exact call sites cataloged in MIGRATION.md, so
     a migration is a mechanical rewrite (`new Notice(x)` ->
     `platform.notify(x)`), never a behavior change.
   - Anything inherently vault-specific (file tree queries, wikilink
     resolution, opening notes, Obsidian's drag manager) is quarantined on
     the OPTIONAL `vaultFeatures` capability so a desktop shell can omit it
     and the UI feature-flags off. */

/* Opaque stand-in for `obsidian.App` in constructor signatures that must not
   change (MCPConfigStore, Persistence, extractOfficeText, the modals, ...).
   Migrated files keep their `app` parameter but retype it to AppHandle; the
   value is ignored — implementations reach the platform singleton instead.
   `unknown` so every existing call site (`new Persistence(this.app)`) keeps
   compiling without a cast. */
export type AppHandle = unknown;

/* Opaque stand-in for `obsidian.Component` where it is only threaded through
   as a markdown-render lifecycle owner (MessageListRenderer's `component`
   field, renderMarkdown's optional last arg). The Obsidian impl narrows it
   back to Component internally. */
export type RenderLifecycle = unknown;

/* ----- HTTP (wraps obsidian.requestUrl semantics) ---------------------- */

export type HttpRequestOptions = {
  url: string;
  method?: string;
  contentType?: string;
  headers?: Record<string, string>;
  body?: string;
  /* Mirrors requestUrl's `throw` flag: when false, non-2xx responses resolve
     normally instead of rejecting. Defaults to true (requestUrl's default). */
  throwOnError?: boolean;
};

export type HttpResponse = {
  status: number;
  headers: Record<string, string>;
  text: string;
  /* Parsed JSON body when the response parses as JSON; undefined otherwise.
     Never throws for non-JSON bodies. */
  json?: unknown;
};

/* ----- Context menus (wraps obsidian.Menu) ----------------------------- */

export type MenuItemSpec = {
  title: string;
  /* Lucide icon id, same vocabulary as Platform.setIcon. */
  icon?: string;
  onClick: () => void;
};

/* ----- Modals ----------------------------------------------------------
   Shared modal classes cannot extend obsidian.Modal / obsidian.SuggestModal
   directly (that would require the import). Instead they extend the
   PlatformModal / PlatformSuggestModal base classes in ./modals.ts, which
   delegate to a host object created through these factory methods. The host
   surface below is exactly the member set the existing shared modals use:
   open/close, contentEl/titleEl, onOpen/onClose overrides, and for suggest
   modals the getSuggestions/renderSuggestion/onChooseSuggestion cycle plus
   setPlaceholder. (None of the shared modals touch `scope` or register
   their own keyboard handlers — Esc-to-close is the host's own behavior —
   so no keyboard surface is exposed here.) */

export interface ModalDelegate {
  /* May be async (MCPManagerModal / HistoryModal declare `async onOpen`);
     the host fires it fire-and-forget exactly like obsidian.Modal does. */
  onOpen?(): void | Promise<void>;
  onClose?(): void;
}

export interface ModalHost {
  /* Both elements exist from construction time (obsidian.Modal builds its
     DOM in the constructor), so subclass constructors may touch them. */
  readonly contentEl: HTMLElement;
  readonly titleEl: HTMLElement;
  open(): void;
  close(): void;
}

export interface SuggestModalDelegate<T> {
  getSuggestions(query: string): T[] | Promise<T[]>;
  renderSuggestion(item: T, el: HTMLElement): void;
  onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void;
}

export interface SuggestModalHost {
  setPlaceholder(text: string): void;
  open(): void;
  close(): void;
}

/* ----- File storage (wraps app.vault.adapter / FileSystemAdapter) ------
   All paths are ROOT-RELATIVE (relative to the vault root under Obsidian,
   or to whatever base directory the desktop shell chooses), exactly like
   DataAdapter paths today — e.g. ".claude/mcp.json",
   ".claude-cli-chat/conversations/<id>.json". */

export interface FileStorage {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  readBinary(path: string): Promise<ArrayBuffer>;
  write(path: string, data: string): Promise<void>;
  /* Atomically replaces the destination on POSIX, mirroring
     DataAdapter.rename — writeJsonAtomic's staging protocol depends on it. */
  rename(oldPath: string, newPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  /* Shallow listing; entries are root-relative full paths, mirroring
     DataAdapter.list's ListedFiles shape (Persistence.listConversations
     depends on entries like ".claude-cli-chat/conversations/x.json"). */
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  /* Absolute filesystem path of the storage root, or null when storage is
     not filesystem-backed. Persistence.flushSync uses it for synchronous
     quit-time writes via node fs; a null degrades that path to a no-op,
     exactly like the current non-FileSystemAdapter guard. */
  basePath(): string | null;
}

/* ----- Vault-specific features (OPTIONAL capability) -------------------
   Everything here exists only inside an Obsidian vault: the indexed file
   tree, wikilink resolution, opening notes in workspace leaves, hover
   preview, and the internal drag manager. A desktop shell omits the whole
   object; shared consumers must check `platform.vaultFeatures` and degrade
   (hide the affordance, fall back to plain behavior) when absent. */

export type VaultEntryKind = "file" | "folder";

export type VaultIndexEntry = {
  kind: VaultEntryKind;
  path: string;
  /* Basename for files (without extension), folder name for folders. */
  name: string;
  /* File mtime in epoch ms; 0 for folders (Obsidian doesn't expose folder
     mtime — consumers use 0 to sink folders in recency-ordered lists). */
  mtime: number;
  /* File extension without the dot; "" for folders. */
  ext: string;
};

export interface VaultFeatures {
  /* getAbstractFileByPath + instanceof TFile/TFolder collapsed to a kind.
     null when the path doesn't resolve to a vault item. */
  pathKind(path: string): VaultEntryKind | null;
  /* TFile.stat.mtime for a resolving file path; undefined otherwise. */
  fileMtime(path: string): number | undefined;
  /* Flat snapshot of every file and every folder (vault root excluded),
     mirroring TabController.getMentionIndex's enumeration. Callers memoize;
     invalidation comes from onTreeChange. */
  listIndexEntries(): VaultIndexEntry[];
  /* Fires on structural vault changes (create/delete/rename — content
     "modify" deliberately excluded, matching the mention-index listeners).
     Returns an unsubscribe function; replaces the EventRef/offref pattern. */
  onTreeChange(cb: () => void): () => void;
  /* workspace.getActiveFile()?.path — the wikilink-resolution source path. */
  activeFilePath(): string | null;
  /* metadataCache.getFirstLinkpathDest: resolves "MyNote" (or
     "Note#Section" callers pre-strip) to a vault path, relative to
     sourcePath. Returns the resolved path or null. */
  resolveLink(linktext: string, sourcePath: string): string | null;
  /* workspace.openLinkText with the leaf mode the chat uses. */
  openPath(linktext: string, mode: "tab" | "split"): void;
  /* workspace.trigger("hover-link", ...) so the Page Preview core plugin
     shows its tile. hoverParent is the owning RenderLifecycle (Component). */
  triggerHoverLink(
    event: MouseEvent,
    targetEl: HTMLElement,
    linktext: string,
    hoverParent?: RenderLifecycle,
  ): void;
  /* Obsidian's internal dragManager resolved to vault paths (file drags,
     multi-select drags, and link drags via metadata-cache resolution) —
     ports TabController.readDragManagerPaths. Empty array = no vault drag
     in flight. */
  readDragPaths(): string[];
}

/* ----- The platform ---------------------------------------------------- */

export interface Platform {
  /* new Notice(message, timeoutMs). timeoutMs omitted = host default. */
  notify(message: string, timeoutMs?: number): void;
  /* obsidian.setIcon — clears el and injects the lucide icon (or an id
     registered by the host app, e.g. main.ts's "claude-asterisk"). */
  setIcon(el: HTMLElement, iconId: string): void;
  /* MarkdownRenderer.render(app, markdown, el, sourcePath, component).
     lifecycle is the owning RenderLifecycle; when omitted the impl supplies
     a throwaway one. */
  renderMarkdown(
    markdown: string,
    el: HTMLElement,
    sourcePath: string,
    lifecycle?: RenderLifecycle,
  ): Promise<void>;
  httpRequest(options: HttpRequestOptions): Promise<HttpResponse>;
  /* One-shot context menu at the mouse event's position (Menu +
     showAtMouseEvent). */
  showContextMenu(evt: MouseEvent, items: MenuItemSpec[]): void;
  /* Modal hosts backing PlatformModal / PlatformSuggestModal (./modals.ts).
     Application code should extend those base classes, not call these. */
  createModal(delegate: ModalDelegate): ModalHost;
  createSuggestModal<T>(delegate: SuggestModalDelegate<T>): SuggestModalHost;
  storage: FileStorage;
  /* Absent outside Obsidian — consumers must feature-check. */
  vaultFeatures?: VaultFeatures;
  /* Convert an image Claude's API can't ingest (HEIC/HEIF chiefly) into one
     it can. The node hosts back this with macOS `sips`; absent on iOS, where
     WKWebView decodes HEIC natively so the canvas path in InputBox already
     covers it. null = the host tried and couldn't. */
  transcodeImage?(bytes: Uint8Array, mediaType: string): Promise<{ bytes: Uint8Array; mediaType: string } | null>;
}
