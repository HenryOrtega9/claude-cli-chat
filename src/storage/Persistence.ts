import { platform, type AppHandle } from "../platform";
import type { Attachment, ChatMessage, TabState, ToolCall } from "../view/state";
import { truncateToolResult } from "../view/state";
import { writeJsonAtomic } from "../mcp/MCPConfig";

/* Synchronous file API used by flushSync() — the quit-time path, where
   nothing async can be awaited. Node's `fs` used to be a top-level import,
   which made this module unresolvable in a browser bundle even though the
   rest of it goes through `platform.storage`. It is now injected: both node
   hosts call setSyncFileWriter(require("fs")) during boot, and a lazy
   `globalThis.require` probe covers any node embedder that forgets to.
   Absent => flushSync() degrades to a no-op. */
export type SyncFileWriter = {
  mkdirSync(path: string, opts: { recursive: boolean }): void;
  renameSync(from: string, to: string): void;
  writeFileSync(path: string, data: string, encoding: "utf8"): void;
};

/* undefined = never injected; null = injected as deliberately absent. */
let injectedSyncWriter: SyncFileWriter | null | undefined = undefined;
/* undefined = not probed yet, null = probed and unavailable. */
let probedSyncWriter: SyncFileWriter | null | undefined = undefined;

export function setSyncFileWriter(writer: SyncFileWriter | null): void {
  injectedSyncWriter = writer;
}

function syncFileWriter(): SyncFileWriter | null {
  if (injectedSyncWriter !== undefined) return injectedSyncWriter;
  if (probedSyncWriter === undefined) {
    probedSyncWriter = null;
    try {
      /* Property access, not a bare `require(...)` call, so a browser bundler
         never tries to resolve "fs" at build time. */
      const req = (globalThis as { require?: (id: string) => unknown }).require;
      if (typeof req === "function") probedSyncWriter = req("fs") as SyncFileWriter;
    } catch {
      /* no node here */
    }
  }
  return probedSyncWriter;
}

/* Persisted shape of a tab. Excludes runtime-only state (pendingApprovals)
   since it's bound to a live subprocess and cannot survive a restart. `busy`
   is the one exception: toStored() below never writes it (true on desktop/
   plugin, where the subprocess dies with the host), but RemoteFileStorage's
   read() maps GET /tabs/:id straight through, and the daemon's own busy flag
   DOES survive an iOS relaunch — the child lives on the Mac. loadTab() below
   reads it back so a cold restore of a mid-turn tab renders with a locked
   composer instead of a false "idle" that a follow-up submit 409s against.
   Per-tab overrides (model/effort/mode/snippet) DO persist so the user's tab
   settings survive an Obsidian reload. */
type StoredTab = {
  id: string;
  sessionId: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: StoredMessage[];
  /* Cached count of `messages` written alongside the body so the History
     dropdown can list conversations without reading every full file. The
     sidecar meta file is the primary source; this is a fallback. */
  messageCount?: number;
  model?: string;
  effort?: string;
  permissionMode?: string;
  envSnippetId?: string;
  pinnedFilePaths?: string[];
  /* Subset of pinnedFilePaths flagged sticky (won't be auto-dropped after
     submit). Undefined on legacy state predating the field; TabController
     treats undefined as "all pins sticky" so behavior is preserved. */
  stickyPinnedFilePaths?: string[];
  voiceEnabled?: boolean;
  /* Unsent composer text — see TabState.draft's own comment for the full
     contract. Round-tripped like any other per-tab field on this path; the
     gateway's own StoredTab-shaped projection (scripts/gateway/src/engine.ts
     storedTab()) carries it separately for the remote client. */
  draft?: string;
  /* Remote-only (see the type comment above) — absent from every local
     write, so a desktop/plugin load always falls through to the `false`
     default in loadTab() below. */
  busy?: boolean;
};

/* Lightweight stand-in for a sent attachment — filename/kind/mediaType only,
   never the base64 image/PDF payload or raw text content. Persisting the
   full payload would re-introduce exactly the kind of unbounded per-message
   growth this review is trying to eliminate elsewhere (a chat full of
   pasted screenshots would balloon the tab's JSON file). MessageRenderer
   already has a defensive "data missing" rendering path for attachments
   (used when a live image attachment fails to carry data) — that same path
   renders this stripped shape as a plain file/image chip, so the user at
   least sees "an attachment was here" after a reload instead of it vanishing
   with no trace. */
type StoredAttachment = {
  kind?: Attachment["kind"];
  mediaType: string;
  filename?: string;
};

type StoredMessage = {
  id: string;
  role: ChatMessage["role"];
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  durationMs?: number;
  thinking?: string;
  selectionContext?: ChatMessage["selectionContext"];
  attachedNotePaths?: string[];
  attachments?: StoredAttachment[];
};

type TabMeta = {
  title: string;
  updatedAt: number;
  messageCount: number;
};

type TabIndex = {
  activeTabId: string | null;
  tabs: Array<{ id: string; title: string; sessionId: string | null }>;
};

export class Persistence {
  /* Base-relative store directory. Defaults to the plugin's historical
     location; the standalone desktop shell passes a namespaced subdirectory
     so the two UIs keep independent tab stores and never contend (which is
     what lets them run concurrently — each guards only its own store with
     its own window.lock). */
  private readonly dir: string;
  private readonly convDir: string;
  private readonly indexPath: string;
  private pendingWrites = new Map<string, { handle: ReturnType<typeof setTimeout>; state: TabState }>();
  /* Per-tab in-flight save promise. Used by deleteTab/flush to await a save
     that's already started before issuing remove() or returning. */
  private inflightSaves = new Map<string, Promise<void>>();
  /* Last index payload written to disk (serialized). saveIndex is called once
     per streaming token via onStateChange, but the index only changes on tab
     add/remove/select, a title-gen result, or a sessionId landing. Dedupe on
     the serialized form so token-rate calls do zero disk I/O. */
  private lastIndexJson: string | null = null;
  /* Most recent saveIndex dispatch, rejection pre-swallowed. The view fires
     saveIndex fire-and-forget, so without this handle flush() (the unload
     path) has no way to await a still-in-flight index write — a tab
     close/title/sessionId change landing right before quit would be lost,
     leaving tabs.json referencing deleted files (phantom blank tab on next
     load). */
  private lastIndexWrite: Promise<void> = Promise.resolve();

  constructor(
    private app: AppHandle,
    dir = ".claude-cli-chat",
  ) {
    this.dir = dir;
    this.convDir = `${dir}/conversations`;
    this.indexPath = `${dir}/tabs.json`;
  }

  private async ensureDirs(): Promise<void> {
    const adapter = platform.storage;
    if (!(await adapter.exists(this.dir))) await adapter.mkdir(this.dir);
    if (!(await adapter.exists(this.convDir))) await adapter.mkdir(this.convDir);
  }

  async loadIndex(): Promise<TabIndex | null> {
    const adapter = platform.storage;
    if (!(await adapter.exists(this.indexPath))) return null;
    try {
      const parsed = JSON.parse(await adapter.read(this.indexPath));
      /* Validate the shape before trusting it. Valid-but-wrong JSON ({}, [],
         {tabs:"x"}) passes JSON.parse and would then throw in the caller's
         index.tabs iteration — loadTab is defensive per-field, loadIndex was not. */
      if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as TabIndex).tabs)) {
        return null;
      }
      return parsed as TabIndex;
    } catch {
      return null;
    }
  }

  async loadTab(id: string): Promise<TabState | null> {
    const adapter = platform.storage;
    const path = this.convPath(id);
    if (!(await adapter.exists(path))) return null;
    let stored: Partial<StoredTab> | null;
    try {
      const raw = JSON.parse(await adapter.read(path));
      if (!raw || typeof raw !== "object") return null;
      stored = raw as Partial<StoredTab>;
    } catch {
      return null;
    }
    /* Defensive schema coercion — never throw on schema drift. Missing or
       malformed fields fall back to defaults so an old/partial file still
       loads as an empty-but-usable tab. */
    const messages = Array.isArray(stored.messages) ? stored.messages as StoredMessage[] : [];
    const now = Date.now();
    const createdAt = typeof stored.createdAt === "number" ? stored.createdAt : now;
    const updatedAt = typeof stored.updatedAt === "number" ? stored.updatedAt : createdAt;
    return {
      id: typeof stored.id === "string" ? stored.id : id,
      sessionId: typeof stored.sessionId === "string" ? stored.sessionId : null,
      title: typeof stored.title === "string" ? stored.title : "Untitled",
      createdAt,
      updatedAt,
      messages,
      pendingApprovals: new Map(),
      /* See StoredTab.busy's comment: true only ever arrives from
         RemoteFileStorage's mapping of the daemon's live `busy` flag; a
         local/desktop file never has this field, so this reads back as
         `false` there exactly as before. */
      busy: typeof stored.busy === "boolean" ? stored.busy : false,
      model: typeof stored.model === "string" ? stored.model : undefined,
      effort: typeof stored.effort === "string" ? stored.effort : undefined,
      permissionMode: typeof stored.permissionMode === "string" ? stored.permissionMode : undefined,
      envSnippetId: typeof stored.envSnippetId === "string" ? stored.envSnippetId : undefined,
      pinnedFilePaths: Array.isArray(stored.pinnedFilePaths) ? stored.pinnedFilePaths : undefined,
      stickyPinnedFilePaths: Array.isArray(stored.stickyPinnedFilePaths) ? stored.stickyPinnedFilePaths : undefined,
      voiceEnabled: typeof stored.voiceEnabled === "boolean" ? stored.voiceEnabled : undefined,
      draft: typeof stored.draft === "string" ? stored.draft : undefined,
    };
  }

  async saveIndex(index: TabIndex): Promise<void> {
    /* Content-dedupe: the index payload is identical on virtually every
       streaming token, so skip the atomic rewrite when nothing changed.
       Setting lastIndexJson before the await is intentional — the synchronous
       compare-and-set must complete before any concurrent call's microtask so
       the per-token flood is suppressed; the catch reverts so a transient
       failure retries on the next state change rather than being masked. */
    const json = JSON.stringify(index);
    if (json === this.lastIndexJson) return;
    this.lastIndexJson = json;
    /* Chain onto the previous dispatch: index writes with different payloads
       must land in dispatch order. Unchained, a slow older write's rename can
       finish AFTER a newer one (fire-and-forget title-gen save vs an awaited
       tab-close save), leaving tabs.json stale — e.g. referencing a deleted
       conversation — while the dedupe cache suppresses any rewrite. */
    const write = this.lastIndexWrite.then(async () => {
      try {
        await this.ensureDirs();
        await writeJsonAtomic(platform.storage, this.indexPath, index);
      } catch (err) {
        this.lastIndexJson = null;
        throw err;
      }
    });
    /* Track the dispatch so flush() can await it on unload. Swallow the
       rejection on the tracked copy only — callers awaiting saveIndex still
       see the error. */
    this.lastIndexWrite = write.catch(() => undefined);
    return write;
  }

  /* Debounced per-tab write. Coalesces rapid streaming updates so we write
     at most once every 500ms per tab. The TabState is snapshotted synchronously
     at write time (when the timer fires), still immediately before saveTab's
     async work, so a later mutation (or destroy) can't corrupt the write
     payload mid-flight. Cloning at schedule time instead would clone on every
     token only to discard all but the last snapshot before a quiet period. */
  scheduleSaveTab(state: TabState): void {
    const existing = this.pendingWrites.get(state.id);
    if (existing) clearTimeout(existing.handle);
    const handle = setTimeout(() => {
      this.pendingWrites.delete(state.id);
      /* doSaveTab can throw (disk full, EACCES, a transient iCloud rename
         lock — see writeJsonAtomic's own retry comment), and this dispatch
         is otherwise fire-and-forget: an uncaught rejection here would be
         an unhandled promise rejection with zero user-visible signal, and
         the write is already off pendingWrites so flush()/flushSync() at
         unload wouldn't know to retry it. Warn and re-arm so it isn't lost
         from tracking — unless a newer edit already rescheduled this tab. */
      void this.saveTab(this.snapshotState(state)).catch(err => {
        console.warn(`[claude-cli-chat] debounced save failed for tab ${state.id}`, err);
        if (!this.pendingWrites.has(state.id)) this.scheduleSaveTab(state);
      });
    }, 500);
    this.pendingWrites.set(state.id, { handle, state });
  }

  /* Shallow-clone the persisted-relevant fields into a fresh object so
     a tab destroy or message mutation between this synchronous snapshot and
     saveTab's async work doesn't surface as a torn write. messages is
     array-cloned with each entry shallow-cloned too, since streaming mutates
     entry.content in place. */
  private snapshotState(state: TabState): TabState {
    return {
      id: state.id,
      sessionId: state.sessionId,
      title: state.title,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      messages: state.messages.map(m => ({ ...m })),
      pendingApprovals: state.pendingApprovals,
      busy: state.busy,
      model: state.model,
      effort: state.effort,
      permissionMode: state.permissionMode,
      envSnippetId: state.envSnippetId,
      pinnedFilePaths: state.pinnedFilePaths ? [...state.pinnedFilePaths] : undefined,
      stickyPinnedFilePaths: state.stickyPinnedFilePaths ? [...state.stickyPinnedFilePaths] : undefined,
      draft: state.draft,
    };
  }

  async saveTab(state: TabState): Promise<void> {
    /* Track in-flight saves so deleteTab/flush can await them. Same-tab
       concurrent saves chain onto whatever's already in flight so writes
       to one file stay ordered. */
    const prior = this.inflightSaves.get(state.id) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(() => this.doSaveTab(state));
    this.inflightSaves.set(state.id, run);
    try {
      await run;
    } finally {
      /* Only clear if we're still the head of the chain — a later save
         may have already replaced us. */
      if (this.inflightSaves.get(state.id) === run) {
        this.inflightSaves.delete(state.id);
      }
    }
  }

  /* TabState → on-disk shapes. Shared by the async save path and the
     synchronous quit-time flush so the two can never drift. */
  private toStored(state: TabState): { stored: StoredTab; meta: TabMeta } {
    const stored: StoredTab = {
      id: state.id,
      sessionId: state.sessionId,
      title: state.title,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      messages: state.messages.map(m => ({
        id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        /* Cap each tool's result before it hits disk — Claude already
           received the full output live, so this is a pure storage-bloat
           concern (see MAX_TOOL_RESULT_CHARS's own comment). A long
           tool-heavy conversation would otherwise grow its persisted JSON
           unboundedly and re-rewrite the whole (growing) file on every
           debounced save. */
        toolCalls: m.toolCalls?.map(tc => tc.result ? { ...tc, result: truncateToolResult(tc.result) } : tc),
        durationMs: m.durationMs,
        thinking: m.thinking,
        selectionContext: m.selectionContext,
        attachedNotePaths: m.attachedNotePaths,
        attachments: m.attachments?.map(a => ({
          kind: a.kind,
          mediaType: a.mediaType,
          filename: a.filename,
        })),
      })),
      messageCount: state.messages.length,
      model: state.model,
      effort: state.effort,
      permissionMode: state.permissionMode,
      envSnippetId: state.envSnippetId,
      pinnedFilePaths: state.pinnedFilePaths,
      stickyPinnedFilePaths: state.stickyPinnedFilePaths,
      voiceEnabled: state.voiceEnabled,
      /* `|| undefined` is defense in depth: every real writer (TabController's
         `draft || undefined` in handleDraftChange/clear(), the gateway's
         identical guard in engine.ts patch()) already normalizes "" away
         before it reaches here, but this is the actual serialization
         boundary, so an empty string must not become permanent noise in the
         JSON on disk regardless of what a future caller passes in. */
      draft: state.draft || undefined,
    };
    const meta: TabMeta = {
      title: stored.title,
      updatedAt: stored.updatedAt,
      messageCount: stored.messages.length,
    };
    return { stored, meta };
  }

  private async doSaveTab(state: TabState): Promise<void> {
    await this.ensureDirs();
    const { stored, meta } = this.toStored(state);
    const adapter = platform.storage;
    /* Sidecar meta file lets listConversations skip the full body read.
       Written atomically too so a crash mid-rotation never leaves the
       History dropdown reading half-written JSON. Meta is written FIRST:
       the pair isn't atomic, and listConversations treats an existing meta
       as authoritative — a crash between the two writes with meta-first
       leaves the History dropdown at worst one save optimistic, whereas
       body-first left it stale indefinitely (the fallback body read only
       runs when the meta file is entirely absent). */
    await writeJsonAtomic(adapter, this.metaPath(state.id), meta);
    await writeJsonAtomic(adapter, this.convPath(state.id), stored);
  }

  /* Synchronous best-effort flush for app quit. Obsidian ignores the promise
     returned by onunload, so on Cmd+Q the async flush() can be torn down
     mid-write and the last 500ms of debounced edits silently lost. This
     writes any still-pending debounced tab states plus the latest index
     payload with sync fs calls (tmp + rename, so files stay whole) before
     teardown proceeds. Desktop-only: degrades to a no-op when storage
     isn't filesystem-backed (basePath() === null). */
  flushSync(): void {
    const base = platform.storage.basePath();
    if (base === null) return;
    const fs = syncFileWriter();
    /* No synchronous file API on this host (browser client). The async
       debounced path still runs; only the quit-time last-write-wins pass is
       unavailable, which is the same degradation as a null basePath. */
    if (fs === null) return;
    const writeSync = (relPath: string, payload: string) => {
      const abs = `${base}/${relPath}`;
      const tmp = `${abs}.${Date.now().toString(36)}.tmp`;
      fs.writeFileSync(tmp, payload, "utf8");
      fs.renameSync(tmp, abs);
    };
    const pending = Array.from(this.pendingWrites.values());
    this.pendingWrites.clear();
    if (pending.length > 0) {
      try {
        fs.mkdirSync(`${base}/${this.convDir}`, { recursive: true });
      } catch (err) {
        console.warn("[claude-cli-chat] sync flush mkdir failed", err);
        return;
      }
    }
    for (const { handle, state } of pending) {
      clearTimeout(handle);
      const snapshot = this.snapshotState(state);
      try {
        const { stored, meta } = this.toStored(snapshot);
        writeSync(this.metaPath(state.id), JSON.stringify(meta, null, 2));
        writeSync(this.convPath(state.id), JSON.stringify(stored, null, 2));
      } catch (err) {
        console.warn(`[claude-cli-chat] sync flush failed for tab ${state.id}`, err);
      }
      /* A doSaveTab that was already in flight when this flush began holds
         an OLDER snapshot; on the plugin-reload path (event loop keeps
         running) its tmp-then-rename would land AFTER the sync write above
         and regress the file. Chain this newest snapshot behind it so the
         last write wins. On hard quit the chained save never runs and the
         sync write stands. */
      if (this.inflightSaves.has(state.id)) {
        void this.saveTab(snapshot).catch(err => {
          console.warn(`[claude-cli-chat] post-flush save failed for tab ${state.id}`, err);
        });
      }
    }
    /* Re-assert the newest index payload — if its async write was still in
       flight when quit began, this guarantees it lands. Identical content to
       what the async path writes, so the dedupe cache stays valid. */
    if (this.lastIndexJson !== null) {
      try {
        writeSync(this.indexPath, this.lastIndexJson);
      } catch (err) {
        console.warn("[claude-cli-chat] sync flush failed for tab index", err);
      }
    }
  }

  async deleteTab(id: string): Promise<void> {
    /* Cancel any pending debounce timer so it can't fire after we delete. */
    const pending = this.pendingWrites.get(id);
    if (pending) {
      clearTimeout(pending.handle);
      this.pendingWrites.delete(id);
    }
    /* Wait for any in-flight save to finish before removing — otherwise
       the save's tmp-then-rename could resurrect the file post-delete. */
    const inflight = this.inflightSaves.get(id);
    if (inflight) {
      try { await inflight; } catch { /* ignore — we're deleting anyway */ }
    }
    const adapter = platform.storage;
    const path = this.convPath(id);
    if (await adapter.exists(path)) await adapter.remove(path);
    const metaPath = this.metaPath(id);
    if (await adapter.exists(metaPath)) await adapter.remove(metaPath);
  }

  /* Flush all pending debounced writes. Called on plugin unload so the
     last 500ms of edits aren't lost. Triggers any pending timer to fire
     immediately, then awaits all in-flight saves so we don't return until
     every byte is on disk. */
  async flush(): Promise<void> {
    /* Fire any pending debounced timers immediately. saveTab itself will
       register inflight entries, which we then await below. */
    const pending = Array.from(this.pendingWrites.values());
    this.pendingWrites.clear();
    const triggered: Promise<void>[] = [];
    for (const { handle, state } of pending) {
      clearTimeout(handle);
      triggered.push(this.saveTab(this.snapshotState(state)));
    }
    /* Await both the writes we just triggered AND any already-running
       saves dispatched by prior timer fires. Snapshotting inflightSaves
       handles the case where a timer fired between scheduleSaveTab and
       flush — the dispatch already removed the pending entry, so the
       only handle on it is in inflightSaves. */
    const inflight = Array.from(this.inflightSaves.values());
    const results = await Promise.allSettled([...triggered, ...inflight]);
    /* allSettled never rejects, so without this a failed final write (disk
       full, EACCES) would vanish silently on unload and the user would lose
       their last edits with no signal. Surface the failures. */
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed.length > 0) {
      console.warn(`[claude-cli-chat] ${failed.length} tab write(s) failed during flush`, failed.map(f => f.reason));
    }
    /* The index is written fire-and-forget by the view; await the most
       recent dispatch so a tab add/remove/title/sessionId change landing
       just before quit isn't truncated mid-write. Rejection is already
       swallowed on this handle. */
    await this.lastIndexWrite;
  }

  /* List stored tab files (used by the History dropdown). Returns metadata
     only — reads the small `.meta.json` sidecar per tab so we don't slurp
     every conversation body just to count messages. Falls back to reading
     the full file if a sidecar is missing (e.g. old data from before
     sidecars existed). */
  async listConversations(): Promise<Array<{ id: string; title: string; updatedAt: number; messageCount: number }>> {
    const adapter = platform.storage;
    if (!(await adapter.exists(this.convDir))) return [];
    const listing = await adapter.list(this.convDir);
    const out: Array<{ id: string; title: string; updatedAt: number; messageCount: number }> = [];
    /* Only conversation files drive the listing — meta sidecars are an
       implementation detail. Filtering on `.meta.json` first prevents
       double-counting (the suffix matches `.json` too). */
    for (const file of listing.files) {
      if (!file.endsWith(".json") || file.endsWith(".meta.json") || file.endsWith(".tmp")) continue;
      const id = file.slice(file.lastIndexOf("/") + 1).replace(/\.json$/, "");
      const metaPath = this.metaPath(id);
      try {
        if (await adapter.exists(metaPath)) {
          const meta = JSON.parse(await adapter.read(metaPath)) as Partial<TabMeta>;
          out.push({
            id,
            title: typeof meta.title === "string" && meta.title ? meta.title : "Untitled",
            updatedAt: typeof meta.updatedAt === "number" ? meta.updatedAt : 0,
            messageCount: typeof meta.messageCount === "number" ? meta.messageCount : 0,
          });
          continue;
        }
        /* Fallback: no sidecar yet, fall back to reading the body. Costs
           one full-file read but only on legacy data. */
        const stored = JSON.parse(await adapter.read(file)) as Partial<StoredTab>;
        const messageCount = typeof stored.messageCount === "number"
          ? stored.messageCount
          : Array.isArray(stored.messages) ? stored.messages.length : 0;
        out.push({
          id: typeof stored.id === "string" ? stored.id : id,
          title: stored.title || "Untitled",
          updatedAt: typeof stored.updatedAt === "number" ? stored.updatedAt : 0,
          messageCount,
        });
      } catch {
        /* skip unreadable files */
      }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out;
  }

  private convPath(id: string): string {
    return `${this.convDir}/${id}.json`;
  }

  private metaPath(id: string): string {
    return `${this.convDir}/${id}.meta.json`;
  }
}
