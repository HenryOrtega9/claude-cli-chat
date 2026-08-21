/* RemoteVaultFeatures — the @-mention index, backed by GET /files.

   `VaultFeatures` is the capability the Obsidian host implements against a
   live, indexed file tree. Everything on it is SYNCHRONOUS (types.ts), because
   Obsidian's metadata cache is in memory. There is no in-memory vault here, so
   this class keeps a SNAPSHOT: one `GET /files?limit=…` at boot, refreshed
   whenever the page regains focus, with `onTreeChange` firing after each
   refresh so TabController rebuilds its mention index.

   What the phone genuinely gets from this: typing `@` lists real vault files
   and pins their paths into the turn. The CLI reads those paths on the Mac, so
   the phone never needs the bytes.

   What it deliberately cannot do:
     activeFilePath()  -> null. There is no editor and no active note.
     openPath()        -> notifies. Opening a vault note means opening Obsidian
                          on a different machine.
     triggerHoverLink()-> no-op. Page Preview is an Obsidian core plugin.
     readDragPaths()   -> []. Obsidian's internal drag manager is not here. */

import { platform, type RenderLifecycle, type VaultEntryKind, type VaultFeatures, type VaultIndexEntry } from "../../src/platform";
import type { GatewayConnection } from "../../src/platform/remote/GatewayConnection";

/* The daemon clamps `limit` to 500 and its index is a 30 s cache, so asking
   for the maximum once per focus is cheap and gives the mention popup enough
   to filter against. */
const FILE_LIMIT = 500;

type FileRow = { path: string; name: string; mtime: number };

function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

function stemOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

export class RemoteVaultFeatures implements VaultFeatures {
  private entries: VaultIndexEntry[] = [];
  private readonly byPath = new Map<string, VaultIndexEntry>();
  /* Lowercased basename (without extension) -> path, for resolveLink. First
     writer wins so a stable answer survives a refresh that reorders rows. */
  private readonly byStem = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private refreshing = false;
  private lastRefreshAt = 0;

  constructor(private readonly conn: GatewayConnection) {}

  /* Boot + focus. The focus handler is throttled: iOS fires focus on every
     keyboard dismissal, and a vault scan per keystroke-adjacent event would
     be absurd. */
  start(): void {
    void this.refresh();
    window.addEventListener("focus", () => {
      if (Date.now() - this.lastRefreshAt < 30_000) return;
      void this.refresh();
    });
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const res = await this.conn.rpc("GET", `/files?limit=${FILE_LIMIT}`);
      if (res.status !== 200) return;
      const rows = (res.json as { files?: unknown } | undefined)?.files;
      if (!Array.isArray(rows)) return;
      this.rebuild(rows as FileRow[]);
      this.lastRefreshAt = Date.now();
      for (const cb of this.listeners) {
        try { cb(); } catch { /* a listener must not break the refresh */ }
      }
    } finally {
      this.refreshing = false;
    }
  }

  private rebuild(rows: FileRow[]): void {
    const entries: VaultIndexEntry[] = [];
    const folders = new Set<string>();
    this.byPath.clear();
    this.byStem.clear();
    for (const row of rows) {
      if (!row || typeof row.path !== "string" || !row.path) continue;
      const entry: VaultIndexEntry = {
        kind: "file",
        path: row.path,
        name: typeof row.name === "string" && row.name ? row.name : stemOf(row.path),
        mtime: typeof row.mtime === "number" ? row.mtime : 0,
        ext: extOf(row.path),
      };
      entries.push(entry);
      this.byPath.set(entry.path, entry);
      const stem = stemOf(entry.path).toLowerCase();
      if (!this.byStem.has(stem)) this.byStem.set(stem, entry.path);
      /* Folders are not a route of their own; every ancestor of a returned
         file is a real folder, which is exactly what the mention popup needs
         to offer folder pins. */
      let slash = row.path.lastIndexOf("/");
      while (slash > 0) {
        folders.add(row.path.slice(0, slash));
        slash = row.path.lastIndexOf("/", slash - 1);
      }
    }
    for (const path of folders) {
      const entry: VaultIndexEntry = {
        kind: "folder",
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        /* 0 sinks folders in recency-ordered lists, matching the Obsidian
           implementation (it has no folder mtime either). */
        mtime: 0,
        ext: "",
      };
      entries.push(entry);
      this.byPath.set(path, entry);
    }
    this.entries = entries;
  }

  pathKind(path: string): VaultEntryKind | null {
    return this.byPath.get(path)?.kind ?? null;
  }

  fileMtime(path: string): number | undefined {
    const entry = this.byPath.get(path);
    return entry?.kind === "file" ? entry.mtime : undefined;
  }

  listIndexEntries(): VaultIndexEntry[] {
    return this.entries;
  }

  onTreeChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  activeFilePath(): string | null {
    return null;
  }

  /* Best-effort wikilink resolution: exact path first, then a basename match
     against the snapshot. Obsidian resolves relative to `sourcePath` with its
     full link-resolution rules; there is no source note here, so the argument
     is accepted and ignored. */
  resolveLink(linktext: string, _sourcePath: string): string | null {
    const trimmed = linktext.trim();
    if (!trimmed) return null;
    if (this.byPath.has(trimmed)) return trimmed;
    const withMd = `${trimmed}.md`;
    if (this.byPath.has(withMd)) return withMd;
    return this.byStem.get(trimmed.toLowerCase()) ?? null;
  }

  openPath(linktext: string, _mode: "tab" | "split"): void {
    platform.notify(`${linktext} lives in the vault on your Mac — open it in Obsidian there.`, 4000);
  }

  triggerHoverLink(
    _event: MouseEvent,
    _targetEl: HTMLElement,
    _linktext: string,
    _hoverParent?: RenderLifecycle,
  ): void {
    /* Page Preview is an Obsidian core plugin; nothing to trigger. */
  }

  readDragPaths(): string[] {
    return [];
  }
}
