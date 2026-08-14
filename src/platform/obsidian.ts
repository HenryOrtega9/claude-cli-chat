/* Obsidian implementation of the Platform interface.

   The ONLY file under src/platform/ that may import from "obsidian".
   Shared code must never import this module — it reaches the singleton via
   `import { platform } from "../platform"` instead. main.ts constructs one
   ObsidianPlatform (holding the live App) and installs it via
   initializePlatform() as the first statement of onload().

   Every method here is a thin, behavior-preserving delegate: no policy, no
   caching, no error swallowing beyond what the wrapped API already does.
   Anything smarter belongs in the shared caller so both shells share it. */

import {
  App,
  Component,
  FileSystemAdapter,
  MarkdownRenderer,
  Menu,
  Modal,
  Notice,
  requestUrl,
  setIcon,
  SuggestModal,
  TFile,
  TFolder,
} from "obsidian";
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
  VaultEntryKind,
  VaultFeatures,
  VaultIndexEntry,
} from "./types";

/* Real obsidian.Modal whose lifecycle hooks forward to a delegate. Returned
   directly as the ModalHost (Modal already has contentEl/titleEl/open/close),
   so backdrop, Esc handling, and focus behavior are Obsidian's own. */
class ObsidianModalHost extends Modal {
  constructor(app: App, private delegate: ModalDelegate) {
    super(app);
  }
  onOpen(): void {
    /* Fire-and-forget async onOpen, matching how Obsidian treats a subclass
       that declares `async onOpen()`. */
    void this.delegate.onOpen?.();
  }
  onClose(): void {
    this.delegate.onClose?.();
  }
}

class ObsidianSuggestModalHost<T> extends SuggestModal<T> {
  constructor(app: App, private delegate: SuggestModalDelegate<T>) {
    super(app);
  }
  getSuggestions(query: string): T[] | Promise<T[]> {
    return this.delegate.getSuggestions(query);
  }
  renderSuggestion(item: T, el: HTMLElement): void {
    this.delegate.renderSuggestion(item, el);
  }
  onChooseSuggestion(item: T, evt: MouseEvent | KeyboardEvent): void {
    this.delegate.onChooseSuggestion(item, evt);
  }
}

/* app.vault.adapter behind the FileStorage interface. Paths stay
   vault-root-relative end to end — no translation happens here. */
class ObsidianFileStorage implements FileStorage {
  constructor(private app: App) {}

  exists(path: string): Promise<boolean> { return this.app.vault.adapter.exists(path); }
  read(path: string): Promise<string> { return this.app.vault.adapter.read(path); }
  readBinary(path: string): Promise<ArrayBuffer> { return this.app.vault.adapter.readBinary(path); }
  write(path: string, data: string): Promise<void> { return this.app.vault.adapter.write(path, data); }
  rename(oldPath: string, newPath: string): Promise<void> { return this.app.vault.adapter.rename(oldPath, newPath); }
  remove(path: string): Promise<void> { return this.app.vault.adapter.remove(path); }
  mkdir(path: string): Promise<void> { return this.app.vault.adapter.mkdir(path); }
  list(path: string): Promise<{ files: string[]; folders: string[] }> { return this.app.vault.adapter.list(path); }

  basePath(): string | null {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
  }
}

class ObsidianVaultFeatures implements VaultFeatures {
  constructor(private app: App) {}

  pathKind(path: string): VaultEntryKind | null {
    const node = this.app.vault.getAbstractFileByPath(path);
    if (node instanceof TFile) return "file";
    if (node instanceof TFolder) return "folder";
    return null;
  }

  fileMtime(path: string): number | undefined {
    const node = this.app.vault.getAbstractFileByPath(path);
    return node instanceof TFile ? node.stat.mtime : undefined;
  }

  /* Mirrors TabController.getMentionIndex's enumeration exactly: every file
     via getFiles(), every folder via a recursive walk from the root, with
     the root itself ("" / "/") excluded so "pin the entire vault" is not
     offerable. Folders carry mtime 0 (not exposed by Obsidian). */
  listIndexEntries(): VaultIndexEntry[] {
    const index: VaultIndexEntry[] = [];
    for (const f of this.app.vault.getFiles()) {
      index.push({ kind: "file", path: f.path, name: f.basename, mtime: f.stat.mtime, ext: f.extension });
    }
    const walkFolders = (folder: TFolder) => {
      for (const child of folder.children) {
        if (child instanceof TFolder) {
          if (child.path !== "" && child.path !== "/") {
            index.push({ kind: "folder", path: child.path, name: child.name, mtime: 0, ext: "" });
          }
          walkFolders(child);
        }
      }
    };
    walkFolders(this.app.vault.getRoot());
    return index;
  }

  onTreeChange(cb: () => void): () => void {
    const refs = [
      this.app.vault.on("create", cb),
      this.app.vault.on("delete", cb),
      this.app.vault.on("rename", cb),
    ];
    return () => {
      for (const ref of refs) this.app.vault.offref(ref);
    };
  }

  activeFilePath(): string | null {
    return this.app.workspace.getActiveFile()?.path ?? null;
  }

  resolveLink(linktext: string, sourcePath: string): string | null {
    return this.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)?.path ?? null;
  }

  openPath(linktext: string, mode: "tab" | "split"): void {
    void this.app.workspace.openLinkText(linktext, "", mode);
  }

  triggerHoverLink(
    event: MouseEvent,
    targetEl: HTMLElement,
    linktext: string,
    hoverParent?: RenderLifecycle,
  ): void {
    this.app.workspace.trigger("hover-link", {
      event,
      source: "claude-cli-chat",
      hoverParent,
      targetEl,
      linktext,
      sourcePath: "",
    });
  }

  /* Ported verbatim from TabController.readDragManagerPaths. File-explorer
     drags populate `app.dragManager.draggable` with the dragged TFile/TFolder
     (or a `files` array for multi-select) but typically leave the HTML5
     dataTransfer empty, so this is the only reliable in-flight signal. Link
     drags (a [[wikilink]] out of an editor, search result, backlink,
     bookmark, tab header) carry no TFile — just linktext + sourcePath — and
     resolve through the metadata cache. `dragManager` is internal (absent
     from the public d.ts), hence the narrow-through-unknown. */
  readDragPaths(): string[] {
    const dm = (this.app as unknown as {
      dragManager?: {
        draggable?: {
          file?: unknown;
          files?: unknown[];
          linktext?: unknown;
          sourcePath?: unknown;
          source?: unknown;
          type?: unknown;
        };
      };
    }).dragManager;
    const draggable = dm?.draggable;
    if (!draggable) return [];
    const paths: string[] = [];
    if (draggable.file instanceof TFile || draggable.file instanceof TFolder) {
      paths.push(draggable.file.path);
    }
    if (Array.isArray(draggable.files)) {
      for (const f of draggable.files) {
        if (f instanceof TFile || f instanceof TFolder) paths.push(f.path);
      }
    }
    if (paths.length === 0 && draggable.type === "link" && typeof draggable.linktext === "string") {
      /* linktext may carry a heading/block subpath ("Note#Section") — strip
         it; pins are whole-file. */
      const bare = draggable.linktext.split("#")[0].trim();
      const source = typeof draggable.sourcePath === "string" ? draggable.sourcePath : "";
      const dest = this.app.metadataCache.getFirstLinkpathDest(bare, source);
      if (dest) paths.push(dest.path);
    }
    return paths;
  }
}

export class ObsidianPlatform implements Platform {
  readonly storage: FileStorage;
  readonly vaultFeatures: VaultFeatures;

  constructor(private app: App) {
    this.storage = new ObsidianFileStorage(app);
    this.vaultFeatures = new ObsidianVaultFeatures(app);
  }

  notify(message: string, timeoutMs?: number): void {
    new Notice(message, timeoutMs);
  }

  setIcon(el: HTMLElement, iconId: string): void {
    setIcon(el, iconId);
  }

  async renderMarkdown(
    markdown: string,
    el: HTMLElement,
    sourcePath: string,
    lifecycle?: RenderLifecycle,
  ): Promise<void> {
    /* A missing lifecycle gets a throwaway Component — same lifetime the
       rendered fragment has when nobody owns it. Current shared callers
       (MessageRenderer) always pass their own. */
    const component = lifecycle instanceof Component ? lifecycle : new Component();
    await MarkdownRenderer.render(this.app, markdown, el, sourcePath, component);
  }

  async httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
    const resp = await requestUrl({
      url: options.url,
      method: options.method,
      contentType: options.contentType,
      headers: options.headers,
      body: options.body,
      throw: options.throwOnError ?? true,
    });
    /* resp.json is a getter that throws on non-JSON bodies; degrade to
       undefined so callers can rely on `text` unconditionally. */
    let json: unknown;
    try { json = resp.json; } catch { json = undefined; }
    return { status: resp.status, headers: resp.headers, text: resp.text, json };
  }

  showContextMenu(evt: MouseEvent, items: MenuItemSpec[]): void {
    const menu = new Menu();
    for (const spec of items) {
      menu.addItem(item => {
        item.setTitle(spec.title).onClick(spec.onClick);
        if (spec.icon) item.setIcon(spec.icon);
      });
    }
    menu.showAtMouseEvent(evt);
  }

  createModal(delegate: ModalDelegate): ModalHost {
    return new ObsidianModalHost(this.app, delegate);
  }

  createSuggestModal<T>(delegate: SuggestModalDelegate<T>): SuggestModalHost {
    return new ObsidianSuggestModalHost<T>(this.app, delegate);
  }
}
