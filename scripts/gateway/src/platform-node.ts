/* Minimal Platform implementation for the headless daemon.

   `src/storage/Persistence`, `src/permissions/PermissionsConfig`, and
   `src/mcp/MCPConfig` all reach the module-level `platform` singleton for
   file I/O and user notices. The Electron shell installs a full one
   (app/src/desktop-platform.ts) built around a real DOM; there is no DOM
   here, so everything that renders is a hard throw — reaching one would mean
   the daemon called a UI path it has no business calling, and a silent no-op
   would hide that. Storage is the only capability that must actually work,
   and it is a straight port of app/src/desktop-storage.ts's NodeFileStorage.

   Deliberately NOT reusing DesktopHost: it constructs a SpeechController and
   DOM-backed widgets at import time. The gateway wires the same stores by
   hand instead. */

import { promises as fs } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

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
} from "../../../src/platform/types";
import { initializePlatform } from "../../../src/platform";

export class NodeFileStorage implements FileStorage {
  constructor(private readonly baseDir: string) {}

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
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  }

  async write(path: string, data: string): Promise<void> {
    const target = this.abs(path);
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

function headless(feature: string): never {
  throw new Error(`[vault-gateway] ${feature} is not available in the headless daemon`);
}

export function installNodePlatform(baseDir: string, log: (msg: string) => void): void {
  const impl: Platform = {
    /* Notices become log lines. PermissionsConfigStore and MCPConfigStore both
       notify() on a corrupted config file; on a daemon that is exactly the
       kind of thing that has to reach the log rather than vanish. */
    notify: (message: string) => log(`notice: ${message}`),
    setIcon: () => headless("setIcon"),
    renderMarkdown: (_md: string, _el: HTMLElement, _src: string, _lc?: RenderLifecycle) => headless("renderMarkdown"),
    httpRequest: async (options: HttpRequestOptions): Promise<HttpResponse> => {
      const res = await fetch(options.url, {
        method: options.method ?? "GET",
        headers: {
          ...(options.contentType ? { "Content-Type": options.contentType } : {}),
          ...(options.headers ?? {}),
        },
        body: options.body,
      });
      const text = await res.text();
      if (options.throwOnError !== false && (res.status < 200 || res.status >= 300)) {
        throw new Error(`HTTP ${res.status} for ${options.url}`);
      }
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = undefined; }
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      return { status: res.status, headers, text, json };
    },
    showContextMenu: (_e: MouseEvent, _items: MenuItemSpec[]) => headless("showContextMenu"),
    createModal: (_d: ModalDelegate): ModalHost => headless("createModal"),
    createSuggestModal: <T,>(_d: SuggestModalDelegate<T>): SuggestModalHost => headless("createSuggestModal"),
    storage: new NodeFileStorage(baseDir),
    /* No vaultFeatures: there is no Obsidian index here. Every shared consumer
       feature-checks it. */
  };
  initializePlatform(impl);
}
