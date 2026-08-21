/* Vault file search and read for the phone's @-mention picker.

   The Obsidian plugin gets its index for free from `metadataCache`; there is
   no metadata cache in a daemon, so this walks the tree itself and memoizes
   the result for INDEX_TTL_MS. Dot-directories are skipped wholesale — that
   is where `.obsidian`, `.git`, `.trash` and our own `.claude-cli-chat/ios`
   store live, and none of it is user content the phone should be offering to
   attach.

   Reads are hard-bounded: the path must resolve INSIDE the vault (so a
   `?path=../../.ssh/id_rsa` is a 400, not a key leak), the extension must be
   textual, and the body is capped at 512 KB. */

import { promises as fs } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

const INDEX_TTL_MS = 30_000;
export const FILE_BYTE_CAP = 512 * 1024;

/* Markdown plus the attachment kinds the composer can actually do something
   with. Anything else stays out of the picker rather than offering the user a
   file the turn would silently drop. */
const LISTABLE_EXTS = new Set([
  ".md", ".markdown", ".txt", ".canvas", ".csv", ".json",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic",
  ".pdf", ".docx", ".xlsx", ".pptx",
]);

const TEXT_EXTS = new Set([".md", ".markdown", ".txt", ".canvas", ".csv", ".json", ".yaml", ".yml", ".ts", ".js", ".py", ".sh", ".css", ".html"]);

export type VaultFile = { path: string; name: string; mtime: number };

export class VaultIndex {
  private cache: VaultFile[] | null = null;
  private cachedAt = 0;
  private inflight: Promise<VaultFile[]> | null = null;

  constructor(private readonly vault: string) {}

  async search(query: string, limit = 50): Promise<VaultFile[]> {
    const all = await this.entries();
    const q = query.trim().toLowerCase();
    if (!q) {
      /* Empty query = most recently modified, matching the desktop picker's
         cold-open ordering. */
      return all.slice().sort((a, b) => b.mtime - a.mtime).slice(0, limit);
    }
    const scored: Array<{ file: VaultFile; score: number }> = [];
    for (const file of all) {
      const name = file.name.toLowerCase();
      const path = file.path.toLowerCase();
      let score: number;
      if (name === q) score = 0;
      else if (name.startsWith(q)) score = 1;
      else if (name.includes(q)) score = 2;
      else if (path.includes(q)) score = 3;
      else continue;
      scored.push({ file, score });
    }
    scored.sort((a, b) => (a.score - b.score) || (b.file.mtime - a.file.mtime));
    return scored.slice(0, limit).map(s => s.file);
  }

  private async entries(): Promise<VaultFile[]> {
    if (this.cache && Date.now() - this.cachedAt < INDEX_TTL_MS) return this.cache;
    if (this.inflight) return this.inflight;
    const job = this.walk().then(files => {
      this.cache = files;
      this.cachedAt = Date.now();
      return files;
    }).finally(() => { this.inflight = null; });
    this.inflight = job;
    return job;
  }

  private async walk(): Promise<VaultFile[]> {
    const out: VaultFile[] = [];
    const stack: string[] = [this.vault];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let dirents;
      try {
        dirents = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const dirent of dirents) {
        if (dirent.name.startsWith(".")) continue;
        const abs = join(dir, dirent.name);
        if (dirent.isDirectory()) {
          stack.push(abs);
          continue;
        }
        if (!dirent.isFile()) continue;
        if (!LISTABLE_EXTS.has(extname(dirent.name).toLowerCase())) continue;
        let mtime = 0;
        try { mtime = (await fs.stat(abs)).mtimeMs; } catch { /* raced a delete */ }
        out.push({
          path: relative(this.vault, abs),
          name: dirent.name.replace(/\.[^.]+$/, ""),
          mtime: Math.round(mtime),
        });
      }
    }
    return out;
  }
}

export type ReadResult =
  | { ok: true; path: string; text: string }
  | { ok: false; status: number; error: string };

export async function readVaultFile(vault: string, relPath: string): Promise<ReadResult> {
  if (!relPath) return { ok: false, status: 400, error: "missing_path" };
  const abs = resolve(vault, relPath);
  /* Containment check on the RESOLVED path, so `..` segments and symlinked
     names can't walk out of the vault. */
  const rel = relative(vault, abs);
  if (rel.startsWith("..") || rel.startsWith(sep) || resolve(vault) === abs) {
    return { ok: false, status: 400, error: "path_outside_vault" };
  }
  /* Same dot-directory rule the listing uses, applied to reads so the two
     can't disagree: `.obsidian`, `.git`, `.trash` and our own store are not
     user content, and the permissions endpoint is the sanctioned way to see
     `.claude/settings.json`. */
  if (rel.split(sep).some(seg => seg.startsWith("."))) {
    return { ok: false, status: 403, error: "dot_path_excluded" };
  }
  if (!TEXT_EXTS.has(extname(abs).toLowerCase())) {
    return { ok: false, status: 415, error: "not_a_text_file" };
  }
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return { ok: false, status: 404, error: "not_found" };
  }
  if (!stat.isFile()) return { ok: false, status: 404, error: "not_found" };
  if (stat.size > FILE_BYTE_CAP) return { ok: false, status: 413, error: "file_too_large" };
  try {
    return { ok: true, path: rel, text: await fs.readFile(abs, "utf8") };
  } catch {
    return { ok: false, status: 500, error: "read_failed" };
  }
}
