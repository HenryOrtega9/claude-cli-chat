/* GatewayConnection — the single WebSocket the whole client shares.

   One socket, many tabs. The daemon multiplexes every tab's frames down one
   connection (CONTRACTS.md "WebSocket /ws/<ticket>"), so opening one per tab
   would burn tickets, replay buffers and battery for nothing. This class owns:

     - the socket itself (ticket mint -> connect -> `subscribe`)
     - reconnection with exponential backoff and a resubscribe that carries
       each tab's `since` cursor, so a tunnel/lock-screen gap replays exactly
       the frames that were missed
     - a 30 s `ping` heartbeat with a pong deadline, because a TCP connection
       through a sleeping Mac stays "open" long after it has stopped carrying
       anything
     - `lastSeq` per tab, mirrored to native via `setState` (throttled) so the
       app can arm a background `/wait` after the page is gone
     - `resync` fan-out: the daemon telling us its replay ring no longer
       reaches back far enough, which the shell answers by rebuilding the tab
       from `GET /tabs/:id`

   What it deliberately does NOT own: sending turns, approvals, aborts and
   patches. Those go over HTTP (`POST /tabs/:id/turn`, `/approve`, `/abort`,
   `PATCH /tabs/:id`) even though the socket accepts them, because HTTP gives
   back a status code — 409 `busy`, 503 `no_capacity`, 404 `no_such_tab` — and
   the socket's error frame does not tell you which request it belonged to.

   No node here: `WebSocket` is the browser one (WKWebView's, or the desktop
   browser's in dev). Node's global WebSocket must never be used against this
   daemon — see the caveat in CONTRACTS.md. */

import type { GatewayTransport } from "./transport";

export type FrameType =
  | "hello"
  | "event"
  | "tab_status"
  | "approval_request"
  | "approval_resolved"
  | "turn_done"
  | "catalog"
  | "resync"
  | "pong"
  | "error";

export type Frame = {
  v: number;
  seq: number;
  tab: string | null;
  t: FrameType | string;
  payload: Record<string, unknown>;
};

export type LinkState =
  | "connecting"
  | "open"
  /* Socket is down and a retry is scheduled. */
  | "reconnecting"
  /* Deliberately closed (native `suspend`, page teardown). No retry pending. */
  | "suspended"
  /* The daemon answered but refused us: a bad/absent bearer token. Retrying
     changes nothing, so the backoff stops and the UI has to say so. */
  | "unauthorized";

type FrameListener = (frame: Frame) => void;

const PING_INTERVAL_MS = 30_000;
const PONG_DEADLINE_MS = 10_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;
const STATE_THROTTLE_MS = 2_000;

export class GatewayConnection {
  private ws: WebSocket | null = null;
  private link: LinkState = "suspended";
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  /* Set while connect() is in flight so a burst of resume/visibility events
     cannot open three sockets against three tickets. */
  private connecting = false;

  /* Per-tab cursor. Seeded from `GET /tabs/:id` on restore and advanced by
     every frame we actually deliver, so a reconnect asks for exactly the gap.
     `hello` (seq 0, tab null) never touches it. */
  private readonly lastSeq = new Map<string, number>();
  private readonly busyTabs = new Set<string>();
  private readonly tabTitles = new Map<string, string>();
  private activeTabId: string | null = null;

  private readonly tabListeners = new Map<string, Set<FrameListener>>();
  private readonly anyListeners = new Set<FrameListener>();
  private readonly linkListeners = new Set<(state: LinkState) => void>();
  private readonly resyncListeners = new Set<(tabId: string) => void>();

  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private stateDirty = false;

  constructor(private readonly transport: GatewayTransport) {}

  /* ----- subscriptions --------------------------------------------------- */

  onTabFrame(tabId: string, cb: FrameListener): () => void {
    let set = this.tabListeners.get(tabId);
    if (!set) {
      set = new Set();
      this.tabListeners.set(tabId, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
      if (set && set.size === 0) this.tabListeners.delete(tabId);
    };
  }

  onAnyFrame(cb: FrameListener): () => void {
    this.anyListeners.add(cb);
    return () => this.anyListeners.delete(cb);
  }

  onLinkState(cb: (state: LinkState) => void): () => void {
    this.linkListeners.add(cb);
    cb(this.link);
    return () => this.linkListeners.delete(cb);
  }

  onResync(cb: (tabId: string) => void): () => void {
    this.resyncListeners.add(cb);
    return () => this.resyncListeners.delete(cb);
  }

  get linkState(): LinkState {
    return this.link;
  }

  /* ----- cursors + native state ------------------------------------------ */

  /* Seed a tab's cursor from a REST read (`GET /tabs/:id` carries `lastSeq`).
     Never rewinds: a live frame that arrived while the fetch was in flight has
     already been rendered, and replaying it would duplicate the message. */
  seedSeq(tabId: string, seq: number): void {
    if (!Number.isFinite(seq)) return;
    const prev = this.lastSeq.get(tabId) ?? 0;
    if (seq > prev) {
      this.lastSeq.set(tabId, seq);
      this.markStateDirty();
    }
  }

  seqFor(tabId: string): number {
    return this.lastSeq.get(tabId) ?? 0;
  }

  forgetTab(tabId: string): void {
    this.lastSeq.delete(tabId);
    this.busyTabs.delete(tabId);
    this.tabTitles.delete(tabId);
    this.tabListeners.delete(tabId);
    this.markStateDirty();
  }

  setActiveTab(tabId: string | null): void {
    if (this.activeTabId === tabId) return;
    this.activeTabId = tabId;
    this.markStateDirty();
  }

  setTabBusy(tabId: string, busy: boolean): void {
    const had = this.busyTabs.has(tabId);
    if (busy === had) return;
    if (busy) this.busyTabs.add(tabId);
    else this.busyTabs.delete(tabId);
    this.markStateDirty();
  }

  setTabTitle(tabId: string, title: string): void {
    if (this.tabTitles.get(tabId) === title) return;
    this.tabTitles.set(tabId, title);
    this.markStateDirty();
  }

  /* Coalesced: every streamed frame advances lastSeq, and a bridge round trip
     per token would be absurd. Trailing edge only, so the value native ends up
     holding is always the newest one. */
  private markStateDirty(): void {
    this.stateDirty = true;
    if (this.stateTimer !== null) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      if (this.stateDirty) this.flushState();
    }, STATE_THROTTLE_MS);
  }

  /* Push the cursor snapshot to native immediately. The `suspend` dispatch
     calls this directly: the app is about to background and the throttle's
     trailing timer would never fire. */
  flushState(): void {
    this.stateDirty = false;
    const lastSeq: Record<string, number> = {};
    for (const [id, seq] of this.lastSeq) lastSeq[id] = seq;
    const tabTitles: Record<string, string> = {};
    for (const [id, title] of this.tabTitles) tabTitles[id] = title;
    try {
      this.transport.setState({
        activeTabId: this.activeTabId,
        lastSeq,
        busyTabs: Array.from(this.busyTabs),
        tabTitles,
      });
    } catch {
      /* best-effort: the bridge being unavailable must never break the UI */
    }
  }

  /* ----- HTTP ------------------------------------------------------------- */

  rpc(method: string, path: string, body?: unknown) {
    return this.transport.rpc(method, path, body);
  }

  /* ----- socket lifecycle -------------------------------------------------- */

  async connect(): Promise<void> {
    if (this.connecting) return;
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;
    this.connecting = true;
    this.clearRetry();
    this.setLink(this.attempt === 0 ? "connecting" : "reconnecting");
    let url: string | null = null;
    try {
      url = await this.transport.wsUrl();
    } catch {
      url = null;
    }
    this.connecting = false;
    if (!url) {
      this.scheduleRetry();
      return;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = socket;
    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.attempt = 0;
      this.setLink("open");
      this.sendSubscribe();
      this.startHeartbeat();
    };
    socket.onmessage = (ev: MessageEvent) => {
      if (this.ws !== socket) return;
      if (typeof ev.data !== "string") return;
      this.handleRaw(ev.data);
    };
    socket.onerror = () => {
      /* `close` always follows; retry scheduling lives there so a socket that
         errors and closes does not schedule two retries. */
    };
    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.stopHeartbeat();
      if (this.link === "suspended" || this.link === "unauthorized") return;
      this.scheduleRetry();
    };
  }

  /* Native `suspend`, or the page unloading. Closes deliberately so onclose
     does not schedule a retry the backgrounded app can never service. */
  suspend(): void {
    this.setLink("suspended");
    this.clearRetry();
    this.stopHeartbeat();
    const socket = this.ws;
    this.ws = null;
    this.connecting = false;
    try { socket?.close(1000, "suspend"); } catch { /* already gone */ }
    this.flushState();
  }

  /* Native `resume`. Resets the backoff — the app being foregrounded is new
     information, not another failed attempt. */
  resume(): void {
    if (this.link === "open") return;
    this.attempt = 0;
    void this.connect();
  }

  dispose(): void {
    this.suspend();
    this.tabListeners.clear();
    this.anyListeners.clear();
    this.linkListeners.clear();
    this.resyncListeners.clear();
    if (this.stateTimer !== null) {
      clearTimeout(this.stateTimer);
      this.stateTimer = null;
    }
  }

  private sendSubscribe(): void {
    const since: Record<string, number> = {};
    for (const [id, seq] of this.lastSeq) since[id] = seq;
    this.sendRaw({ t: "subscribe", tabs: "all", since });
  }

  private sendRaw(msg: Record<string, unknown>): boolean {
    const socket = this.ws;
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (!this.sendRaw({ t: "ping" })) return;
      if (this.pongTimer !== null) return;
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        /* No pong inside the deadline: the socket is a zombie (Mac asleep,
           NAT dropped the flow). Tear it down so onclose retries. */
        try { this.ws?.close(4000, "pong_timeout"); } catch { /* ignore */ }
      }, PONG_DEADLINE_MS);
    }, PING_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== null) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pongTimer !== null) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  private scheduleRetry(): void {
    if (this.link === "suspended" || this.link === "unauthorized") return;
    this.clearRetry();
    this.setLink("reconnecting");
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    /* Jitter so a daemon restart doesn't get every client back at once. */
    const jittered = delay * (0.75 + Math.random() * 0.5);
    this.attempt = Math.min(this.attempt + 1, 8);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, jittered);
  }

  /* Called by the shell when a REST probe comes back 401: no amount of
     retrying fixes a missing token, and a spinning reconnect hides that. */
  markUnauthorized(): void {
    this.setLink("unauthorized");
    this.clearRetry();
    this.stopHeartbeat();
    try { this.ws?.close(1000, "unauthorized"); } catch { /* ignore */ }
    this.ws = null;
  }

  private setLink(state: LinkState): void {
    if (this.link === state) return;
    this.link = state;
    for (const cb of this.linkListeners) {
      try { cb(state); } catch { /* a listener must not break the socket */ }
    }
  }

  /* ----- inbound ----------------------------------------------------------- */

  private handleRaw(text: string): void {
    let frame: Frame;
    try {
      frame = JSON.parse(text) as Frame;
    } catch {
      return;
    }
    if (!frame || typeof frame !== "object" || typeof frame.t !== "string") return;

    if (frame.t === "pong") {
      if (this.pongTimer !== null) { clearTimeout(this.pongTimer); this.pongTimer = null; }
      return;
    }

    if (frame.t === "hello") {
      /* Seed cursors for tabs we have never seen so a first connect after a
         daemon restart does not replay an entire conversation into a UI that
         already rendered it from `GET /tabs/:id`. */
      const tabs = Array.isArray(frame.payload?.tabs) ? frame.payload.tabs : [];
      for (const entry of tabs as Array<{ id?: unknown; lastSeq?: unknown }>) {
        if (typeof entry?.id !== "string") continue;
        if (!this.lastSeq.has(entry.id) && typeof entry.lastSeq === "number") {
          this.lastSeq.set(entry.id, entry.lastSeq);
        }
      }
    }

    const tabId = typeof frame.tab === "string" ? frame.tab : null;
    if (tabId && typeof frame.seq === "number" && frame.seq > 0) {
      const prev = this.lastSeq.get(tabId) ?? 0;
      /* Frames are per-tab monotonic. A frame at or below the cursor is a
         duplicate (a replay racing a live frame) and must not be delivered
         twice — TabController would render the same assistant delta again. */
      if (frame.seq <= prev) return;
      this.lastSeq.set(tabId, frame.seq);
      this.markStateDirty();
    }

    if (frame.t === "resync" && tabId) {
      for (const cb of this.resyncListeners) {
        try { cb(tabId); } catch { /* ignore */ }
      }
      return;
    }

    for (const cb of this.anyListeners) {
      try { cb(frame); } catch { /* ignore */ }
    }
    if (!tabId) return;
    const set = this.tabListeners.get(tabId);
    if (!set) return;
    for (const cb of Array.from(set)) {
      try { cb(frame); } catch (err) { console.warn("[vaultgw] frame listener threw", err); }
    }
  }
}
