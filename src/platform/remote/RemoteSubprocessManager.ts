/* RemoteSubprocessManager / RemoteTabSession — the engine seam for the phone.

   `TabController` was written against a `claude` child process it owns. On the
   phone that child lives on the Mac, inside the gateway daemon, and the only
   thing crossing the tailnet is a frame stream. `SubprocessManagerLike` /
   `TabSessionLike` (src/platform/engine.ts) are exactly the member surface the
   controller touches, so implementing them over the gateway makes the whole
   shared view layer work unmodified.

   The mapping, member by member:

     spawn(tabId, opts)   ensure the daemon's tab carries this tab's
                          model / effort / permissionMode (PATCH /tabs/:id).
                          No child starts here — the daemon spawns lazily on
                          the first turn and respawns with `--resume` after an
                          LRU eviction, which is invisible from up here.
     sendUserText/Content POST /tabs/:id/turn
     approve / deny       POST /tabs/:id/approve
     dispose()            POST /tabs/:id/abort  (the desktop kills the child on
                          a model change; abort is the daemon's equivalent, and
                          the next turn resumes the same session id)
     onEvent              `event` frames, raw stream-json, in seq order
     onExit               `tab_status` status "exited" / "error"
     onStderr             `tab_status.stderrTail`, deduped against what we've
                          already forwarded
     getPendingApprovals  `approval_request` frames minus `approval_resolved`
                          received while THIS session object has been alive
                          — see `fetchPendingApprovals` below for the gap
                          that leaves (a still-pending approval from before
                          this process/session existed) and `onApprovalResolved`
                          for the other half (a resolution this client's UI
                          never saw because it happened over HTTP, from a
                          notification action, while the socket was down).

   Two semantics from `TabSession` are replicated deliberately, because
   TabController depends on both (see its listener binding, ~line 1080):

     1. The `earlyErrors` queue. Errors that fire before `onError()` is
        registered are queued and drained on the first registration, so a
        failure during the synchronous window between `spawn()` and the
        controller wiring its listeners is not lost. The remote path has a
        WIDER window than the local one (the tab-ensure round trip is async),
        so this matters more here, not less. The same queueing is applied to
        events and exits for the same reason.
     2. Listener identity. `spawn()` returns the EXISTING session for a tab
        unless it is terminal, and listeners accumulate — TabController guards
        every callback with `if (this.session === s)`, so a stale session's
        frames are dropped by the controller rather than by us.

   There is no node in this file and there must never be: `NodeJS.Signals` is
   type-only (it reaches us through engine.ts's `TabSessionLike`). */

import type {
  ContentBlock,
  ControlRequestEvent,
  SpawnOptions,
  StreamEvent,
  SubprocessManagerLike,
  RemoteControlSessionLike,
  TabSessionLike,
  TabSessionStatus,
} from "../engine";
import { MODEL_IDS, type ModelKey } from "../../settings-data";
import type { Frame, GatewayConnection } from "./GatewayConnection";

/* SpawnOptions.model is a resolved CLI model id ("claude-sonnet-4-6[1m]"),
   because that is what a local spawn puts on the command line. The daemon
   accepts either an id or a picker key, but it PERSISTS whatever it is given
   and hands it back on GET /tabs/:id — and the composer's model pill can only
   render a key. Storing an id there produces a tab that reloads with an
   unlabelable model, so the id is mapped back to its key before it is sent.
   An id with no key (a hand-driven HTTP caller, a model added to the CLI but
   not to the picker) rides through unchanged: the daemon still resolves it,
   and the restore path in the shell sanitizes what the pill cannot show. */
function modelKeyForId(model: string): string {
  for (const key of Object.keys(MODEL_IDS) as ModelKey[]) {
    if (MODEL_IDS[key] === model) return key;
  }
  return model;
}

/* The daemon's tab status vocabulary is wider than TabSession's: it has an
   `idle` state for "alive, no child right now", which is what an LRU-evicted
   tab looks like. That is NOT terminal — the next turn respawns with
   `--resume` — so it maps to `ready`, the same thing the controller sees when
   a local child is sitting idle between turns. */
function mapStatus(gateway: string): TabSessionStatus {
  switch (gateway) {
    case "starting": return "starting";
    case "running": return "running";
    case "exited": return "exited";
    case "error": return "error";
    case "idle":
    case "ready":
    default: return "ready";
  }
}

type TabStatusPayload = {
  status?: string;
  sessionId?: string | null;
  pid?: number | null;
  model?: string | null;
  effort?: string | null;
  permissionMode?: string | null;
  exitCode?: number | null;
  stderrTail?: string;
  error?: string;
};

export class RemoteTabSession implements TabSessionLike {
  sessionId: string | null = null;
  status: TabSessionStatus = "starting";

  private pidValue: number | undefined = undefined;
  private disposed = false;
  private unsubscribe: (() => void) | null = null;

  private eventListeners: Array<(e: StreamEvent) => void> = [];
  private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  private errorListeners: Array<(err: Error) => void> = [];
  private stderrListeners: Array<(chunk: string) => void> = [];

  /* Drained on the first listener registration of each kind. See the header. */
  private earlyEvents: StreamEvent[] = [];
  private earlyExits: Array<[number | null, NodeJS.Signals | null]> = [];
  private earlyErrors: Error[] = [];
  private earlyStderr: string[] = [];

  private readonly pendingApprovals = new Map<string, ControlRequestEvent>();
  /* stderr arrives as a rolling tail on every status frame, not as a delta.
     Forwarding the whole tail each time would repeat the same bytes into the
     error bubble, so only the newly appended suffix goes out. */
  private lastStderrTail = "";
  /* Fired when an `approval_resolved` frame names a request this session
     still has pending. Exists because the ONLY thing `onFrame`'s
     "approval_resolved" case used to do was delete from `pendingApprovals` —
     silent bookkeeping nobody outside this class could observe. That was
     fine as long as every resolution happened locally (TabController's
     handleApproval already removes its own card optimistically before the
     frame round-trips back). It stopped being fine once TurnNotifier started
     resolving approvals straight over HTTP from a notification's Allow/Deny
     action while this client's UI never saw it: the card TabController is
     still showing has no way to learn the request was resolved out from
     under it. TabController wires this (see its `ensureSession()`) to clear
     the card and, on an allow, resume its thinking indicator — the same
     epilogue `handleApproval`'s own allow branch runs. */
  private readonly approvalResolvedListeners: Array<(requestId: string, allowed: boolean) => void> = [];
  /* Turn ids we minted, so a `turn_done` for someone else's turn (another
     client driving the same tab) is still delivered but never mistaken for
     our own submission failing. */
  private turnCounter = 0;

  constructor(
    private readonly conn: GatewayConnection,
    readonly tabId: string,
    opts: SpawnOptions,
  ) {
    this.unsubscribe = conn.onTabFrame(tabId, frame => this.onFrame(frame));
    void this.ensureTabConfig(opts);
  }

  get pid(): number | undefined {
    return this.pidValue;
  }

  /* ----- lifecycle -------------------------------------------------------- */

  /* Push this spawn's model / effort / permission mode at the daemon. The
     daemon applies engine-affecting patches on the NEXT respawn (contract), and
     `dispose()` — which the controller calls right before re-spawning on a
     model change — has already dropped the child, so the next turn comes up on
     the new settings. */
  private async ensureTabConfig(opts: SpawnOptions): Promise<void> {
    const body: Record<string, unknown> = {};
    if (opts.model) body.model = modelKeyForId(opts.model);
    if (opts.effort) body.effort = opts.effort;
    if (opts.permissionMode) body.permissionMode = opts.permissionMode;
    const res = await this.conn.rpc("PATCH", `/tabs/${encodeURIComponent(this.tabId)}`, body);
    if (this.disposed) return;
    if (res.status === 200) {
      /* Idle-but-alive is what a tab with no child looks like; the controller
         treats anything that is not exited/error as reusable. */
      if (this.status === "starting") this.status = "ready";
      return;
    }
    if (res.status === 404) {
      this.status = "error";
      this.emitError(new Error(`Chat ${this.tabId} no longer exists on the gateway.`));
      return;
    }
    if (res.status === 401) {
      this.status = "error";
      this.emitError(new Error("Gateway rejected the token (401). Re-enroll in Settings."));
      return;
    }
    if (res.status === 0) {
      /* Unreachable is not fatal: the connection layer is already retrying and
         the tab stays usable the moment the tunnel comes back. Stay
         non-terminal so the controller does not throw the session away. */
      this.status = "ready";
      return;
    }
    this.status = "error";
    this.emitError(new Error(`Gateway refused the tab update (HTTP ${res.status}).`));
  }

  isTerminal(): boolean {
    return this.disposed || this.status === "exited" || this.status === "error";
  }

  /* The desktop's dispose() SIGTERMs the child. The daemon's equivalent is
     `abort`: outstanding approvals are denied, the child is dropped, and the
     session id survives so the next turn resumes the conversation. Called on
     model/effort/mode changes, Esc-cancel, tab close and teardown — all four
     want exactly that. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pendingApprovals.clear();
    try {
      await this.conn.rpc("POST", `/tabs/${encodeURIComponent(this.tabId)}/abort`);
    } catch {
      /* Best-effort. A gateway we cannot reach will reap the child itself. */
    }
  }

  /* dispose() minus the /abort POST. Not part of TabSessionLike — TabController
     reaches for it structurally (see teardownSession's `opts.abort`), the same
     way it reaches for onApprovalResolved. Exists for the iOS shell's resync
     remount path (ios-web/src/shell.ts resyncTab): a resync is this CLIENT
     catching up (replay ring rolled over, another device cleared/reopened the
     tab) — it says nothing about whether the daemon's turn should stop, so
     destroying the old controller to remount a fresh one around the same tab
     must not abort a turn the Mac may still be generating for it. */
  detach(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.pendingApprovals.clear();
  }

  /* ----- outbound --------------------------------------------------------- */

  sendUserText(text: string): void {
    this.sendUserContent([{ type: "text", text }]);
  }

  sendUserContent(blocks: ContentBlock[]): void {
    this.turnCounter += 1;
    const clientTurnId = `${this.tabId}-${Date.now().toString(36)}-${this.turnCounter}`;
    void this.postTurn(blocks, clientTurnId);
  }

  private async postTurn(blocks: ContentBlock[], clientTurnId: string): Promise<void> {
    const res = await this.conn.rpc(
      "POST",
      `/tabs/${encodeURIComponent(this.tabId)}/turn`,
      { blocks, clientTurnId },
    );
    if (this.disposed) return;
    if (res.status === 202) {
      this.status = "running";
      return;
    }
    /* Every failure below must surface as an Error, because TabController's
       composer stays locked until something ends the turn — either a `result`
       event or the error path. A silent drop wedges the tab. */
    const err = this.turnError(res.status, res.json, res.error);
    this.emitError(err);
  }

  private turnError(status: number, json: unknown, transportError?: string): Error {
    const code = typeof (json as { error?: unknown })?.error === "string"
      ? (json as { error: string }).error
      : undefined;
    if (status === 0) {
      return new Error(`Can't reach the gateway (${transportError ?? "network error"}). The turn was not sent.`);
    }
    if (code === "busy") return new Error("That chat is already running a turn on the Mac.");
    if (code === "no_capacity") {
      return new Error("The gateway is at its child limit and every chat is busy. Try again in a moment.");
    }
    if (code === "no_such_tab") return new Error("That chat no longer exists on the gateway.");
    if (status === 401) return new Error("Gateway rejected the token (401). Re-enroll in Settings.");
    return new Error(`Gateway refused the turn (HTTP ${status}${code ? `, ${code}` : ""}).`);
  }

  approve(requestId: string, updatedInput?: Record<string, unknown>): void {
    this.pendingApprovals.delete(requestId);
    void this.postApproval({ request_id: requestId, allowed: true, updatedInput });
  }

  deny(requestId: string, reason?: string): void {
    this.pendingApprovals.delete(requestId);
    void this.postApproval({ request_id: requestId, allowed: false, reason });
  }

  private async postApproval(body: Record<string, unknown>): Promise<void> {
    const res = await this.conn.rpc("POST", `/tabs/${encodeURIComponent(this.tabId)}/approve`, body);
    if (this.disposed || res.status === 200) return;
    /* A 404 here is routine on the denial path: the gateway's approval
       deadline may have resolved the request already. Only shout when the
       request genuinely failed to land. */
    if (res.status === 0) {
      this.emitError(new Error("Can't reach the gateway; the approval was not delivered."));
    }
  }

  getPendingApprovals(): ControlRequestEvent[] {
    return Array.from(this.pendingApprovals.values());
  }

  /* See the field comment on `approvalResolvedListeners`. Not part of
     `TabSessionLike` — TabController reaches for it structurally (a plain
     optional-member check), so a local/desktop `TabSession` that has no such
     method is simply a no-op there. */
  onApprovalResolved(cb: (requestId: string, allowed: boolean) => void): () => void {
    this.approvalResolvedListeners.push(cb);
    return () => {
      const i = this.approvalResolvedListeners.indexOf(cb);
      if (i >= 0) this.approvalResolvedListeners.splice(i, 1);
    };
  }

  /* ----- inbound ---------------------------------------------------------- */

  private onFrame(frame: Frame): void {
    switch (frame.t) {
      case "event":
        this.emitEvent(frame.payload as unknown as StreamEvent);
        return;
      case "tab_status":
        this.onStatus(frame.payload as TabStatusPayload);
        return;
      case "approval_request": {
        /* The frame flattens the control_request (`{...request, request_id}`).
           The raw `control_request` StreamEvent also arrives as an `event`
           frame and is what TabController actually renders; this copy only
           feeds getPendingApprovals(). */
        const payload = frame.payload as Record<string, unknown>;
        const requestId = typeof payload.request_id === "string" ? payload.request_id : null;
        if (!requestId) return;
        const { request_id: _drop, ...request } = payload;
        this.pendingApprovals.set(requestId, {
          type: "control_request",
          request_id: requestId,
          request: request as ControlRequestEvent["request"],
        });
        return;
      }
      case "approval_resolved": {
        const payload = frame.payload as { request_id?: unknown; allowed?: unknown };
        const requestId = payload.request_id;
        if (typeof requestId !== "string") return;
        this.pendingApprovals.delete(requestId);
        const allowed = payload.allowed === true;
        for (const cb of this.approvalResolvedListeners) {
          try { cb(requestId, allowed); } catch (err) { console.warn("[vaultgw] approval-resolved listener threw", err); }
        }
        return;
      }
      default:
        return;
    }
  }

  private onStatus(payload: TabStatusPayload): void {
    if (typeof payload.sessionId === "string") this.sessionId = payload.sessionId;
    this.pidValue = typeof payload.pid === "number" ? payload.pid : undefined;

    if (typeof payload.stderrTail === "string") {
      const tail = payload.stderrTail;
      /* Forward only what is new. The daemon sends a rolling window, so the
         common case is "previous tail is a prefix of this one". */
      const delta = tail.startsWith(this.lastStderrTail)
        ? tail.slice(this.lastStderrTail.length)
        : tail;
      this.lastStderrTail = tail;
      if (delta) this.emitStderr(delta);
    }

    const next = mapStatus(payload.status ?? "");
    const wasTerminal = this.status === "exited" || this.status === "error";
    this.status = next;

    if (!wasTerminal && (next === "exited" || next === "error")) {
      if (typeof payload.error === "string" && payload.error) {
        this.emitError(new Error(payload.error));
      }
      const code = typeof payload.exitCode === "number" ? payload.exitCode : null;
      this.emitExit(code, null);
    }
  }

  /* ----- listener plumbing (mirrors TabSession) ---------------------------- */

  onEvent(cb: (e: StreamEvent) => void): void {
    this.eventListeners.push(cb);
    if (this.earlyEvents.length > 0) {
      const drained = this.earlyEvents.splice(0, this.earlyEvents.length);
      for (const e of drained) cb(e);
    }
  }

  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitListeners.push(cb);
    if (this.earlyExits.length > 0) {
      const drained = this.earlyExits.splice(0, this.earlyExits.length);
      for (const [code, signal] of drained) cb(code, signal);
    }
  }

  onError(cb: (err: Error) => void): void {
    this.errorListeners.push(cb);
    if (this.earlyErrors.length > 0) {
      const drained = this.earlyErrors.splice(0, this.earlyErrors.length);
      for (const err of drained) cb(err);
    }
  }

  onStderr(cb: (chunk: string) => void): void {
    this.stderrListeners.push(cb);
    if (this.earlyStderr.length > 0) {
      const drained = this.earlyStderr.splice(0, this.earlyStderr.length);
      for (const chunk of drained) cb(chunk);
    }
  }

  private emitEvent(e: StreamEvent): void {
    if (this.eventListeners.length === 0) { this.earlyEvents.push(e); return; }
    for (const cb of this.eventListeners) {
      try { cb(e); } catch (err) { console.warn("[vaultgw] event listener threw", err); }
    }
  }

  private emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitListeners.length === 0) { this.earlyExits.push([code, signal]); return; }
    for (const cb of this.exitListeners) {
      try { cb(code, signal); } catch (err) { console.warn("[vaultgw] exit listener threw", err); }
    }
  }

  private emitError(err: Error): void {
    if (this.errorListeners.length === 0) { this.earlyErrors.push(err); return; }
    for (const cb of this.errorListeners) {
      try { cb(err); } catch (e) { console.warn("[vaultgw] error listener threw", e); }
    }
  }

  private emitStderr(chunk: string): void {
    if (this.stderrListeners.length === 0) { this.earlyStderr.push(chunk); return; }
    for (const cb of this.stderrListeners) {
      try { cb(chunk); } catch (err) { console.warn("[vaultgw] stderr listener threw", err); }
    }
  }
}

export class RemoteSubprocessManager implements SubprocessManagerLike {
  private readonly sessions = new Map<string, RemoteTabSession>();
  /* Kept only to satisfy the interface. Remote Control is a PTY flow on the
     Mac and is not offered on the phone (see RemoteHost), so nothing ever
     claims a session file here — but a lying implementation that always
     returns `true` would be worse than an honest empty set. */
  private readonly claimedSessionFiles = new Set<string>();

  constructor(private readonly conn: GatewayConnection) {}

  spawn(tabId: string, opts: SpawnOptions): TabSessionLike {
    const existing = this.sessions.get(tabId);
    /* Same reuse guard as SubprocessManager.spawn: a live session is handed
       back so the controller's identity check keeps working, and only a
       terminal one is replaced. */
    if (existing && !existing.isTerminal()) return existing;
    const session = new RemoteTabSession(this.conn, tabId, opts);
    this.sessions.set(tabId, session);
    return session;
  }

  get(tabId: string): RemoteTabSession | undefined {
    return this.sessions.get(tabId);
  }

  /* Reconciliation for a gap `getPendingApprovals()` cannot close on its
     own: that method only ever reflects `approval_request` frames THIS
     session object was alive to receive. A tab that mounts fresh — a cold
     app relaunch, or a resync remount after the replay ring rolled over
     (`ios-web/src/shell.ts`'s `resyncTab`, which destroys and reconstructs
     the TabController) — starts a brand-new session with an empty cache,
     even though the daemon may still be sitting on an unresolved
     `approval_request` from before this process existed. There is no
     "replay everything since the beginning" HTTP call, so this fetches
     `GET /tabs/:id` instead and reads a `pendingApprovals` field.

     That field does NOT exist on the wire yet — verified against the
     current `storedTab()` in `scripts/gateway/src/engine.ts` (lines ~235-253
     as of this change), which returns id/sessionId/title/.../busy/status/
     lastSeq and nothing about `this.pending`. The daemon already computes
     the exact right shape for this in the same file:

       pendingApprovalFrames(): Array<Record<string, unknown>> {
         return Array.from(this.pending.values()).map(p => ({ ...p.req.request, request_id: p.req.request_id }));
       }

     — but nothing calls it. The one-line server-side fix is to add it to
     `storedTab()`:

       storedTab() {
         return {
           ...
           lastSeq: this.seq,
           pendingApprovals: this.pendingApprovalFrames(),
         };
       }

     No `server.ts` change is needed: `GET /tabs/:id`'s handler already
     returns `engine.storedTab()` verbatim (both the tab-scoped route and the
     no-op-tab-config-PATCH-then-GET path). Until that lands, this method
     always resolves `[]` (a missing/non-array field), which is a safe,
     honest empty result — reconciliation callers must already tolerate "no
     pending approvals" as the common case. */
  async fetchPendingApprovals(tabId: string): Promise<ControlRequestEvent[]> {
    const res = await this.conn.rpc("GET", `/tabs/${encodeURIComponent(tabId)}`);
    if (res.status !== 200) return [];
    const body = res.json as { pendingApprovals?: unknown } | undefined;
    const raw = Array.isArray(body?.pendingApprovals) ? body.pendingApprovals : [];
    const out: ControlRequestEvent[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const payload = entry as Record<string, unknown>;
      const requestId = payload.request_id;
      if (typeof requestId !== "string") continue;
      const { request_id: _drop, ...request } = payload;
      out.push({
        type: "control_request",
        request_id: requestId,
        request: request as ControlRequestEvent["request"],
      });
    }
    return out;
  }

  /* Remote Control is not available over the gateway; these exist because
     TabController calls them unconditionally on a tab it believes owns a
     remote session, and it never can here. */
  registerRemote(_tabId: string, _session: RemoteControlSessionLike): void { /* unsupported */ }
  unregisterRemote(_tabId: string): void { /* unsupported */ }

  claimSessionFile(path: string): boolean {
    if (this.claimedSessionFiles.has(path)) return false;
    this.claimedSessionFiles.add(path);
    return true;
  }

  isSessionFileClaimed(path: string): boolean {
    return this.claimedSessionFiles.has(path);
  }

  async disposeTab(tabId: string): Promise<void> {
    const session = this.sessions.get(tabId);
    this.sessions.delete(tabId);
    if (session) await session.dispose();
  }

  async disposeAll(): Promise<void> {
    const all = Array.from(this.sessions.values());
    this.sessions.clear();
    await Promise.all(all.map(s => s.dispose().catch(() => undefined)));
  }
}
