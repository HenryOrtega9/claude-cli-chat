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
                 cold client renders history from one call)
       write  -> NO-OP. The daemon projects and persists the conversation from
                 the event stream it is already parsing; a phone echoing its
                 own render back would be a second, lower-fidelity writer to
                 the same file. Reported as success so Persistence's debounced
                 saves stay quiet instead of logging a failure per token.
       remove -> NO-OP (DELETE /tabs/:id, issued by the shell, removes both).

   `<store>/conversations/<id>.meta.json`
       read   -> synthesized from GET /tabs/:id
                 (`{title, updatedAt, messageCount}`); the daemon writes real
                 sidecars, but re-deriving is one call instead of two.
       write  -> NO-OP, same reason as the body.

   `<store>` and `<store>/conversations`
       exists -> true, mkdir -> no-op. The daemon owns the directory.
       list(`<store>/conversations`) -> one `<id>.json` entry per tab in
                 GET /tabs, which is what History needs.

   `.claude/mcp.json`
       read   -> synthesized `{disabledServers:[…]}` from GET /catalog's
                 `mcpServers[].enabled`
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
};

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
  private catalogCache: { at: number; disabled: string[] } | null = null;
  private static readonly CACHE_MS = 1500;

  constructor(private readonly conn: GatewayConnection) {}

  /* The shell calls this after any mutation it made itself (tab create/close,
     MCP toggle) so the next read is not served a stale snapshot. */
  invalidate(): void {
    this.tabIndexCache = null;
    this.storedTabCache.clear();
    this.catalogCache = null;
  }

  invalidateTab(id: string): void {
    this.storedTabCache.delete(id);
    this.tabIndexCache = null;
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
      const index = await this.loadTabIndex();
      return index.tabs.some(t => t.id === conv.id);
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
      const tab = await this.loadStoredTab(conv.id);
      if (!tab) throw new Error(`No such conversation: ${conv.id}`);
      if (conv.meta) {
        return JSON.stringify({
          title: tab.title ?? "Untitled",
          updatedAt: tab.updatedAt ?? 0,
          messageCount: tab.messageCount ?? (Array.isArray(tab.messages) ? tab.messages.length : 0),
        });
      }
      return JSON.stringify(tab);
    }
    throw new Error(`RemoteFileStorage cannot read ${path}`);
  }

  /* Nothing the gateway serves is binary. Attachments travel as base64 inside
     the turn payload, never through storage. */
  readBinary(_path: string): Promise<ArrayBuffer> {
    return Promise.reject(new Error("RemoteFileStorage has no binary reads"));
  }

  async list(path: string): Promise<{ files: string[]; folders: string[] }> {
    if (path === CONV_DIR) {
      const index = await this.loadTabIndex();
      return { files: index.tabs.map(t => `${CONV_DIR}/${t.id}.json`), folders: [] };
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
    if (conversationId(path)) return; /* the daemon projects these itself */
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

  private async loadStoredTab(id: string): Promise<StoredTabResponse | null> {
    const cached = this.storedTabCache.get(id);
    if (cached && Date.now() - cached.at < RemoteFileStorage.CACHE_MS) return cached.value;
    const res = await this.conn.rpc("GET", `/tabs/${encodeURIComponent(id)}`);
    const value = res.status === 200 && res.json && typeof res.json === "object"
      ? res.json as StoredTabResponse
      : null;
    this.storedTabCache.set(id, { at: Date.now(), value });
    /* The tab's cursor comes back with the projection, so a cold restore
       subscribes from exactly where the daemon's render ends. */
    if (value && typeof value.lastSeq === "number") this.conn.seedSeq(id, value.lastSeq);
    return value;
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
    if (cached && Date.now() - cached.at < RemoteFileStorage.CACHE_MS) return cached.disabled;
    const res = await this.conn.rpc("GET", "/catalog");
    const servers = (res.json as { mcpServers?: Array<{ name?: unknown; enabled?: unknown }> } | undefined)?.mcpServers;
    const disabled = Array.isArray(servers)
      ? servers.filter(s => s?.enabled === false && typeof s.name === "string").map(s => s.name as string)
      : [];
    if (res.status === 200) this.catalogCache = { at: Date.now(), disabled };
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
