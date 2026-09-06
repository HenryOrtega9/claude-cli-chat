/* RemoteFileStorage — `FileStorage` over the Vault Gateway.

   The gateway exposes no generic file-storage route, and it should not: the
   store it owns is not a bag of bytes, it is the tab registry (`/tabs`,
   `/tabs/:id`), the MCP opt-out list (`/catalog` + `/mcp/disable`) and the
   permission allowlist (`/permissions` + `/permissions/allow`). So rather than
   inventing a remote filesystem, this adapter answers the SPECIFIC paths the
   shared stores read and write, and maps each to the route that owns it.

   ---------------------------------------------------------------------------
   PATH MAPPING  (store dir is `.claude-cli-chat/ios`, matching the daemon's
   `new Persistence(null, ".claude-cli-chat/ios")`)
   ---------------------------------------------------------------------------

   `<store>/tabs.json`
       read   -> GET /tabs, verbatim `{activeTabId, tabs:[{id,title,sessionId}]}`
       write  -> PATCH /tabs/:id {active:true} for the new activeTabId, and
                 PATCH /tabs/:id {title} for any title that changed.
                 Tab CREATION and DELETION are NOT inferred from this file —
                 they are explicit POST /tabs and DELETE /tabs/:id calls the
                 shell makes, because the daemon mints the tab id.

   `<store>/conversations/<id>.json`
       read   -> GET /tabs/:id (the daemon's own projection of the stream, so a
                 cold client renders history from one call); a 404 there means
                 the tab isn't currently live (closed from this device or
                 another one) and is retried once against
                 POST /tabs/:id/reopen, which reconstructs it from the
                 conversation file DELETE left behind — see registry.ts
                 remove(). Genuinely nonexistent and closed-but-revivable are
                 indistinguishable from here; both end up `null`.
       write  -> ALMOST a no-op. The daemon projects and persists the
                 conversation from the event stream it is already parsing; a
                 phone echoing its own render back would be a second, lower-
                 fidelity writer to the same file, so every field except
                 `draft` is dropped. `draft` (unsent composer text) is the one
                 field the daemon has no other way to learn — the user hasn't
                 submitted it, so it never appears on the wire — and is mapped
                 to PATCH /tabs/:id {draft} (see applyConversation()), deduped
                 against the last value sent so an unrelated save (streamed
                 message content, a tool result...) doesn't refire it. Reports
                 success either way so Persistence's debounced saves stay
                 quiet instead of logging a failure per token.
       remove -> NO-OP. DELETE /tabs/:id, issued by the shell, drops the tab
                 from the OPEN index and its live child, but deliberately
                 LEAVES the conversation file and its meta sidecar on disk —
                 that's what makes reopen() above possible, and what GET
                 /conversations lists for History.

   `<store>/conversations/<id>.meta.json`
       read   -> synthesized from GET /conversations (title, updatedAt,
                 messageCount), NOT from GET /tabs/:id — deriving it from the
                 latter would silently reopen a closed conversation just to
                 render its row title, the instant History's list renders.
       write  -> NO-OP, same reason as the body.

   `<store>` and `<store>/conversations`
       exists -> true, mkdir -> no-op. The daemon owns the directory.
       list(`<store>/conversations`) -> one `<id>.json` entry per row in
                 GET /conversations (open AND closed tabs), which is what
                 History needs.

   `.claude/mcp.json`
       read   -> synthesized `{disabledServers:[…]}` from GET /catalog's
                 `mcpServers[].enabled`, or from the list RemoteHost seeded
                 via seedDisabledServers() from its own catalog (cached or
                 fetched), which is what answers the per-tab mount reads.
       write  -> POST /mcp/disable {servers} with the file's `disabledServers`
                 (the route's list is absolute: names absent from it are
                 re-enabled), then the catalog cache is dropped so the next
                 read reflects it.

   `.claude/settings.json`
       read   -> `{permissions:{allow:[…]}}` from GET /permissions
       write  -> POST /permissions/allow {patterns} with whatever the payload
                 ADDS relative to the last read. Removals are not expressible:
                 the route only adds. The one UI path that removes patterns is
                 un-trusting a folder, which therefore no-ops on the phone —
                 documented in WAVE2.md, and the desktop still owns that.

   Atomic writes. `writeJsonAtomic` (src/mcp/MCPConfig.ts) stages to
   `<path>.<token>.tmp` and then renames over the target. There is no staging
   area on the far end, so a `.tmp` write is held in memory and the RENAME is
   what performs the mapped call. `.bak` paths (the fallback branch of the same
   helper, and the corrupt-file rotation in both stores) are accepted and
   discarded — nothing on the phone can recover from a backup it cannot read.

   basePath() is null: nothing here is filesystem-backed, which is exactly the
   condition `Persistence.flushSync()` already degrades to a no-op on. */

import type { FileStorage } from "../types";
import type { GatewayConnection } from "./GatewayConnection";

export const IOS_STORE_DIR = ".claude-cli-chat/ios";
const CONV_DIR = `${IOS_STORE_DIR}/conversations`;
const TABS_PATH = `${IOS_STORE_DIR}/tabs.json`;
const MCP_PATH = ".claude/mcp.json";
const SETTINGS_PATH = ".claude/settings.json";

type TabIndexEntry = { id: string; title: string; sessionId: string | null };
type TabIndex = { activeTabId: string | null; tabs: TabIndexEntry[] };

type StoredTabResponse = {
  id?: string;
  title?: string;
  updatedAt?: number;
  messages?: unknown[];
  messageCount?: number;
  lastSeq?: number;
  /* Unsent composer text — see the class header's write() note and
     applyConversation() below. Passed straight through: TabState.draft in
     src/view/state.ts carries the full contract. */
  draft?: string;
  /* True while the daemon has a live turn running for this tab (see
     engine.ts storedTab()). Read straight through by Persistence.loadTab
     into TabState.busy — the one field StoredTab persists that isn't
     written back, since only the daemon's own busy flag is authoritative. */
  busy?: boolean;
  status?: string;
};

/* GET /conversations row: id, title, updatedAt, messageCount. A superset of
   GET /tabs — it's sourced from the daemon's persisted conversation files
   directly, so it includes tabs the phone has since closed (DELETE keeps the
   file precisely so History can still list and restore them) as well as
   every currently open one. */
type ConversationRow = { id: string; title: string; updatedAt: number; messageCount: number };

function isTmp(path: string): boolean {
  return path.endsWith(".tmp");
}

function isBak(path: string): boolean {
  return path.endsWith(".bak");
}

/* `<store>/conversations/<id>.json` -> id, or null for anything else. The
   `.meta.json` suffix is checked first because it also ends in `.json`. */
function conversationId(path: string): { id: string; meta: boolean } | null {
  if (!path.startsWith(`${CONV_DIR}/`)) return null;
  const rest = path.slice(CONV_DIR.length + 1);
  if (rest.includes("/")) return null;
  if (rest.endsWith(".meta.json")) return { id: rest.slice(0, -".meta.json".length), meta: true };
  if (rest.endsWith(".json")) return { id: rest.slice(0, -".json".length), meta: false };
  return null;
}

export class RemoteFileStorage implements FileStorage {
  /* Staged `.tmp` payloads, keyed by tmp path. Bounded by construction: every
     writeJsonAtomic stages exactly one and renames it away immediately. */
  private readonly staged = new Map<string, string>();
  /* Last allow-list we handed out, so a settings.json write can be diffed into
     the additive-only /permissions/allow call. */
  private lastAllow: string[] = [];
  /* Short-lived caches so the History modal (which reads every tab) and the
     MCP manager don't fan out one round trip per row. */
  private tabIndexCache: { at: number; value: TabIndex } | null = null;
  private readonly storedTabCache = new Map<string, { at: number; value: StoredTabResponse | null }>();
  /* `ttl` is per entry: a network-sourced entry lives CACHE_MS like the
     others, while a seeded one (seedDisabledServers) lives until something
     replaces or invalidates it, because its source is the host's own
     catalog rather than a snapshot that can drift. */
  private catalogCache: { at: number; ttl: number; disabled: string[] } | null = null;
  /* GET /conversations — open AND closed tabs. Separate from tabIndexCache
     (GET /tabs, open only) because History listing and the open tab bar have
     different staleness tolerances and different write paths invalidate
     them. */
  private conversationListCache: { at: number; value: ConversationRow[] } | null = null;
  /* Last `draft` value actually PATCHed per tab id, so applyConversation()
     can skip the round trip when a save carries the same text as before
     (the common case — most saves are triggered by something other than a
     draft change). */
  private readonly lastDraftSent = new Map<string, string>();
  private static readonly CACHE_MS = 1500;

  constructor(private readonly conn: GatewayConnection) {}

  /* The shell calls this after any mutation it made itself (tab create/close,
     MCP toggle) so the next read is not served a stale snapshot. */
  invalidate(): void {
    this.tabIndexCache = null;
    this.storedTabCache.clear();
    this.catalogCache = null;
    this.conversationListCache = null;
  }

  /* Seeds the `.claude/mcp.json` read with a disabled-server list the host
     already holds (RemoteHost.applyCatalog, from its cached or freshly
     fetched /catalog), so the per-tab reads at mount — every TabController
     constructor's refreshCostSurface() — are answered here without a second
     GET /catalog behind the host's own. Lives until invalidate(), applyMcp()
     or a later seed replaces it; a network read only happens once the seed
     is gone. */
  seedDisabledServers(names: string[]): void {
    this.catalogCache = { at: Date.now(), ttl: Number.POSITIVE_INFINITY, disabled: [...names] };
  }

  invalidateTab(id: string): void {
    this.storedTabCache.delete(id);
    this.tabIndexCache = null;
    this.conversationListCache = null;
    /* Allow a resend even if the next write happens to carry the same text
       as the last one we sent — e.g. after a reopen() re-seeded the tab from
       disk, our cached "last sent" value may no longer reflect reality. */
    this.lastDraftSent.delete(id);
  }

  /* ----- reads ------------------------------------------------------------ */

  async exists(path: string): Promise<boolean> {
    if (isTmp(path)) return this.staged.has(path);
    if (isBak(path)) return false;
    if (path === IOS_STORE_DIR || path === CONV_DIR || path === ".claude") return true;
    if (path === TABS_PATH) return true;
    if (path === MCP_PATH || path === SETTINGS_PATH) return true;
    const conv = conversationId(path);
    if (conv) {
      const rows = await this.loadConversationList();
      return rows.some(r => r.id === conv.id);
    }
    return false;
  }

  async read(path: string): Promise<string> {
    if (isTmp(path)) {
      const staged = this.staged.get(path);
      if (staged === undefined) throw new Error(`No staged write at ${path}`);
      return staged;
    }
    if (path === TABS_PATH) return JSON.stringify(await this.loadTabIndex());
    if (path === MCP_PATH) return JSON.stringify({ disabledServers: await this.loadDisabledServers() });
    if (path === SETTINGS_PATH) return JSON.stringify({ permissions: { allow: await this.loadAllow() } });
    const conv = conversationId(path);
    if (conv) {
      /* Meta reads (History listing) are served from GET /conversations —
         cheap, and crucially it works for a CLOSED tab without reviving it.
         Full-body reads (actually opening a conversation) go through
         loadStoredTab(), which — see its comment — auto-reopens a closed tab
         on the daemon so it's live and addressable for turns from here on.
         Deriving meta from loadStoredTab() instead, as this used to, would
         have silently reopened every closed conversation the instant History
         rendered its row title. */
      if (conv.meta) {
        const rows = await this.loadConversationList();
        const row = rows.find(r => r.id === conv.id);
        if (!row) throw new Error(`No such conversation: ${conv.id}`);
        return JSON.stringify({ title: row.title, updatedAt: row.updatedAt, messageCount: row.messageCount });
      }
      const tab = await this.loadStoredTab(conv.id);
      if (!tab) throw new Error(`No such conversation: ${conv.id}`);
      return JSON.stringify(tab);
    }
    throw new Error(`RemoteFileStorage cannot read ${path}`);
  }

  /* Nothing the gateway serves is binary. Attachments travel as base64 inside
     the turn payload, never through storage. */
  readBinary(_path: string): Promise<ArrayBuffer> {
    return Promise.reject(new Error("RemoteFileStorage has no binary reads"));
  }

  /* `Persistence.listConversations()` (the shared History source) calls this
     to enumerate `<store>/conversations/*.json`. Sourced from GET
     /conversations rather than GET /tabs so closed-but-kept conversations
     appear in History too, not just the open tab bar. */
  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    if (path === CONV_DIR) {
      const rows = await this.loadConversationList();
      return { files: rows.map(r => `${CONV_DIR}/${r.id}.json`), folders: [] };
    }
    if (path === IOS_STORE_DIR) return { files: [TABS_PATH], folders: [CONV_DIR] };
    return { files: [], folders: [] };
  }

  basePath(): string | null {
    return null;
  }

  /* ----- writes ------------------------------------------------------------ */

  async write(path: string, data: string): Promise<void> {
    if (isTmp(path)) { this.staged.set(path, data); return; }
    if (isBak(path)) return;
    await this.apply(path, data);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    if (isTmp(oldPath)) {
      const payload = this.staged.get(oldPath);
      this.staged.delete(oldPath);
      if (payload === undefined) throw new Error(`Nothing staged at ${oldPath}`);
      if (isBak(newPath)) return;
      await this.apply(newPath, payload);
      return;
    }
    /* `rename(<path>, <path>.bak)` is writeJsonAtomic moving the CURRENT file
       aside before a retry. There is no current file to move, and the retry
       will call us again with the tmp — so this is a success with no work. */
    if (isBak(newPath)) return;
    throw new Error(`RemoteFileStorage cannot rename ${oldPath} -> ${newPath}`);
  }

  async remove(path: string): Promise<void> {
    this.staged.delete(path);
    /* Conversation removal rides on DELETE /tabs/:id, which the shell issues
       when it closes a tab; Persistence.deleteTab calling here as well would
       be a second delete of something already gone. */
  }

  async mkdir(_path: string): Promise<void> {
    /* The daemon owns the directory tree. */
  }

  private async apply(path: string, data: string): Promise<void> {
    if (path === TABS_PATH) return this.applyTabIndex(data);
    if (path === MCP_PATH) return this.applyMcp(data);
    if (path === SETTINGS_PATH) return this.applySettings(data);
    const conv = conversationId(path);
    if (conv) return this.applyConversation(conv, data);
    throw new Error(`RemoteFileStorage cannot write ${path}`);
  }

  /* ----- route adapters ---------------------------------------------------- */

  private async loadTabIndex(): Promise<TabIndex> {
    const cached = this.tabIndexCache;
    if (cached && Date.now() - cached.at < RemoteFileStorage.CACHE_MS) return cached.value;
    const res = await this.conn.rpc("GET", "/tabs");
    const json = res.json as Partial<TabIndex> | undefined;
    const value: TabIndex = {
      activeTabId: typeof json?.activeTabId === "string" ? json.activeTabId : null,
      tabs: Array.isArray(json?.tabs)
        ? json.tabs.filter((t): t is TabIndexEntry => !!t && typeof (t as TabIndexEntry).id === "string")
        : [],
    };
    if (res.status === 200) this.tabIndexCache = { at: Date.now(), value };
    return value;
  }

  /* GET /tabs/:id only answers for a tab currently held live in the
     daemon's registry. A tab closed via DELETE (its conversation file kept
     on disk precisely so History can still show it — see registry.ts
     remove()) 404s there until something asks the daemon to revive it. A
     404 here is exactly that ask: POST /tabs/:id/reopen reconstructs the
     engine from the persisted file and returns the same StoredTab shape, so
     opening a History row works the same way opening an already-live tab
     does, with one extra round trip the caller never has to know about.
     "Genuinely never existed" and "closed but revivable" are
     indistinguishable from here — the reopen call answers its own 404 for
     the former, which collapses to the same `null` this returns either
     way. */
  private async loadStoredTab(id: string): Promise<StoredTabResponse | null> {
    const cached = this.storedTabCache.get(id);
    if (cached && Date.now() - cached.at < RemoteFileStorage.CACHE_MS) return cached.value;
    let res = await this.conn.rpc("GET", `/tabs/${encodeURIComponent(id)}`);
    if (res.status === 404) res = await this.conn.rpc("POST", `/tabs/${encodeURIComponent(id)}/reopen`);
    const value = res.status === 200 && res.json && typeof res.json === "object"
      ? res.json as StoredTabResponse
      : null;
    this.storedTabCache.set(id, { at: Date.now(), value });
    /* A reopen also puts the tab back in the OPEN index (registry.ts), so the
       next GET /tabs reflects it — stale otherwise since nothing else here
       invalidates tabIndexCache on a successful revive. */
    if (value) this.tabIndexCache = null;
    /* The tab's cursor comes back with the projection, so a cold restore
       subscribes from exactly where the daemon's render ends. */
    if (value && typeof value.lastSeq === "number") this.conn.seedSeq(id, value.lastSeq);
    return value;
  }

  /* GET /conversations: every conversation the daemon has ever persisted,
     open or closed. The superset GET /tabs (open only) can't give History,
     and reading it never revives anything — see the read() comment above. */
  private async loadConversationList(): Promise<ConversationRow[]> {
    const cached = this.conversationListCache;
    if (cached && Date.now() - cached.at < RemoteFileStorage.CACHE_MS) return cached.value;
    const res = await this.conn.rpc("GET", "/conversations");
    const raw = (res.json as { conversations?: unknown } | undefined)?.conversations;
    const value: ConversationRow[] = Array.isArray(raw)
      ? raw.filter((r): r is ConversationRow => !!r && typeof (r as ConversationRow).id === "string")
        .map(r => ({
          id: r.id,
          title: typeof r.title === "string" && r.title ? r.title : "Untitled",
          updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
          messageCount: typeof r.messageCount === "number" ? r.messageCount : 0,
        }))
      : [];
    if (res.status === 200) this.conversationListCache = { at: Date.now(), value };
    return value;
  }

  /* The daemon projects and persists almost all of a conversation itself —
     see the class header. `draft` is the one field this client legitimately
     writes back: composer text the daemon has no other way to learn. Meta
     writes (the sidecar Persistence writes alongside every body) carry no
     draft and are skipped outright. */
  private async applyConversation(conv: { id: string; meta: boolean }, data: string): Promise<void> {
    if (conv.meta) return;
    let parsed: { draft?: unknown };
    try {
      parsed = JSON.parse(data) as { draft?: unknown };
    } catch {
      return;
    }
    const draft = typeof parsed.draft === "string" ? parsed.draft : "";
    if (this.lastDraftSent.get(conv.id) === draft) return;
    this.lastDraftSent.set(conv.id, draft);
    const res = await this.conn.rpc("PATCH", `/tabs/${encodeURIComponent(conv.id)}`, { draft });
    /* Best-effort: let a failed PATCH retry on the tab's next debounced save
       rather than pretending the daemon has the new value. */
    if (res.status !== 200) this.lastDraftSent.delete(conv.id);
  }

  private async applyTabIndex(data: string): Promise<void> {
    let next: TabIndex;
    try {
      next = JSON.parse(data) as TabIndex;
    } catch {
      return;
    }
    const current = await this.loadTabIndex();
    const byId = new Map(current.tabs.map(t => [t.id, t] as const));
    for (const tab of next.tabs ?? []) {
      const prev = byId.get(tab.id);
      /* A tab the daemon does not know about is a local-only artifact (a race
         with a close, or a fork whose creation call is still in flight). Never
         conjure one here — POST /tabs is the only way a tab is born. */
      if (!prev) continue;
      if (typeof tab.title === "string" && tab.title && tab.title !== prev.title) {
        await this.conn.rpc("PATCH", `/tabs/${encodeURIComponent(tab.id)}`, { title: tab.title });
      }
    }
    if (next.activeTabId && next.activeTabId !== current.activeTabId && byId.has(next.activeTabId)) {
      await this.conn.rpc("PATCH", `/tabs/${encodeURIComponent(next.activeTabId)}`, { active: true });
    }
    this.tabIndexCache = null;
  }

  private async loadDisabledServers(): Promise<string[]> {
    const cached = this.catalogCache;
    if (cached && Date.now() - cached.at < cached.ttl) return cached.disabled;
    const res = await this.conn.rpc("GET", "/catalog");
    const servers = (res.json as { mcpServers?: Array<{ name?: unknown; enabled?: unknown }> } | undefined)?.mcpServers;
    const disabled = Array.isArray(servers)
      ? servers.filter(s => s?.enabled === false && typeof s.name === "string").map(s => s.name as string)
      : [];
    if (res.status === 200) this.catalogCache = { at: Date.now(), ttl: RemoteFileStorage.CACHE_MS, disabled };
    return disabled;
  }

  private async applyMcp(data: string): Promise<void> {
    let parsed: { disabledServers?: unknown };
    try {
      parsed = JSON.parse(data) as { disabledServers?: unknown };
    } catch {
      return;
    }
    const servers = Array.isArray(parsed.disabledServers)
      ? parsed.disabledServers.filter((n): n is string => typeof n === "string")
      : [];
    await this.conn.rpc("POST", "/mcp/disable", { servers });
    this.catalogCache = null;
  }

  private async loadAllow(): Promise<string[]> {
    const res = await this.conn.rpc("GET", "/permissions");
    const allow = (res.json as { allow?: unknown } | undefined)?.allow;
    this.lastAllow = Array.isArray(allow) ? allow.filter((p): p is string => typeof p === "string") : [];
    return this.lastAllow;
  }

  private async applySettings(data: string): Promise<void> {
    let parsed: { permissions?: { allow?: unknown } };
    try {
      parsed = JSON.parse(data) as { permissions?: { allow?: unknown } };
    } catch {
      return;
    }
    const allowRaw = parsed.permissions?.allow;
    const allow = Array.isArray(allowRaw) ? allowRaw.filter((p): p is string => typeof p === "string") : [];
    const known = new Set(this.lastAllow);
    const added = allow.filter(p => !known.has(p));
    if (added.length === 0) return;
    const res = await this.conn.rpc("POST", "/permissions/allow", { patterns: added });
    if (res.status === 200) this.lastAllow = allow;
  }
}
