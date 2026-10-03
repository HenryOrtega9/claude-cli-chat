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
} from "../../../src/platform/remote/transport";

type WebkitBridge = {
  messageHandlers?: {
    native?: { postMessage(body: unknown): Promise<unknown> };
  };
};

function webkitHandler(): { postMessage(body: unknown): Promise<unknown> } | null {
  const wk = (window as unknown as { webkit?: WebkitBridge }).webkit;
  return wk?.messageHandlers?.native ?? null;
}

/* ---------------------------------------------------------------------------
   Deep-link dispatch: notification tap -> tab switch
   ------------------------------------------------------------------------ */

/* Not routed through window.__vaultgw.dispatch (renderer.ts). That channel's
   `queued` array only drains once renderer.ts's boot() calls
   installHandler() — behind several awaited gateway round trips (getConfig,
   /health, and up to ~33s of `waitForReady` polling for a cold iCloud vault).
   A notification tapped while the app is still cold-launching can land in
   that window; the switch's `default: return` would drop it silently.

   `window.__vaultgwSwitchTab` is defined right here, at this module's own
   evaluation time. ES modules guarantee every imported module (this one
   included) finishes evaluating before the importing module's (renderer.ts)
   own top-level code runs, let alone its async boot() — so this entry point
   is live from the first instant the bundle executes, independent of how
   long the rest of boot() takes. NativeBridge.swift's `rawDispatch` calls it
   directly for the "switchTab" name only; every other name still rides the
   documented `dispatch` channel. See CONTRACTS.md's native bridge section. */
export type PendingTabSwitch = { tabId: string; requestId?: string };

let switchTabHandler: ((p: PendingTabSwitch) => void) | null = null;
/* At most one entry: a second tap before the first is consumed simply
   replaces it. There is only one page to land on, so "most recent not--
   ification tapped" is the only sensible semantics — mirrors `dispatch`'s
   own `liveHandler`/`queued` pattern in renderer.ts, scoped to this one
   message. */
let queuedTabSwitch: PendingTabSwitch | null = null;

function handleSwitchTabCall(payload: unknown): void {
  const p = payload as { tabId?: unknown; requestId?: unknown } | undefined;
  const tabId = typeof p?.tabId === "string" ? p.tabId : "";
  if (!tabId) return;
  const msg: PendingTabSwitch = {
    tabId,
    requestId: typeof p?.requestId === "string" ? p.requestId : undefined,
  };
  if (switchTabHandler) switchTabHandler(msg);
  else queuedTabSwitch = msg;
}

(window as unknown as { __vaultgwSwitchTab: typeof handleSwitchTabCall }).__vaultgwSwitchTab
  = handleSwitchTabCall;

/* Registered once, by IosChatShell's constructor — as early as this module
   graph allows, well before the shell's own async mount() has restored any
   tabs. A switch that arrived (queued above) before registration is
   delivered synchronously the moment it registers, so the shell never has to
   poll for one. */
export function onSwitchTab(handler: (p: PendingTabSwitch) => void): void {
  switchTabHandler = handler;
  if (queuedTabSwitch) {
    const pending = queuedTabSwitch;
    queuedTabSwitch = null;
    handler(pending);
  }
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
   Apple Health (iOS only)
   ------------------------------------------------------------------------ */

/* The `healthStatus` / `healthSetEnabled` / `healthSyncNow` bridge methods and
   the `healthSync` dispatch from docs/ios-gateway/APPLE-HEALTH.md. Kept out of
   the shared GatewayTransport interface (src/platform/remote/transport.ts):
   no other host has HealthKit, so this is an iOS-only API reached through
   healthApi() below. HealthSync.swift is the native side. */
export type HealthStatus = {
  available: boolean;
  enabled: boolean;
  syncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  progress: { typesDone: number; typesTotal: number; samplesSent: number } | null;
  totals: { samplesSent: number; dailySent: number };
};

export interface HealthApi {
  status(): Promise<HealthStatus>;
  setEnabled(enabled: boolean): Promise<HealthStatus>;
  syncNow(): Promise<HealthStatus>;
}

const UNAVAILABLE_HEALTH: HealthStatus = {
  available: false,
  enabled: false,
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  progress: null,
  totals: { samplesSent: 0, dailySent: 0 },
};

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/* Native replies and dispatches arrive untyped; narrow field by field so a
   missing or malformed value degrades to "off" instead of a broken sheet. */
export function parseHealthStatus(raw: unknown): HealthStatus {
  if (!raw || typeof raw !== "object") return { ...UNAVAILABLE_HEALTH };
  const r = raw as Record<string, unknown>;
  const progress = r.progress && typeof r.progress === "object"
    ? r.progress as Record<string, unknown>
    : null;
  const totals = r.totals && typeof r.totals === "object" ? r.totals as Record<string, unknown> : {};
  return {
    available: r.available === true,
    enabled: r.enabled === true,
    syncing: r.syncing === true,
    lastSyncAt: typeof r.lastSyncAt === "string" ? r.lastSyncAt : null,
    lastError: typeof r.lastError === "string" ? r.lastError : null,
    progress: progress
      ? {
        typesDone: num(progress.typesDone),
        typesTotal: num(progress.typesTotal),
        samplesSent: num(progress.samplesSent),
      }
      : null,
    totals: { samplesSent: num(totals.samplesSent), dailySent: num(totals.dailySent) },
  };
}

/* ---------------------------------------------------------------------------
   Native transport
   ------------------------------------------------------------------------ */

class NativeTransport implements GatewayTransport, HealthApi {
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

  async wsUrl(): Promise<{ url: string | null; unauthorized: boolean }> {
    try {
      /* NativeBridge.swift answers a bad/absent bearer token with
         `{status:401, error:"unauthorized"}` (no `url` field) — the same
         shape `rpc`'s replies use for a failed request. Reading `status`
         here, not just `url`, is what lets connect() tell "the token is bad"
         apart from "the Mac is unreachable right now" instead of collapsing
         both into an endless retry loop. */
      const reply = await this.call("wsUrl") as { url?: unknown; status?: unknown };
      const url = typeof reply?.url === "string" ? reply.url : null;
      return { url, unauthorized: reply?.status === 401 };
    } catch {
      return { url: null, unauthorized: false };
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

  /* HealthApi. A rejected call (an older native build without these methods
     answers "unknown_method") reads as unavailable rather than throwing. */
  private async health(method: string, params?: Record<string, unknown>): Promise<HealthStatus> {
    try {
      return parseHealthStatus(await this.call(method, params));
    } catch {
      return { ...UNAVAILABLE_HEALTH };
    }
  }

  status(): Promise<HealthStatus> {
    return this.health("healthStatus");
  }

  setEnabled(enabled: boolean): Promise<HealthStatus> {
    return this.health("healthSetEnabled", { enabled });
  }

  syncNow(): Promise<HealthStatus> {
    return this.health("healthSyncNow");
  }
}

/* ---------------------------------------------------------------------------
   Browser fallback (development only)
   ------------------------------------------------------------------------ */

class BrowserTransport implements GatewayTransport, HealthApi {
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

  async wsUrl(): Promise<{ url: string | null; unauthorized: boolean }> {
    const ticket = await this.rpc("POST", "/ws-ticket");
    const value = (ticket.json as { ticket?: unknown } | undefined)?.ticket;
    if (ticket.status !== 200 || typeof value !== "string") {
      return { url: null, unauthorized: ticket.status === 401 };
    }
    const httpUrl = new URL(this.url(`/ws/${value}`));
    httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
    return { url: httpUrl.toString(), unauthorized: false };
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

  /* No HealthKit in a desktop browser. */
  async status(): Promise<HealthStatus> { return { ...UNAVAILABLE_HEALTH }; }
  async setEnabled(): Promise<HealthStatus> { return { ...UNAVAILABLE_HEALTH }; }
  async syncNow(): Promise<HealthStatus> { return { ...UNAVAILABLE_HEALTH }; }
}

let cached: (GatewayTransport & HealthApi) | null = null;

function transportInstance(): GatewayTransport & HealthApi {
  if (cached) return cached;
  const handler = webkitHandler();
  cached = handler ? new NativeTransport(handler) : new BrowserTransport();
  return cached;
}

export function nativeTransport(): GatewayTransport {
  return transportInstance();
}

/* The iOS-only Apple Health API, on the same transport instance. */
export function healthApi(): HealthApi {
  return transportInstance();
}

export function isNativeHost(): boolean {
  return webkitHandler() !== null;
}
