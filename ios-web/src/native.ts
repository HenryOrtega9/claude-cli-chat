/* The JS side of the WKWebView bridge, plus a browser fallback for dev.

   IN THE APP: every call goes through
   `window.webkit.messageHandlers.native.postMessage({method, params})`, which
   returns a promise (WKScriptMessageHandlerWithReply). Native adds the bearer
   token from the Keychain, so no secret ever lives in the page. The method
   table is CONTRACTS.md's "JS ↔ native bridge"; ios/Sources/NativeBridge.swift
   is the implementation.

   IN A DESKTOP BROWSER: `window.webkit` is absent, and this file talks to the
   gateway directly so the whole client can be exercised without Xcode. Config
   comes from localStorage:

     vaultgw.dev.token    bearer token (required) — `cat ~/.config/vault-gateway/token`
     vaultgw.dev.base     path or absolute origin to prefix onto every route.
                          Defaults to "/gw", which is what ios-web/dev-server.mjs
                          serves: the page and the gateway become same-origin,
                          so no CORS is involved.
     vaultgw.dev.host     when set, routes go to <scheme>://<host>:<port>
     vaultgw.dev.port     directly instead of through the proxy. The daemon
     vaultgw.dev.scheme   sends no CORS headers, so this only works from a
                          context that is already same-origin with it.

   The fallback mints its own ws ticket (POST /ws-ticket) and builds the
   `ws(s)://…/ws/<ticket>` URL, exactly as native's `wsUrl` does. */

import type {
  GatewayClientState,
  GatewayConfig,
  GatewayTransport,
  RpcResult,
} from "../../src/platform/remote/transport";

type WebkitBridge = {
  messageHandlers?: {
    native?: { postMessage(body: unknown): Promise<unknown> };
  };
};

function webkitHandler(): { postMessage(body: unknown): Promise<unknown> } | null {
  const wk = (window as unknown as { webkit?: WebkitBridge }).webkit;
  return wk?.messageHandlers?.native ?? null;
}

export const DEV_KEYS = {
  token: "vaultgw.dev.token",
  base: "vaultgw.dev.base",
  host: "vaultgw.dev.host",
  port: "vaultgw.dev.port",
  scheme: "vaultgw.dev.scheme",
} as const;

function devValue(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

/* ---------------------------------------------------------------------------
   Native transport
   ------------------------------------------------------------------------ */

class NativeTransport implements GatewayTransport {
  readonly isNative = true;

  constructor(private readonly handler: { postMessage(body: unknown): Promise<unknown> }) {}

  private call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.handler.postMessage({ method, params: params ?? {} });
  }

  async getConfig(): Promise<GatewayConfig> {
    return await this.call("getConfig") as GatewayConfig;
  }

  async rpc(method: string, path: string, body?: unknown): Promise<RpcResult> {
    try {
      const reply = await this.call("rpc", { method, path, ...(body === undefined ? {} : { body }) });
      return (reply ?? { status: 0, error: "other" }) as RpcResult;
    } catch (err) {
      return { status: 0, error: "other", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async wsUrl(): Promise<string | null> {
    try {
      const reply = await this.call("wsUrl") as { url?: unknown };
      return typeof reply?.url === "string" ? reply.url : null;
    } catch {
      return null;
    }
  }

  setState(state: GatewayClientState): void {
    void this.call("setState", state as unknown as Record<string, unknown>).catch(() => undefined);
  }

  haptic(kind: "light" | "medium" | "success" | "warning" | "error" | "selection"): void {
    void this.call("haptic", { kind }).catch(() => undefined);
  }

  copy(text: string): void {
    void this.call("copy", { text }).catch(() => undefined);
  }

  speak(text: string): void {
    void this.call("speak", { text }).catch(() => undefined);
  }

  stopSpeaking(): void {
    void this.call("speak", { stop: true }).catch(() => undefined);
  }

  openSettings(): void {
    void this.call("openSettings").catch(() => undefined);
  }
}

/* ---------------------------------------------------------------------------
   Browser fallback (development only)
   ------------------------------------------------------------------------ */

class BrowserTransport implements GatewayTransport {
  readonly isNative = false;

  private base(): string {
    const host = devValue(DEV_KEYS.host);
    if (host) {
      const scheme = devValue(DEV_KEYS.scheme) === "https" ? "https" : "http";
      const port = devValue(DEV_KEYS.port) || "8788";
      return `${scheme}://${host}:${port}`;
    }
    const configured = devValue(DEV_KEYS.base);
    /* Same-origin by default: ios-web/dev-server.mjs proxies /gw/* (including
       the WebSocket upgrade) to the daemon, which is the only way a desktop
       browser can reach it — the daemon emits no CORS headers. */
    return configured || "/gw";
  }

  private url(path: string): string {
    const base = this.base();
    if (base.startsWith("http")) return `${base}${path}`;
    return `${window.location.origin}${base}${path}`;
  }

  async getConfig(): Promise<GatewayConfig> {
    const health = await this.rpc("GET", "/health");
    const cwd = (health.json as { cwd?: unknown } | undefined)?.cwd;
    const vaultName = typeof cwd === "string" ? cwd.split("/").filter(Boolean).pop() ?? "" : "";
    const target = new URL(this.url("/health"));
    return {
      host: target.hostname,
      scheme: target.protocol === "https:" ? "https" : "http",
      port: Number(target.port || (target.protocol === "https:" ? 443 : 80)),
      vaultName,
      hasToken: devValue(DEV_KEYS.token).length > 0,
      appVersion: "dev",
      theme: "dark",
      safeArea: { top: 0, bottom: 0, left: 0, right: 0 },
    };
  }

  async rpc(method: string, path: string, body?: unknown): Promise<RpcResult> {
    const token = devValue(DEV_KEYS.token);
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      return { status: 0, error: "other", message: err instanceof Error ? err.message : String(err) };
    }
    const text = await res.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { /* not JSON */ }
    return { status: res.status, json, text };
  }

  async wsUrl(): Promise<string | null> {
    const ticket = await this.rpc("POST", "/ws-ticket");
    const value = (ticket.json as { ticket?: unknown } | undefined)?.ticket;
    if (ticket.status !== 200 || typeof value !== "string") return null;
    const httpUrl = new URL(this.url(`/ws/${value}`));
    httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
    return httpUrl.toString();
  }

  /* No native side to persist for. Mirrored into sessionStorage so the dev
     page's cursor survives a reload the same way the app's does. */
  setState(state: GatewayClientState): void {
    try { window.sessionStorage.setItem("vaultgw.dev.state", JSON.stringify(state)); } catch { /* ignore */ }
  }

  haptic(): void { /* no haptics in a browser */ }

  copy(text: string): void {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  }

  speak(text: string): void {
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      window.speechSynthesis.speak(utterance);
    } catch { /* no speech synthesis */ }
  }

  stopSpeaking(): void {
    try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
  }

  openSettings(): void {
    console.info("[vaultgw] openSettings is a native-only affordance; set vaultgw.dev.* in localStorage instead.");
  }
}

let cached: GatewayTransport | null = null;

export function nativeTransport(): GatewayTransport {
  if (cached) return cached;
  const handler = webkitHandler();
  cached = handler ? new NativeTransport(handler) : new BrowserTransport();
  return cached;
}

export function isNativeHost(): boolean {
  return webkitHandler() !== null;
}
