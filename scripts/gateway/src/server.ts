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
import { NoCapacityError, TabRegistry } from "./registry";
import type { StateMirror } from "./state-mirror";
import type { TokenStore } from "./token";
import { UsageFetcher } from "./usage";
import { acceptUpgrade, isWebSocketUpgrade, rejectUpgrade, type WsConnection } from "./ws";

const TICKET_TTL_MS = 60_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const WAIT_MAX_S = 300;

type Subscription = {
  conn: WsConnection;
  /* "all" or an explicit id set. A client that only cares about the tab on
     screen still gets tab_status for the rest via the hello frame. */
  tabs: "all" | Set<string>;
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

  constructor(private deps: ServerDeps) {
    this.usage = new UsageFetcher(deps.log);
    this.vaultIndex = new VaultIndex(deps.config.vault);
    this.http = createServer((req, res) => {
      this.route(req, res).catch(err => {
        deps.log(`unhandled route error: ${String(err)}`);
        sendJson(res, 500, { error: "internal_error", message: String(err) });
      });
    });
    this.http.on("upgrade", (req, socket) => this.handleUpgrade(req, socket));
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
      this.catalogCache = null;
      return sendJson(res, 200, { ok: true, disabled: Array.from(wanted) });
    }

    /* --- ws ticket --- */
    if (method === "POST" && path === "/ws-ticket") {
      return sendJson(res, 200, { ticket: this.mintTicket(), expiresIn: TICKET_TTL_MS / 1000 });
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
      return sendJson(res, 200, { id: engine.id, sessionId: engine.sessionId });
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
        case "POST approve": return this.postApprove(req, res, engine);
        case "POST title": return this.postTitle(res, engine);
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
    /* 5-minute cache: the disk scans are cheap but `claude mcp list` spawns a
       child that can take seconds when a remote connector is slow, and the
       phone hits /catalog on every cold open. */
    if (!force && this.catalogCache && Date.now() - this.catalogAt < 300_000) return this.catalogCache;
    this.catalogCache = await buildCatalog(this.deps.config.vault, this.deps.claudePath, this.deps.log);
    this.catalogAt = Date.now();
    return this.catalogCache;
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

  private async getEvents(res: ServerResponse, engine: TabEngine, url: URL): Promise<void> {
    const since = clampInt(url.searchParams.get("since"), 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = clampInt(url.searchParams.get("limit"), 500, 1, 5000);
    const { frames, evicted } = await engine.replaySince(since, limit);
    sendJson(res, 200, { events: frames, lastSeq: engine.lastSeq, evicted });
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

    /* Answer immediately if the event the client is waiting for already
       happened while it was reconnecting. */
    const { frames } = await engine.replaySince(since - 1, 5000);
    const already = frames.find(f => (f.t === "turn_done" || f.t === "approval_request") && f.seq >= since);
    if (already) return sendJson(res, 200, { frame: already, lastSeq: engine.lastSeq });

    const frame = await new Promise<Frame | null>(resolve => {
      const waiter: Waiter = {
        tab: tabId,
        since,
        resolve,
        timer: setTimeout(() => { this.waiters.delete(waiter); resolve(null); }, timeoutS * 1000),
      };
      this.waiters.add(waiter);
    });
    if (!frame) return sendJson(res, 202, { partial: true, error: "wait_timeout", lastSeq: engine.lastSeq });
    sendJson(res, 200, { frame, lastSeq: engine.lastSeq });
  }

  /* ---------- WebSocket ---------- */

  private handleUpgrade(req: IncomingMessage, socket: Duplex): void {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const match = /^\/ws\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (!match || !isWebSocketUpgrade(req)) {
      rejectUpgrade(socket, 400, "bad_request");
      return;
    }
    if (!this.redeemTicket(match[1])) {
      rejectUpgrade(socket, 401, "invalid_ticket");
      return;
    }
    const conn = acceptUpgrade(req, socket);
    if (!conn) return;
    this.deps.log(`ws ${conn.id} connected`);

    /* Subscribe to nothing until the client says what it wants; the hello
       frame tells it every tab's cursor so it can ask precisely. */
    conn.onMessage(text => this.handleWsMessage(conn, text));
    conn.onClose(() => {
      this.subs.delete(conn.id);
      this.deps.log(`ws ${conn.id} closed`);
    });

    void this.sendHello(conn);
  }

  private async sendHello(conn: WsConnection): Promise<void> {
    const catalog = await this.catalog().catch(() => null);
    conn.send(JSON.stringify(makeFrame("hello", null, 0, {
      serverStartedAt: this.deps.startedAt,
      tabs: this.deps.registry.list().map(t => ({ id: t.id, lastSeq: t.lastSeq, status: t.status })),
      catalogHash: catalog?.hash ?? null,
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
    /* Register BEFORE replaying: a frame produced during the replay await must
       land after the replayed ones, not vanish into a gap. Ordering holds
       because both go out through conn.send on the same socket, in call
       order, and the replay loop below is the only thing between them. */
    this.subs.set(conn.id, { conn, tabs });

    const since = (msg.since && typeof msg.since === "object" ? msg.since : {}) as Record<string, number>;
    const targets = this.deps.registry.list().filter(t => tabs === "all" || tabs.has(t.id));
    for (const engine of targets) {
      const cursor = Number.isFinite(since[engine.id]) ? Number(since[engine.id]) : 0;
      if (cursor >= engine.lastSeq) continue;
      const { frames, evicted } = await engine.replaySince(cursor);
      if (evicted) {
        conn.send(JSON.stringify(makeFrame("resync", engine.id, engine.lastSeq, { reason: "buffer_evicted" })));
        continue;
      }
      for (const frame of frames) {
        if (conn.closed) return;
        conn.send(JSON.stringify(frame));
      }
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
