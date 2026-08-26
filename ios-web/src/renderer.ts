/* Browser entry for the Vault Gateway client.

   Boot order, and why it is this order:

     1. window.__vaultgw.dispatch    FIRST, before any await. Native calls it
                                     via evaluateJavaScript as soon as the page
                                     finishes loading — a `suspend` or
                                     `connectivity` arriving before the object
                                     exists is silently lost, and `suspend` in
                                     particular must never be missed (the app
                                     is about to background with a live socket).
                                     Early calls queue and replay once the shell
                                     is up.
     2. installDomHelpers()          every view file builds DOM with
                                     createDiv/createEl, so this precedes any UI.
     3. native.getConfig()           theme, safe-area insets, whether a token
                                     even exists.
     4. transport -> connection -> storage -> platform    the platform singleton
                                     must be installed BEFORE any store or view
                                     code runs; shared modules reach the host
                                     only through it.
     5. host.prime()                 vault path + /catalog (skills, commands,
                                     subagents, models, MCP), so the composer's
                                     pickers are populated before the first tab.
     6. mount the shell              restores tabs from GET /tabs.
     7. connect the socket           after the UI exists, so replayed frames
                                     land on controllers that can render them.

   No node, no Electron, no Obsidian: the forbid-node esbuild plugin fails the
   build on any of the three anywhere in this graph. */

import { installDomHelpers } from "../../src/platform/dom/dom-polyfill";
import { initializePlatform, platform } from "../../src/platform";
import { setSyncFileWriter } from "../../src/storage/Persistence";
import { Persistence } from "../../src/storage/Persistence";
import { GatewayConnection } from "../../src/platform/remote/GatewayConnection";
import { RemoteFileStorage, IOS_STORE_DIR } from "../../src/platform/remote/RemoteFileStorage";
import { RemoteHost } from "../../src/platform/remote/RemoteHost";
import { DEFAULT_SETTINGS, type ModelKey } from "../../src/settings-data";
import type { GatewayConfig } from "../../src/platform/remote/transport";
import { nativeTransport } from "./native";
import { IosPlatform } from "./platform";
import { RemoteVaultFeatures } from "./vault";
import { IosChatShell, type ConnectivityPayload, type SharePayload } from "./shell";

/* The shared DEFAULT_SETTINGS.defaultModel is "sonnet-1m" (Sonnet 4.6 1M),
   which the CLI rejects on this account with "Usage credits required for 1M
   context": a 1M-context request is metered outside the subscription caps, so
   a fresh phone tab would fail on its very first send. The phone build prefers
   Opus Plan, the one ModelKey whose underlying run stays inside the plan
   (there is no non-1M Sonnet key to fall back to). Only the SEED changes: a
   model the user picked on this device (RemoteHost.loadDeviceSettings reads it
   from localStorage) always wins, and the plugin/desktop default is untouched. */
const IOS_DEFAULT_MODEL: ModelKey = "opus-plan";

function applyIosDefaultModel(host: RemoteHost): void {
  let chosen: unknown;
  try {
    const raw = window.localStorage.getItem("vaultgw.settings");
    chosen = raw ? (JSON.parse(raw) as { defaultModel?: unknown }).defaultModel : undefined;
  } catch {
    chosen = undefined;
  }
  if (typeof chosen === "string") return;
  if (host.settings.defaultModel === DEFAULT_SETTINGS.defaultModel) {
    host.settings.defaultModel = IOS_DEFAULT_MODEL;
  }
}

type DispatchName = "suspend" | "resume" | "connectivity" | "theme" | "safeArea" | "share";
type DispatchPayload = Record<string, unknown>;
type Handler = (name: DispatchName, payload: DispatchPayload) => void;

/* ---------------------------------------------------------------------------
   1. The native -> page channel, defined before anything can await.
   ------------------------------------------------------------------------ */

let liveHandler: Handler | null = null;
const queued: Array<[DispatchName, DispatchPayload]> = [];

function dispatch(name: string, payload?: DispatchPayload): void {
  const args: [DispatchName, DispatchPayload] = [name as DispatchName, payload ?? {}];
  if (liveHandler) {
    try { liveHandler(...args); } catch (err) { console.error("[vaultgw] dispatch failed", name, err); }
    return;
  }
  /* Bounded: native never sends a burst, and an unbounded queue during a
     failed boot would be a leak with no reader. */
  if (queued.length < 32) queued.push(args);
}

(window as unknown as { __vaultgw: { dispatch: typeof dispatch } }).__vaultgw = { dispatch };

function installHandler(handler: Handler): void {
  liveHandler = handler;
  const pending = queued.splice(0, queued.length);
  for (const [name, payload] of pending) {
    try { handler(name, payload); } catch (err) { console.error("[vaultgw] queued dispatch failed", name, err); }
  }
}

/* ---------------------------------------------------------------------------
   Viewport plumbing: safe areas and the software keyboard.
   ------------------------------------------------------------------------ */

function applySafeArea(insets: DispatchPayload): void {
  const root = document.documentElement;
  for (const side of ["top", "bottom", "left", "right"] as const) {
    const value = insets[side];
    if (typeof value === "number") root.style.setProperty(`--vgw-safe-${side}`, `${value}px`);
  }
}

/* `--kb-inset` is the height the software keyboard covers. visualViewport is
   the only thing on iOS that reports it: the layout viewport does not shrink,
   so a composer pinned to the bottom would sit UNDER the keyboard without
   this. Applied on resize and scroll because iOS fires scroll (not resize)
   when the keyboard's accessory bar animates. */
function wireKeyboardInset(): void {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    /* WebKit scrolls the layout viewport to reveal a focused input even when
       the document cannot scroll (html/body are `overflow: hidden` and
       scrollHeight === clientHeight here). That scroll is pure damage: it
       drags the sticky header up under the Dynamic Island, and it lands in
       `vv.offsetTop`, where subtracting it computed a keyboard inset of 0 and
       left the composer behind the accessory bar. Pin the scroll back to the
       top and measure the keyboard as the plain layout-vs-visual difference.
       Measured on iPhone 17 Pro: innerHeight 874, vv.height 806 with the
       hardware-keyboard accessory bar up, so the inset is 68. */
    if (window.scrollY !== 0) window.scrollTo(0, 0);
    const scroller = document.scrollingElement;
    if (scroller && scroller.scrollTop !== 0) scroller.scrollTop = 0;
    const inset = Math.max(0, window.innerHeight - vv.height);
    document.documentElement.style.setProperty("--kb-inset", `${Math.round(inset)}px`);
  };
  vv.addEventListener("resize", apply);
  vv.addEventListener("scroll", apply);
  /* focusin fires before the keyboard animation, scroll fires during it; both
     have to re-pin or the header spends the animation off-screen. */
  window.addEventListener("focusin", apply);
  window.addEventListener("scroll", apply, { passive: true });
  apply();
}

/* Hover-revealed surfaces need a tap equivalent on a touch screen. The cost
   pill already toggles on click (InputBox wires both); the context-window
   donut only reveals its "Nk / Mk" chip on mouseenter, so a delegated click
   toggles it here rather than forking InputBox. */
function wireTouchToggles(): void {
  document.addEventListener("click", (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const pill = target.closest<HTMLElement>(".claudian-toolbar-pill");
    if (!pill) return;
    const wrapper = pill.closest<HTMLElement>(".claudian-input-wrapper") ?? document.body;
    const chip = wrapper.querySelector<HTMLElement>(".claudian-context-window-chip");
    if (!chip || !pill.querySelector(".claudian-usage-percent")) return;
    if (!chip.textContent) return;
    chip.style.display = chip.style.display === "none" || !chip.style.display ? "" : "none";
  });
}

function renderBootError(mount: HTMLElement, title: string, detail: string): void {
  mount.textContent = "";
  const wrap = document.createElement("div");
  wrap.className = "vaultgw-boot-error";
  const h = document.createElement("h3");
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = detail;
  wrap.append(h, p);
  mount.append(wrap);
}

/* A boot that failed because the Mac was unreachable is not permanent: the
   daemon comes back, the tunnel comes back, and the phone should follow
   without the user force-quitting the app. Watch both signals, native's
   /health probe (dispatched as `connectivity`) and our own poll for the case
   where the page is running without a native banner, then reload once the
   gateway answers. Installed only on the failure paths, which return
   immediately after, so it can never race the real handler. */
function armBootRetry(probe: () => Promise<boolean>): void {
  let reloading = false;
  const retry = async () => {
    if (reloading) return;
    if (!(await probe())) return;
    reloading = true;
    window.location.reload();
  };
  installHandler((name, payload) => {
    if (name === "connectivity" && payload.state === "ok") void retry();
    if (name === "resume") void retry();
  });
  window.setInterval(() => void retry(), BOOT_RETRY_MS);
}

const BOOT_RETRY_MS = 10_000;

/* ShareInbox.swift (iOS Share Extension, via NativeBridge.dispatch("share", …))
   and DebugLaunchEnvironment's VAULTGW_AUTOSEND both send this shape. Narrows
   the untyped DispatchPayload defensively — a malformed image entry (missing
   field, wrong type) is dropped rather than reaching InputBox.addImageAttachments
   with a shape it doesn't expect. */
function parseSharePayload(payload: DispatchPayload): SharePayload {
  const text = typeof payload.text === "string" && payload.text ? payload.text : undefined;
  const rawImages = Array.isArray(payload.images) ? payload.images : [];
  const images = rawImages.filter(
    (img): img is { mediaType: string; dataUri: string } =>
      !!img && typeof img === "object"
      && typeof (img as Record<string, unknown>).mediaType === "string"
      && typeof (img as Record<string, unknown>).dataUri === "string",
  );
  return { text, images: images.length > 0 ? images : undefined };
}

/* ---------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------ */

async function boot(): Promise<void> {
  installDomHelpers();
  wireKeyboardInset();
  wireTouchToggles();

  const app = document.getElementById("app");
  if (!app) return;

  const transport = nativeTransport();

  let config: GatewayConfig | null = null;
  try {
    config = await transport.getConfig();
  } catch {
    config = null;
  }
  if (config) {
    applySafeArea(config.safeArea as unknown as DispatchPayload);
    document.documentElement.setAttribute("data-theme", config.theme ?? "dark");
  }

  const conn = new GatewayConnection(transport);
  const storage = new RemoteFileStorage(conn);
  const vaultFeatures = new RemoteVaultFeatures(conn);

  /* Persistence.flushSync() is the quit-time synchronous pass. Nothing here is
     filesystem-backed (basePath() is null), so declare the writer absent
     rather than letting the lazy `globalThis.require` probe run. */
  setSyncFileWriter(null);
  initializePlatform(new IosPlatform({ storage, vaultFeatures, transport }));

  const health = await conn.rpc("GET", "/health");
  if (health.status === 401) {
    conn.markUnauthorized();
    renderBootError(
      app,
      "Gateway rejected the token",
      transport.isNative
        ? "Re-enter the bearer token in Settings, then reopen this screen."
        : "Set localStorage['vaultgw.dev.token'] to the contents of ~/.config/vault-gateway/token and reload.",
    );
    return;
  }
  if (health.status === 0) {
    renderBootError(
      app,
      "Can't reach the gateway",
      `${health.message ?? health.error ?? "No route to the Mac."} Check Tailscale and that the Mac is awake.`,
    );
    armBootRetry(async () => {
      const again = await conn.rpc("GET", "/health");
      return again.status === 200;
    });
    return;
  }
  /* `starting` is a WAIT, not a failure: a cold iCloud vault under launchd has
     been measured taking ~33 s to read its store. Poll rather than erroring. */
  if ((health.json as { state?: unknown } | undefined)?.state === "starting") {
    renderBootError(app, "Waking the gateway", "The Mac is still opening the vault. This can take up to a minute.");
    await waitForReady(conn);
    app.textContent = "";
  }

  const host = new RemoteHost(conn, transport, storage);
  applyIosDefaultModel(host);
  await host.prime();
  vaultFeatures.start();

  const persistence = new Persistence(null, IOS_STORE_DIR);
  const shell = new IosChatShell(app as HTMLElement, host, conn, persistence, storage, transport);

  installHandler((name, payload) => {
    switch (name) {
      case "suspend":
        /* Close the socket and hand native the cursor snapshot synchronously —
           the app is backgrounding and no timer of ours will fire again.
           Composer draft text sits behind TWO debounces (InputBox's own
           500ms, then Persistence.scheduleSaveTab's separate 500ms) and
           neither one fires once backgrounded — this WebView's timers are
           suspended the instant the app leaves the foreground, and
           Persistence.flushSync() (the desktop quit-time escape hatch) is a
           no-op here since RemoteFileStorage has no basePath. Drain both,
           in order, before the socket goes down: flushActiveDraft() forces
           the composer's debounce out synchronously (arming
           Persistence.scheduleSaveTab's pending write), then flush() fires
           that write immediately instead of waiting on its own timer. */
        shell.flushActiveDraft();
        void persistence.flush();
        conn.suspend();
        return;
      case "resume":
        conn.resume();
        void vaultFeatures.refresh();
        return;
      case "connectivity":
        shell.setConnectivity(payload as ConnectivityPayload);
        return;
      case "theme": {
        const theme = payload.theme;
        if (typeof theme === "string") document.documentElement.setAttribute("data-theme", theme);
        return;
      }
      case "safeArea":
        applySafeArea(payload);
        return;
      case "share": {
        /* Routed through handleShare (not insertIntoComposer directly) so a
           share arriving before shell.mount() finishes — always true on a
           cold launch, since the WebKit IPC round-trip for
           evaluateJavaScript beats boot()'s network calls that precede
           installHandler — is buffered and replayed once the composer DOM
           actually exists, instead of silently no-oping against an empty
           `#app`. See IosChatShell.handleShare (ios-web/src/shell.ts). */
        shell.handleShare(parseSharePayload(payload));
        return;
      }
      default:
        return;
    }
  });

  await shell.mount();
  await conn.connect();

  /* The page going away without a `suspend` (dev reload, a WebView the OS
     reclaimed) still owes native its cursor snapshot — and the same
     draft-flush the "suspend" dispatch does above, for the same reason. */
  window.addEventListener("pagehide", () => {
    shell.flushActiveDraft();
    void persistence.flush();
    conn.suspend();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") conn.resume();
  });
}

async function waitForReady(conn: GatewayConnection): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await new Promise(r => setTimeout(r, 1500));
    const res = await conn.rpc("GET", "/health");
    if ((res.json as { state?: unknown } | undefined)?.state === "ready") return;
  }
}

void boot().catch(err => {
  console.error("[vaultgw] boot failed", err);
  const app = document.getElementById("app");
  if (app) renderBootError(app, "Something went wrong starting up", String(err instanceof Error ? err.message : err));
});

/* Not dead code: the platform singleton is what every shared module reaches
   for, and referencing it here keeps the import from being tree-shaken in a
   build where nothing else in this file touches it directly. */
void platform;
