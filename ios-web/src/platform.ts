/* IosPlatform — the `Platform` implementation for the browser client.

   Third sibling of src/platform/obsidian.ts and app/src/desktop-platform.ts.
   Every capability is backed by the shared browser-safe DOM helpers that the
   shared-ui pass moved into src/platform/dom/, so toasts, icons, modals,
   suggest prompts, context menus and markdown all render exactly as they do in
   the Electron shell — the iOS client's visual identity comes from ios.css, not
   from a second set of widgets.

   Two capabilities differ from the desktop:

     httpRequest  goes through the gateway bridge, not node:http. The only
                  callers in shared code are the usage fetcher and anything
                  hitting the Anthropic usage API, and neither is reachable
                  from a phone except via the daemon — so a request to the
                  daemon's own origin is rewritten to a bridge `rpc` call and
                  anything else uses plain fetch (which will be CORS-bound,
                  and honestly reports the failure).

     vaultFeatures IS present, unlike the desktop shell: the vault is real, it
                  just lives on the Mac. RemoteVaultFeatures serves it from a
                  GET /files snapshot. */

import { installDomHelpers } from "../../src/platform/dom/dom-polyfill";
import { renderIcon } from "../../src/platform/dom/desktop-icons";
import {
  DomModalHost,
  DomSuggestModalHost,
  showContextMenuAt,
  showToast,
} from "../../src/platform/dom/desktop-overlays";
import { renderMarkdownInto } from "../../src/platform/dom/markdown";
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
  VaultFeatures,
} from "../../src/platform/types";
import type { GatewayTransport } from "../../src/platform/remote/transport";

export class IosPlatform implements Platform {
  readonly storage: FileStorage;
  readonly vaultFeatures: VaultFeatures;
  private readonly transport: GatewayTransport;

  constructor(opts: {
    storage: FileStorage;
    vaultFeatures: VaultFeatures;
    transport: GatewayTransport;
  }) {
    /* Obsidian's DOM prototype helpers (createDiv/createEl/addClass/...) are
       what every view file builds DOM with. Must be installed before anything
       renders; idempotent, so installing here as well as in the renderer entry
       costs nothing. */
    installDomHelpers();
    this.storage = opts.storage;
    this.vaultFeatures = opts.vaultFeatures;
    this.transport = opts.transport;
  }

  notify(message: string, timeoutMs?: number): void {
    showToast(message, timeoutMs);
  }

  setIcon(el: HTMLElement, iconId: string): void {
    renderIcon(el, iconId);
  }

  async renderMarkdown(
    markdown: string,
    el: HTMLElement,
    _sourcePath: string,
    _lifecycle?: RenderLifecycle,
  ): Promise<void> {
    renderMarkdownInto(markdown, el);
  }

  async httpRequest(options: HttpRequestOptions): Promise<HttpResponse> {
    /* A gateway-relative path ("/usage") rides the bridge, so native attaches
       the bearer token and the request is not subject to the page's origin. */
    if (options.url.startsWith("/")) {
      const result = await this.transport.rpc(options.method ?? "GET", options.url, options.body ? safeJson(options.body) : undefined);
      const text = result.text ?? (result.json === undefined ? "" : JSON.stringify(result.json));
      if (options.throwOnError !== false && (result.status === 0 || result.status >= 400)) {
        throw new Error(`Request failed, status ${result.status}`);
      }
      return { status: result.status, headers: {}, text, json: result.json };
    }
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
    try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
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

/* requestUrl callers hand a pre-serialized body string; the bridge wants a
   value it can re-serialize. Anything that isn't JSON rides through as a
   string, which is what the daemon's readJson would have seen anyway. */
function safeJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}
