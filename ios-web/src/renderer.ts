/* PLACEHOLDER browser entry for the iOS client (Vault Gateway).

   Wave-2 (the remote-engine agent) replaces this file with the real shell:
   native bridge, remote engine, tab restore. Until then it exists so the
   `--ios` esbuild target has something to compile, and — more usefully — so
   the forbid-node guard in esbuild.config.mjs has the WHOLE shared view layer
   in its graph. TabController is deliberately pulled in and parked on
   `window` below: nothing renders it yet, but if any shared module regains a
   `node:`/`electron`/`obsidian` import, this build fails.

   Everything here is plain DOM plus src/platform/dom/*, so it runs in a
   WKWebView with no node and no Obsidian. */

import { installDomHelpers } from "../../src/platform/dom/dom-polyfill";
import { renderIcon } from "../../src/platform/dom/desktop-icons";
import { renderMarkdownInto } from "../../src/platform/dom/markdown";
import {
  DomModalHost,
  DomSuggestModalHost,
  showContextMenuAt,
  showToast,
} from "../../src/platform/dom/desktop-overlays";
import { initializePlatform } from "../../src/platform";
import type {
  FileStorage,
  HttpRequestOptions,
  HttpResponse,
  MenuItemSpec,
  ModalDelegate,
  ModalHost,
  Platform,
  SuggestModalDelegate,
  SuggestModalHost,
} from "../../src/platform/types";
import { renderWelcome } from "../../src/view/Welcome";
import { TabController } from "../../src/view/TabController";

/* Storage is the gateway's job (every path is a file on the Mac), so the
   placeholder rejects instead of pretending. Wave 2 swaps this for an
   HTTP-backed FileStorage. */
const unavailable = (op: string) => Promise.reject(new Error(`storage.${op} is not available yet`));

const placeholderStorage: FileStorage = {
  exists: () => Promise.resolve(false),
  read: () => unavailable("read") as Promise<string>,
  readBinary: () => unavailable("readBinary") as Promise<ArrayBuffer>,
  write: () => unavailable("write") as Promise<void>,
  rename: () => unavailable("rename") as Promise<void>,
  remove: () => unavailable("remove") as Promise<void>,
  mkdir: () => unavailable("mkdir") as Promise<void>,
  list: () => Promise.resolve({ files: [], folders: [] }),
  basePath: () => null,
};

/* Minimal Platform over the shared DOM helpers. vaultFeatures is absent, the
   same as the Electron shell — every consumer already `?.`s it. */
class PlaceholderPlatform implements Platform {
  readonly storage: FileStorage = placeholderStorage;

  constructor() {
    installDomHelpers();
  }

  notify(message: string, timeoutMs?: number): void {
    showToast(message, timeoutMs);
  }

  setIcon(el: HTMLElement, iconId: string): void {
    renderIcon(el, iconId);
  }

  async renderMarkdown(markdown: string, el: HTMLElement): Promise<void> {
    renderMarkdownInto(markdown, el);
  }

  async httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
    const res = await fetch(options.url, {
      method: options.method ?? "GET",
      headers: {
        ...(options.contentType ? { "Content-Type": options.contentType } : {}),
        ...(options.headers ?? {}),
      },
      body: options.body,
    });
    const text = await res.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    if (options.throwOnError !== false && res.status >= 400) {
      throw new Error(`Request failed, status ${res.status}`);
    }
    return { status: res.status, headers, text, json };
  }

  showContextMenu(evt: MouseEvent, items: MenuItemSpec[]): void {
    showContextMenuAt(evt, items);
  }

  createModal(delegate: ModalDelegate): ModalHost {
    return new DomModalHost(delegate);
  }

  createSuggestModal<T>(delegate: SuggestModalDelegate<T>): SuggestModalHost {
    return new DomSuggestModalHost<T>(delegate);
  }
}

function boot(): void {
  initializePlatform(new PlaceholderPlatform());
  const app = document.getElementById("app");
  if (!app) return;
  app.empty();
  app.addClass("claudian-container");
  app.setAttribute("data-provider", "claude");
  renderWelcome(app, "");
}

/* Keeps the shared view layer in the bundle (see the header). */
(window as unknown as { __vaultgw_shared?: unknown }).__vaultgw_shared = { TabController };

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
