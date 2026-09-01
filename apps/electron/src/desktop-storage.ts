/* FileStorage over node fs, rooted at a base directory.

   Shared code passes the exact same root-relative paths it passes to
   Obsidian's DataAdapter today (".claude-cli-chat/tabs/x.json",
   ".claude/mcp.json"), so every method here resolves against baseDir and
   every path that comes back out stays root-relative. That symmetry is what
   lets Persistence.listConversations slice an id out of a listing entry
   unchanged.

   Semantics deliberately mirror app.vault.adapter, including the sharp
   edges: list() on a missing folder rejects (callers already guard with
   exists()), rename() overwrite-replaces (writeJsonAtomic's staging protocol
   depends on POSIX rename atomicity), remove() is for files. */

import { promises as fs } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type { FileStorage } from "../../../src/platform/types";

export class NodeFileStorage implements FileStorage {
  constructor(private readonly baseDir: string) {}

  /* Absolute paths are passed through untouched: attachment flows can hand
     us a path that already escaped the vault, and Obsidian would have been
     handed a vault-relative one for the same file. Everything else is
     resolved under the root. */
  private abs(path: string): string {
    return isAbsolute(path) ? path : resolve(this.baseDir, path);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fs.stat(this.abs(path));
      return true;
    } catch {
      return false;
    }
  }

  async read(path: string): Promise<string> {
    return await fs.readFile(this.abs(path), "utf8");
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const buf = await fs.readFile(this.abs(path));
    /* Buffers are views onto a shared pool, so slice the exact window rather
       than handing out `buf.buffer` (which would leak unrelated bytes). */
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }

  async write(path: string, data: string): Promise<void> {
    const target = this.abs(path);
    /* One deliberate softening of DataAdapter semantics: create the parent
       chain first. Obsidian's adapter throws ENOENT and every caller in
       src/ mkdirs beforehand, but a desktop baseDir can be a brand-new
       directory tree and a missing mkdir would silently lose a tab. */
    await fs.mkdir(resolve(target, ".."), { recursive: true });
    await fs.writeFile(target, data, "utf8");
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await fs.rename(this.abs(oldPath), this.abs(newPath));
  }

  async remove(path: string): Promise<void> {
    await fs.rm(this.abs(path));
  }

  async mkdir(path: string): Promise<void> {
    await fs.mkdir(this.abs(path), { recursive: true });
  }

  /* Shallow listing whose entries are root-relative FULL paths, matching
     ListedFiles. Symlinks are resolved via stat (not lstat) so a linked
     conversations folder behaves like a real one. */
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    const dirents = await fs.readdir(this.abs(path), { withFileTypes: true });
    const prefix = path.replace(/\/+$/, "");
    const files: string[] = [];
    const folders: string[] = [];
    for (const dirent of dirents) {
      const entry = prefix === "" || prefix === "." ? dirent.name : `${prefix}/${dirent.name}`;
      let isDir = dirent.isDirectory();
      if (dirent.isSymbolicLink()) {
        try {
          isDir = (await fs.stat(join(this.abs(path), dirent.name))).isDirectory();
        } catch {
          continue;
        }
      }
      if (isDir) folders.push(entry);
      else files.push(entry);
    }
    return { files, folders };
  }

  basePath(): string | null {
    return this.baseDir;
  }
}
