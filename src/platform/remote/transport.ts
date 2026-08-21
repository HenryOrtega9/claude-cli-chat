/* The narrow port every remote module talks through.

   `src/platform/remote/*` must not know whether it is running inside a
   WKWebView (where HTTP goes out through `window.webkit.messageHandlers.native`
   with a Keychain-held bearer token) or in a desktop browser during
   development (where the page does its own `fetch` against a same-origin
   dev proxy). Both shapes are implemented in `ios-web/src/native.ts`; this
   file is the only thing the remote engine, storage and host compile against.

   IMPORT DISCIPLINE: types only, no runtime edges. Same rule as ./host.ts. */

/* Mirrors the native `rpc` reply: `status` 0 means the request never reached
   the daemon (no route to host, timeout, refused), and `error` names which.
   Anything >= 100 is a real HTTP status and `json` is the parsed body. */
export type RpcResult = {
  status: number;
  json?: unknown;
  text?: string;
  error?: string;
  message?: string;
};

/* The `getConfig` payload (CONTRACTS.md "JS ↔ native bridge"). */
export type GatewayConfig = {
  host: string;
  scheme: "http" | "https";
  port: number;
  vaultName: string;
  hasToken: boolean;
  appVersion: string;
  theme: "dark" | "light";
  safeArea: { top: number; bottom: number; left: number; right: number };
};

/* What the page persists so the native side can arm a background `/wait`
   after the WebView is gone. A no-op in the browser fallback. */
export type GatewayClientState = {
  activeTabId: string | null;
  lastSeq: Record<string, number>;
  busyTabs: string[];
  tabTitles?: Record<string, string>;
};

export interface GatewayTransport {
  /* True inside the real app; false in the desktop-browser dev fallback.
     Used only to decide whether native-only affordances (haptics, the native
     settings sheet) are worth rendering. */
  readonly isNative: boolean;
  getConfig(): Promise<GatewayConfig>;
  rpc(method: string, path: string, body?: unknown): Promise<RpcResult>;
  /* Mints a single-use ticket and returns the full `ws(s)://…/ws/<ticket>`
     URL. Rejects (or resolves with `null`) when the daemon is unreachable. */
  wsUrl(): Promise<string | null>;
  setState(state: GatewayClientState): void;
  haptic(kind: "light" | "medium" | "success" | "warning" | "error" | "selection"): void;
  copy(text: string): void;
  speak(text: string): void;
  stopSpeaking(): void;
  openSettings(): void;
}
