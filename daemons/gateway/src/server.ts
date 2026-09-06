/* The HTTP + WebSocket surface. Contract: docs/ios-gateway/CONTRACTS.md.

   Auth model, in one place so it can't drift:
   - Every HTTP request (including /health) needs `Authorization: Bearer
     <token>`, compared in constant time.
   - A WebSocket cannot carry an Authorization header from a browser, so the
     phone POSTs /ws-ticket over authenticated HTTP and connects to
     /ws/<ticket>. The ticket is single-use, expires in 60 s, and lives in the
     PATH rather than the query string so it never lands in a proxy access log
     the way `?ticket=` would.

   One socket multiplexes every tab. `subscribe` replays each tab's frames
   above the client's cursor and then streams live, so a backgrounded phone
   catches up with no gaps and no duplicates. */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { Duplex } from "node:stream";

import type { ContentBlock } from "../../../src/claude/Events";
import { PermissionsConfigStore, RECOMMENDED_ALLOW_PATTERNS } from "../../../src/permissions/PermissionsConfig";
import { MCPConfigStore } from "../../../src/mcp/MCPConfig";

import type { GatewayConfig } from "./config";
import { buildCatalog, type Catalog } from "./catalog";
import { BusyError, TabEngine } from "./engine";
import { makeFrame, type Frame } from "./frames";
import { readVaultFile, VaultIndex } from "./files";
import { NoCapacityError, TAB_ID_RE, TabRegistry } from "./registry";
import type { StateMirror } from "./state-mirror";
import type { TokenStore } from "./token";
import { UsageFetcher } from "./usage";
import { acceptUpgrade, isWebSocketUpgrade, rejectUpgrade, traceWs, type WsConnection } from "./ws";

const TICKET_TTL_MS = 60_000;
/* Catalog freshness: past this age a non-forced /catalog still answers from
   cache but triggers a background rebuild (stale-while-revalidate). */
const CATALOG_TTL_MS = 300_000;
/* Keep-warm cadence, deliberately under CATALOG_TTL_MS so a cold open never
   finds the cache stale in the first place. */
const CATALOG_KEEP_WARM_MS = 240_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const WAIT_MAX_S = 300;

type Subscription = {
  conn: WsConnection;
  /* "all" or an explicit id set. A client that only cares about the tab on
     screen still gets tab_status for the rest via the hello frame. */
  tabs: "all" | Set<string>;
  /* True while handleSubscribe's own replay loop is still in flight for this
     connection. broadcast() queues into `queue` instead of calling
     conn.send while this is set — see the comment in handleSubscribe for
     why "register the sub, then await the replay" alone doesn't guarantee
     ordering. */
  replaying: boolean;
  queue: string[];
};

type Waiter = {
  tab: string;
  since: number;
  resolve: (frame: Frame | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type ServerDeps = {
  config: GatewayConfig;
  registry: TabRegistry;
  token: TokenStore;
  mirror: StateMirror;
  claudePath: string;
  startedAt: number;
  version: string;
  isReady: () => boolean;
  log: (msg: string) => void;
};

export class GatewayServer {
  readonly http: Server;
  private subs = new Map<number, Subscription>();
  private tickets = new Map<string, number>();
  private waiters = new Set<Waiter>();
  private usage: UsageFetcher;
  private vaultIndex: VaultIndex;
  private catalogCache: Catalog | null = null;
  private catalogAt = 0;
  /* One build at a time: every reader (forced, cold, stale, keep-warm) that
     wants a rebuild while one is running shares this promise instead of
     spawning a second `claude mcp list`. */
  private catalogInflight: Promise<Catalog> | null = null;
  private catalogKeepWarm: NodeJS.Timeout | null = null;

  constructor(private deps: ServerDeps) {
    this.usage = new UsageFetcher(deps.log);
    this.vaultIndex = new VaultIndex(deps.config.vault);
    this.http = createServer((req, res) => {
      this.route(req, res).catch(err => {
        deps.log(`unhandled route error: ${String(err)}`);
        sendJson(res, 500, { error: "internal_error", message: String(err) });
      });
    });
    /* The third argument is bytes the HTTP parser already read past the
       request headers before handing the socket over -- see ws.ts's
       acceptUpgrade for why dropping it (the previous signature omitted it
       entirely) is a real, if usually-empty-in-practice, bug. */
    this.http.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    /* A phone that walks out of Wi-Fi leaves a half-open socket behind;
       without this the daemon accumulates them across a day of commuting. */
    this.http.keepAliveTimeout = 65_000;
    this.http.headersTimeout = 70_000;
  }

  listen(bind: string, port: number): Promise<void> {
    return new Promise(resolve => this.http.listen(port, bind, resolve));
  }

  /* Fan a frame out to every subscriber that wants it, and wake any /wait
     long-poll it satisfies. Called by the registry for every engine frame. */
  broadcast(frame: Frame): void {
    const line = JSON.stringify(frame);
    for (const sub of this.subs.values()) {
      if (sub.conn.closed) { this.subs.delete(sub.conn.id); continue; }
      if (frame.tab !== null && sub.tabs !== "all" && !sub.tabs.has(frame.tab)) continue;
      if (sub.replaying) { sub.queue.push(line); continue; }
      sub.conn.send(line);
    }
    if (frame.tab !== null && (frame.t === "turn_done" || frame.t === "approval_request")) {
      for (const waiter of Array.from(this.waiters)) {
        if (waiter.tab !== frame.tab || frame.seq < waiter.since) continue;
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
    }
  }

  async close(): Promise<void> {
    if (this.catalogKeepWarm) { clearInterval(this.catalogKeepWarm); this.catalogKeepWarm = null; }
    for (const sub of this.subs.values()) sub.conn.close(1001, "shutting_down");
    this.subs.clear();
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.resolve(null); }
    this.waiters.clear();
    await new Promise<void>(resolve => this.http.close(() => resolve()));
  }

  /* ---------- auth ---------- */

  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Bearer ")) return false;
    return this.deps.token.matches(header.slice(7).trim());
  }

  private mintTicket(): string {
    this.sweepTickets();
    const ticket = randomBytes(18).toString("base64url");
    this.tickets.set(ticket, Date.now() + TICKET_TTL_MS);
    return ticket;
  }

  private redeemTicket(ticket: string): boolean {
    this.sweepTickets();
    const expiry = this.tickets.get(ticket);
    if (expiry === undefined) return false;
    this.tickets.delete(ticket);          // single use, redeemed or not
    return expiry > Date.now();
  }

  private sweepTickets(): void {
    const now = Date.now();
    for (const [t, expiry] of this.tickets) if (expiry <= now) this.tickets.delete(t);
  }

  /* ---------- HTTP ---------- */

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (!this.authorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    /* --- static reads --- */
    if (method === "GET" && path === "/health") return this.getHealth(res);
    if (method === "GET" && path === "/catalog") return this.getCatalog(res, url);
    if (method === "GET" && path === "/usage") {
      const { status, body } = await this.usage.fetch();
      return sendJson(res, status, body);
    }
    if (method === "GET" && path === "/files") {
      const limit = clampInt(url.searchParams.get("limit"), 50, 1, 500);
      const files = await this.vaultIndex.search(url.searchParams.get("q") ?? "", limit);
      return sendJson(res, 200, { files });
    }
    if (method === "GET" && path === "/file") {
      const result = await readVaultFile(this.deps.config.vault, url.searchParams.get("path") ?? "");
      if (!result.ok) return sendJson(res, result.status, { error: result.error });
      return sendJson(res, 200, { path: result.path, text: result.text });
    }
    if (method === "GET" && path === "/wait") return this.getWait(res, url);

    /* --- permissions --- */
    if (method === "GET" && path === "/permissions") {
      const store = new PermissionsConfigStore(null);
      return sendJson(res, 200, { allow: await store.listAllow(), recommended: RECOMMENDED_ALLOW_PATTERNS });
    }
    if (method === "POST" && path === "/permissions/allow") {
      const body = await readJson(req);
      const patterns = Array.isArray(body?.patterns) ? (body.patterns as unknown[]).filter(p => typeof p === "string") as string[] : [];
      if (patterns.length === 0) return sendJson(res, 400, { error: "no_patterns" });
      const added = await new PermissionsConfigStore(null).addAllowMany(patterns);
      return sendJson(res, 200, { ok: true, added });
    }

    /* --- mcp --- */
    if (method === "POST" && path === "/mcp/disable") {
      const body = await readJson(req);
      const servers = Array.isArray(body?.servers) ? (body.servers as unknown[]).filter(s => typeof s === "string") as string[] : [];
      const store = new MCPConfigStore(null);
      const current = new Set(await store.getDisabledServerNames());
      const wanted = new Set(servers);
      for (const name of wanted) if (!current.has(name)) await store.setServerDisabled(name, true);
      for (const name of current) if (!wanted.has(name)) await store.setServerDisabled(name, false);
      /* The disable list feeds the catalog, so the cached one is now wrong.
         Rebuild in the background rather than nulling the cache and making
         the next reader (usually the phone, right after this toggle) pay
         for the `claude mcp list` spawn. */
      void this.rebuildCatalog().catch(() => undefined);
      return sendJson(res, 200, { ok: true, disabled: Array.from(wanted) });
    }

    /* --- ws ticket --- */
    if (method === "POST" && path === "/ws-ticket") {
      return sendJson(res, 200, { ticket: this.mintTicket(), expiresIn: TICKET_TTL_MS / 1000 });
    }

    /* --- conversations (History) ---
       Every conversation ever created, open or closed — the superset GET
       /tabs can't give you, because GET /tabs only lists tabs currently
       holding a slot in the OPEN index. Sourced straight from the same
       listConversations() the desktop's History modal already trusts, since
       the daemon's own Persistence instance is a real filesystem adapter
       (installNodePlatform) and remove() (DELETE /tabs/:id) leaves the
       conversation file and its meta sidecar on disk precisely so this stays
       true after a tab is closed. */
    if (method === "GET" && path === "/conversations") {
      const conversations = await this.deps.registry.persistence.listConversations();
      return sendJson(res, 200, { conversations });
    }

    /* --- tabs --- */
    if (path === "/tabs" && method === "GET") return sendJson(res, 200, this.deps.registry.index());
    if (path === "/tabs" && method === "POST") {
      const body = await readJson(req);
      const engine = this.deps.registry.create({
        title: typeof body?.title === "string" ? body.title : undefined,
        model: typeof body?.model === "string" ? body.model : undefined,
        effort: typeof body?.effort === "string" ? body.effort : undefined,
        permissionMode: typeof body?.permissionMode === "string" ? body.permissionMode : undefined,
        incognito: body?.incognito === true,
      });
      return sendJson(res, 200, { id: engine.id, sessionId: engine.establishedSessionId });
    }

    /* Revive a closed-but-persisted conversation from History. Handled BEFORE
       the generic tab lookup below, which 404s on anything not currently
       live — that lookup is exactly what a closed tab fails, and reopening
       one is the whole point of this route. Idempotent: reopening an already
       -open tab just returns its current projection. */
    const reopenMatch = /^\/tabs\/([^/]+)\/reopen$/.exec(path);
    if (reopenMatch && method === "POST") {
      /* The regex above matches the raw pathname, so a literal `..` segment
         is already gone by the time WHATWG URL parsed it into `path` — but a
         PERCENT-ENCODED one (`%2e%2e%2f`) is not, and only becomes `../..`
         after decodeURIComponent below. registry.reopen() hands the id
         straight to Persistence.loadTab, which has no containment check of
         its own, so an unvalidated id here is a path-traversal read (and,
         worse, a write: the traversal id gets persisted into tabs.json and a
         TabEngine starts appending to a ndjson outside the vault). Validate
         against the grammar the daemon actually mints before it ever reaches
         the registry. */
      const id = decodeURIComponent(reopenMatch[1]);
      if (!TAB_ID_RE.test(id)) return sendJson(res, 404, { error: "no_such_tab" });
      const engine = await this.deps.registry.reopen(id);
      if (!engine) return sendJson(res, 404, { error: "no_such_tab" });
      return sendJson(res, 200, engine.storedTab());
    }

    const tabMatch = /^\/tabs\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
    if (tabMatch) {
      const engine = this.deps.registry.get(decodeURIComponent(tabMatch[1]));
      if (!engine) return sendJson(res, 404, { error: "no_such_tab" });
      const sub = tabMatch[2];
      if (!sub) return this.tabResource(req, res, engine, method);
      switch (`${method} ${sub}`) {
        case "POST turn": return this.postTurn(req, res, engine);
        case "POST abort": {
          await engine.abort();
          return sendJson(res, 200, { ok: true });
        }
        /* "New chat" without losing the tab. DELETE + POST /tabs was the phone's
           only way to express this, which churned the tab id, dropped the chat
           out of History and — whenever the DELETE failed or another tab was
           open — left the old conversation to come back on the next restore. */
        case "POST clear": {
          const { sessionId, lastSeq } = await engine.clear();
          /* The index carries the title and the session id, both of which just
             changed. */
          await this.deps.registry.saveIndex();
          return sendJson(res, 200, { ok: true, sessionId, lastSeq });
        }
        case "POST approve": return this.postApprove(req, res, engine);
        case "POST title": return this.postTitle(res, engine);
        case "POST suggest": return this.postSuggest(res, engine);
        case "GET events": return this.getEvents(res, engine, url);
        default: return sendJson(res, 404, { error: "not_found" });
      }
    }

    sendJson(res, 404, { error: "not_found" });
  }

  private getHealth(res: ServerResponse): void {
    sendJson(res, 200, {
      state: this.deps.isReady() ? "ready" : "starting",
      version: this.deps.version,
      cwd: this.deps.config.vault,
      uptime_s: Math.round((Date.now() - this.deps.startedAt) / 1000),
      liveChildren: this.deps.registry.liveChildren(),
      maxChildren: this.deps.config.maxChildren,
      tabs: this.deps.registry.list().map(t => t.snapshot()),
    });
  }

  async catalog(force = false): Promise<Catalog> {
    /* Stale-while-revalidate: the disk scans are cheap but `claude mcp list`
       spawns a child that takes 3-4s in practice, and the phone awaits
       /catalog on every cold open. So a non-forced request answers from
       whatever cache exists immediately; if that copy is past
       CATALOG_TTL_MS it kicks off one background rebuild that lands for the
       next reader. Only a forced request or a fully cold daemon waits. */
    if (force) return this.rebuildCatalog();
    if (this.catalogCache) {
      if (Date.now() - this.catalogAt >= CATALOG_TTL_MS) void this.rebuildCatalog().catch(() => undefined);
      return this.catalogCache;
    }
    return this.rebuildCatalog();
  }

  /* Build (or join the in-flight build of) a fresh catalog and install it. */
  private rebuildCatalog(): Promise<Catalog> {
    if (this.catalogInflight) return this.catalogInflight;
    const build = buildCatalog(this.deps.config.vault, this.deps.claudePath, this.deps.log)
      .then(catalog => {
        this.catalogCache = catalog;
        this.catalogAt = Date.now();
        return catalog;
      })
      .finally(() => { if (this.catalogInflight === build) this.catalogInflight = null; });
    this.catalogInflight = build;
    return build;
  }

  /* Rebuild the catalog on a cadence under its TTL so the cache is never
     stale when a phone cold-opens. unref()'d: it must never be the thing
     keeping the process alive. Idempotent. */
  startCatalogKeepWarm(): void {
    if (this.catalogKeepWarm) return;
    this.catalogKeepWarm = setInterval(() => {
      void this.rebuildCatalog()
        .then(c => this.deps.log(`catalog keep-warm (hash ${c.hash}, ${c.mcpServers.length} mcp server(s))`))
        .catch(() => undefined);
    }, CATALOG_KEEP_WARM_MS);
    this.catalogKeepWarm.unref();
  }

  private async getCatalog(res: ServerResponse, url: URL): Promise<void> {
    const catalog = await this.catalog(url.searchParams.get("refresh") === "1");
    sendJson(res, 200, catalog);
  }

  private async tabResource(req: IncomingMessage, res: ServerResponse, engine: TabEngine, method: string): Promise<void> {
    if (method === "GET") return sendJson(res, 200, engine.storedTab());
    if (method === "PATCH") {
      const body = await readJson(req);
      engine.patch({
        title: typeof body?.title === "string" ? body.title : undefined,
        model: typeof body?.model === "string" ? body.model : undefined,
        effort: typeof body?.effort === "string" ? body.effort : undefined,
        permissionMode: typeof body?.permissionMode === "string" ? body.permissionMode : undefined,
        pinnedFilePaths: Array.isArray(body?.pinnedFilePaths) ? body.pinnedFilePaths as string[] : undefined,
        draft: typeof body?.draft === "string" ? body.draft : undefined,
      });
      if (body?.active === true) this.deps.registry.setActive(engine.id);
      await this.deps.registry.saveIndex();
      return sendJson(res, 200, { ok: true });
    }
    if (method === "DELETE") {
      await this.deps.registry.remove(engine.id);
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 405, { error: "method_not_allowed" });
  }

  private async postTurn(req: IncomingMessage, res: ServerResponse, engine: TabEngine): Promise<void> {
    const body = await readJson(req);
    const blocks = normalizeBlocks(body?.blocks);
    if (blocks.length === 0) return sendJson(res, 400, { error: "empty_turn" });
    try {
      await this.deps.registry.makeRoomFor(engine);
      await engine.prepareForTurn();
      const { turnId, seq } = engine.submit(blocks, typeof body?.clientTurnId === "string" ? body.clientTurnId : undefined);
      sendJson(res, 202, { turnId, seq });
    } catch (err) {
      if (err instanceof BusyError) return sendJson(res, 409, { error: "busy" });
      if (err instanceof NoCapacityError) {
        return sendJson(res, 503, { error: "no_capacity", message: "every live tab is busy or awaiting approval" });
      }
      throw err;
    }
  }

  private async postApprove(req: IncomingMessage, res: ServerResponse, engine: TabEngine): Promise<void> {
    const body = await readJson(req);
    const requestId = typeof body?.request_id === "string" ? body.request_id : "";
    if (!requestId) return sendJson(res, 400, { error: "missing_request_id" });
    const ok = engine.approve(
      requestId,
      body?.allowed === true,
      typeof body?.reason === "string" ? body.reason : undefined,
      body?.updatedInput && typeof body.updatedInput === "object" ? body.updatedInput as Record<string, unknown> : undefined,
    );
    if (!ok) return sendJson(res, 404, { error: "no_such_approval" });
    sendJson(res, 200, { ok: true });
  }

  private async postTitle(res: ServerResponse, engine: TabEngine): Promise<void> {
    const first = engine.firstUserMessage();
    if (!first) return sendJson(res, 400, { error: "no_messages" });
    /* Imported lazily: TitleGenerator spawns its own throwaway `claude
       --print`, and pulling it into the boot path would slow every start for
       a feature most tabs never use. */
    const { generateTitle } = await import("../../../src/claude/TitleGenerator");
    const title = await generateTitle({
      userMessage: first,
      assistantResponse: engine.firstAssistantMessage() ?? undefined,
      claudePath: this.deps.claudePath,
      model: "haiku",
      cwd: this.deps.config.vault,
      incognito: engine.incognito,
    });
    if (!title) return sendJson(res, 200, { title: engine.title });
    engine.setTitle(title);
    await this.deps.registry.saveIndex();
    sendJson(res, 200, { title });
  }

  /* The phone's half of the reply-suggestion pass: the desktop hosts run
     suggestReply in-process, the phone has no `claude` to spawn, so the
     daemon runs it against its own projection of the conversation. Fired
     after the turn has landed, so unlike title there is nothing to poll for. */
  private async postSuggest(res: ServerResponse, engine: TabEngine): Promise<void> {
    const exchange = engine.lastExchange();
    if (!exchange) return sendJson(res, 400, { error: "no_messages" });
    /* Lazy for the same reason as postTitle: a throwaway `claude --print`
       spawner most tabs never reach has no business in the boot path. */
    const { suggestReply } = await import("../../../src/claude/ReplySuggester");
    const suggestion = await suggestReply({
      userMessage: exchange.userMessage,
      assistantResponse: exchange.assistantResponse,
      claudePath: this.deps.claudePath,
      model: "haiku",
      cwd: this.deps.config.vault,
      incognito: engine.incognito,
    });
    sendJson(res, 200, { suggestion });
  }

  private async getEvents(res: ServerResponse, engine: TabEngine, url: URL): Promise<void> {
    const since = clampInt(url.searchParams.get("since"), 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(url.searchParams.get("limit"), 500, 1, 5000);
    const { frames, evicted, truncated } = await engine.replaySince(since, limit);
    sendJson(res, 200, { events: frames, lastSeq: engine.lastSeq, evicted, truncated });
  }

  /* Long-poll mirroring the watch bridge's /wait: the phone's background
     URLSession parks here and fires a local notification the moment a turn
     finishes or an approval is needed, without the app being awake. */
  private async getWait(res: ServerResponse, url: URL): Promise<void> {
    const tabId = url.searchParams.get("tab") ?? "";
    const engine = this.deps.registry.get(tabId);
    if (!engine) return sendJson(res, 404, { error: "no_such_tab" });
    const since = clampInt(url.searchParams.get("since"), 0, 0, Number.MAX_SAFE_INTEGER);
    const timeoutS = clampInt(url.searchParams.get("timeout"), 60, 1, WAIT_MAX_S);

    /* The waiter is registered BEFORE the "already happened?" probe below,
       not after: broadcast() can only wake a Waiter already sitting in
       `this.waiters`, and the probe's own replaySince() is a real await
       whenever it takes the disk path (or waits on a queued write). A
       turn_done or approval_request emitted in that window used to match
       neither the probe's snapshot nor a live waiter — the client silently
       waited out the full (up to 300s) timeout for the exact notification
       this endpoint exists to deliver promptly. Registering first and
       cancelling the waiter the moment the probe finds the event closes that
       window in both directions at no cost on the common path. */
    let aborted = false;
    const frame = await new Promise<Frame | null>(settle => {
      let done = false;
      const finish = (f: Frame | null, isAbort: boolean) => {
        if (done) return;
        done = true;
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        if (isAbort) aborted = true;
        settle(f);
      };
      const waiter: Waiter = {
        tab: tabId,
        since,
        resolve: f => finish(f, false),
        timer: setTimeout(() => finish(null, false), timeoutS * 1000),
      };
      this.waiters.add(waiter);

      /* The iOS client's TurnNotifier cancels this exact request on every
         foreground (scenePhase .active), aborting the connection without
         either the timer or a matching broadcast() ever firing. Without this,
         that leaves the waiter (and its timer) alive for up to WAIT_MAX_S,
         scanned by every broadcast() in the meantime, and eventually resolves
         into a write on a socket that's already gone. */
      res.once("close", () => finish(null, true));

      /* Answer immediately if the event being waited for already happened
         while the client was reconnecting. `since` is clamped to >= 0 above,
         so `since - 1` underflows to -1 exactly when a client's cursor is 0
         (a brand-new tab, or one it has never heard from). ReplayRing.since()
         treats anything below its floor (1) as "gap older than the ring" and,
         for -1 specifically, short-circuits straight to `evicted: true` with
         no frames — even when the ring holds every frame the tab has ever
         produced — because `since + 1 (0) < floor (1)` is true regardless of
         what is actually on disk. That silently defeated this fast path for
         every zero-cursor /wait: the exact case a phone hits parking a
         background wait on a tab whose first turn just finished, or an
         approval that just resolved, while it was reconnecting. Floor the
         argument at 0 so a zero cursor reads as "everything", matching the
         `>= since` semantics `already` below actually wants. */
      void engine.replaySince(Math.max(0, since - 1), 5000).then(({ frames }) => {
        const already = frames.find(f => (f.t === "turn_done" || f.t === "approval_request") && f.seq >= since);
        if (already) finish(already, false);
      });
    });

    if (aborted) return; // client already gone; nothing left to write to
    if (!frame) return sendJson(res, 202, { partial: true, error: "wait_timeout", lastSeq: engine.lastSeq });
    sendJson(res, 200, { frame, lastSeq: engine.lastSeq });
  }

  /* ---------- WebSocket ---------- */

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    /* This entire method is synchronous, deliberately: `conn.onMessage` and
       `sendHello` below must run in the same tick `acceptUpgrade` returns in,
       with nothing awaited in between, or a frame that arrives (or, for
       `head`, one that already arrived) before a later tick registers the
       listener is silently dropped -- exactly the bug that was found in
       test/ws-client.mjs's Client, whose `hello` listener was registered one
       microtask late. If this function ever grows an `await` before
       `sendHello`, that invariant breaks. */
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const match = /^\/ws\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (!match || !isWebSocketUpgrade(req)) {
        rejectUpgrade(socket, 400, "bad_request");
        return;
      }
      if (!this.redeemTicket(match[1])) {
        traceWs("?", `ticket rejected for ${match[1].slice(0, 8)}... (already redeemed, expired, or a duplicate connect racing the reconnect timer)`);
        rejectUpgrade(socket, 401, "invalid_ticket");
        return;
      }
      const conn = acceptUpgrade(req, socket, head);
      if (!conn) return;
      this.deps.log(`ws ${conn.id} connected`);
      traceWs(conn.id, "upgrade accepted, registering listeners + sending hello synchronously");

      /* Subscribe to nothing until the client says what it wants; the hello
         frame tells it every tab's cursor so it can ask precisely. */
      conn.onMessage(text => this.handleWsMessage(conn, text));
      conn.onClose(() => {
        this.subs.delete(conn.id);
        this.deps.log(`ws ${conn.id} closed`);
      });

      this.sendHello(conn);
      traceWs(conn.id, "hello sent");
    } catch (err) {
      /* A throw anywhere above (bad Host header, a registry read mid-mutation,
         etc.) used to propagate out of this http 'upgrade' event handler and
         land in main.ts's `uncaughtException` handler, which only logs --
         the process survives, but THIS socket never gets its 101 (or never
         gets its hello if the throw happened after) and just sits there
         until the client's own timeout gives up and retries. Catching here
         means a future bug in this path degrades to one failed connection
         (traced below) instead of a silent, unexplained stall. */
      traceWs("?", `handleUpgrade threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      this.deps.log(`ws upgrade handler threw: ${String(err)}`);
      try { socket.destroy(); } catch { /* already gone */ }
    }
  }

  /* Deliberately synchronous, reading catalogCache directly rather than
     `await`ing `this.catalog()`. This used to await the full catalog build —
     harmless on a warm cache (a 5-minute hit), but `buildCatalog()` shells
     out to `claude mcp list`, which the code's own comments elsewhere note
     "can take seconds when a remote connector is slow", and the cache is
     cold on every daemon restart (`catalogAt` starts at 0). Confirmed live
     against a real account with several MCP servers: the very first
     reconnect after a restart stalled well past 10s waiting on `hello` —
     which blocked not just `catalogHash` but the `tabs` list every
     reconnecting client needs to seed its cursors and resubscribe. Exactly
     the reconnect-after-Mac-sleep / network-switch path this daemon exists
     to make fast. `catalogHash` is a pure optimization (lets the client skip
     re-rendering its pickers when nothing changed) — a stale or null value
     here costs nothing beyond one redundant `/catalog` fetch, which
     `RemoteHost.prime()` already makes independently of `hello`. With the
     keep-warm timer running, `catalogCache` is only null in the window
     between daemon start and the first build landing. */
  private sendHello(conn: WsConnection): void {
    traceWs(conn.id, `sendHello: registry.list()=${this.deps.registry.list().length} tabs, catalogCache=${this.catalogCache ? "warm" : "cold"}`);
    conn.send(JSON.stringify(makeFrame("hello", null, 0, {
      serverStartedAt: this.deps.startedAt,
      tabs: this.deps.registry.list().map(t => ({ id: t.id, lastSeq: t.lastSeq, status: t.status })),
      catalogHash: this.catalogCache?.hash ?? null,
    })));
  }

  private handleWsMessage(conn: WsConnection, text: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(text) as Record<string, unknown>;
    } catch {
      conn.send(JSON.stringify(makeFrame("error", null, 0, { error: "bad_json" })));
      return;
    }
    const t = typeof msg.t === "string" ? msg.t : "";
    switch (t) {
      case "ping":
        conn.send(JSON.stringify(makeFrame("pong", null, 0, {})));
        return;
      case "subscribe":
        void this.handleSubscribe(conn, msg);
        return;
      case "turn":
        void this.handleWsTurn(conn, msg);
        return;
      case "approve": {
        const engine = this.engineFor(conn, msg.tab);
        if (!engine) return;
        engine.approve(
          String(msg.request_id ?? ""),
          msg.allowed === true,
          typeof msg.reason === "string" ? msg.reason : undefined,
          msg.updatedInput && typeof msg.updatedInput === "object" ? msg.updatedInput as Record<string, unknown> : undefined,
        );
        return;
      }
      case "abort": {
        const engine = this.engineFor(conn, msg.tab);
        if (engine) void engine.abort();
        return;
      }
      case "patch": {
        const engine = this.engineFor(conn, msg.tab);
        if (!engine) return;
        engine.patch({
          model: typeof msg.model === "string" ? msg.model : undefined,
          effort: typeof msg.effort === "string" ? msg.effort : undefined,
          permissionMode: typeof msg.permissionMode === "string" ? msg.permissionMode : undefined,
        });
        return;
      }
      default:
        conn.send(JSON.stringify(makeFrame("error", null, 0, { error: "unknown_message", t })));
    }
  }

  private engineFor(conn: WsConnection, tab: unknown): TabEngine | null {
    const engine = typeof tab === "string" ? this.deps.registry.get(tab) : null;
    if (!engine) {
      conn.send(JSON.stringify(makeFrame("error", typeof tab === "string" ? tab : null, 0, { error: "no_such_tab" })));
      return null;
    }
    return engine;
  }

  private async handleSubscribe(conn: WsConnection, msg: Record<string, unknown>): Promise<void> {
    const wanted = msg.tabs;
    const tabs: "all" | Set<string> = wanted === "all" || wanted === undefined
      ? "all"
      : new Set((Array.isArray(wanted) ? wanted : []).filter((x): x is string => typeof x === "string"));
    /* Register BEFORE replaying, with `replaying: true`: a frame produced
       during the replay await must land after the replayed ones, not vanish
       into a gap or jump ahead of them. "Both go out through conn.send in
       call order" only holds when replaySince() resolves without real I/O
       (the ring's fast path). On the disk branch it awaits `writeChain` and
       then a real file read — genuine event-loop yields a concurrent
       broadcast() can land inside. Queuing live frames on the sub instead of
       sending them straight through (see broadcast()) keeps them behind
       whatever this loop is about to replay, and the flush below sends them
       once every target has been replayed. */
    const sub: Subscription = { conn, tabs, replaying: true, queue: [] };
    this.subs.set(conn.id, sub);

    const since = (msg.since && typeof msg.since === "object" ? msg.since : {}) as Record<string, number>;
    const targets = this.deps.registry.list().filter(t => tabs === "all" || tabs.has(t.id));

    /* The client's `since` map names every tab it is tracking a cursor for,
       independent of whether this subscribe asked for "all" or an explicit
       list. A tab named there but absent from the registry entirely (deleted
       from another device while this client was disconnected, or a
       subscribe racing the daemon's own boot-time restore()) has no engine
       to replay from and produces no live frames ever again — the
       `evicted: true` signal below only fires for a tab the registry DOES
       still hold, whose ring happened to roll past the cursor. Without this,
       the client just hears silence for that tab forever: no resync, no
       error, the composer (if it was mid-turn) stays locked. Reusing the
       `resync` frame with reason "gone" routes through the client's existing
       resync handling rather than inventing a second signal it would also
       have to wire up. */
    const known = new Set(this.deps.registry.list().map(t => t.id));
    for (const tabId of Object.keys(since)) {
      if (known.has(tabId)) continue;
      conn.send(JSON.stringify(makeFrame("resync", tabId, 0, { reason: "gone" })));
    }

    for (const engine of targets) {
      const cursor = Number.isFinite(since[engine.id]) ? Number(since[engine.id]) : 0;
      if (cursor >= engine.lastSeq) continue;
      const { frames, evicted, truncated } = await engine.replaySince(cursor);
      /* Truncated (more frames existed above `cursor` than the replay's
         limit covers) must be treated exactly like evicted: rendering a
         partial replay as a complete one silently drops the tail of the gap
         with no signal to the client at all. */
      if (evicted || truncated) {
        conn.send(JSON.stringify(makeFrame("resync", engine.id, engine.lastSeq, { reason: "buffer_evicted" })));
        continue;
      }
      for (const frame of frames) {
        if (conn.closed) return;
        conn.send(JSON.stringify(frame));
      }
    }

    /* Every target's replay has now been read back and sent; live frames for
       this subscription queued in the meantime (see broadcast()) are safely
       newer than all of it. Stop queuing and flush them in arrival order. */
    sub.replaying = false;
    const queued = sub.queue;
    sub.queue = [];
    for (const line of queued) {
      if (conn.closed) return;
      conn.send(line);
    }
  }

  private async handleWsTurn(conn: WsConnection, msg: Record<string, unknown>): Promise<void> {
    const engine = this.engineFor(conn, msg.tab);
    if (!engine) return;
    const blocks = normalizeBlocks(msg.blocks);
    if (blocks.length === 0) {
      conn.send(JSON.stringify(makeFrame("error", engine.id, 0, { error: "empty_turn" })));
      return;
    }
    try {
      await this.deps.registry.makeRoomFor(engine);
      await engine.prepareForTurn();
      engine.submit(blocks, typeof msg.clientTurnId === "string" ? msg.clientTurnId : undefined);
    } catch (err) {
      const error = err instanceof BusyError ? "busy" : err instanceof NoCapacityError ? "no_capacity" : "turn_failed";
      conn.send(JSON.stringify(makeFrame("error", engine.id, 0, { error, message: String(err) })));
    }
  }
}

/* ---------- helpers ---------- */

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    /* No caching anywhere: every response here is either live state or a
       secret, and an intermediary caching /catalog would be a subtle bug. */
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/* Accepts either a ContentBlock[] or a bare string, so a minimal client can
   POST {"blocks":"hello"} without building the wire shape. Blocks that aren't
   one of the three types the CLI understands are dropped rather than
   forwarded — an unknown block makes the CLI reject the whole message. */
function normalizeBlocks(raw: unknown): ContentBlock[] {
  if (typeof raw === "string") return raw.trim() ? [{ type: "text", text: raw }] : [];
  if (!Array.isArray(raw)) return [];
  const out: ContentBlock[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      if (item.trim()) out.push({ type: "text", text: item });
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const block = item as { type?: string; text?: string; source?: unknown };
    if (block.type === "text" && typeof block.text === "string") out.push({ type: "text", text: block.text });
    else if ((block.type === "image" || block.type === "document") && block.source) out.push(item as ContentBlock);
  }
  return out;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
