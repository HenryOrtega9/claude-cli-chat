import type { App } from "obsidian";
import type { ChatMessage, TabState, ToolCall } from "../view/state";
import { writeJsonAtomic } from "../mcp/MCPConfig";

/* Persisted shape of a tab. Excludes runtime-only state (pendingApprovals,
   busy) since those are bound to a live subprocess and cannot survive a
   restart. Per-tab overrides (model/effort/mode/snippet) DO persist so the
   user's tab settings survive an Obsidian reload. */
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
  private dir = ".claude-cli-chat";
  private convDir = `${this.dir}/conversations`;
  private indexPath = `${this.dir}/tabs.json`;
  private pendingWrites = new Map<string, { handle: ReturnType<typeof setTimeout>; state: TabState }>();
  /* Per-tab in-flight save promise. Used by deleteTab/flush to await a save
     that's already started before issuing remove() or returning. */
  private inflightSaves = new Map<string, Promise<void>>();

  constructor(private app: App) {}

  private async ensureDirs(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(this.dir))) await adapter.mkdir(this.dir);
    if (!(await adapter.exists(this.convDir))) await adapter.mkdir(this.convDir);
  }

  async loadIndex(): Promise<TabIndex | null> {
    const adapter = this.app.vault.adapter;
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
    const adapter = this.app.vault.adapter;
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
      busy: false,
      model: typeof stored.model === "string" ? stored.model : undefined,
      effort: typeof stored.effort === "string" ? stored.effort : undefined,
      permissionMode: typeof stored.permissionMode === "string" ? stored.permissionMode : undefined,
      envSnippetId: typeof stored.envSnippetId === "string" ? stored.envSnippetId : undefined,
      pinnedFilePaths: Array.isArray(stored.pinnedFilePaths) ? stored.pinnedFilePaths : undefined,
      stickyPinnedFilePaths: Array.isArray(stored.stickyPinnedFilePaths) ? stored.stickyPinnedFilePaths : undefined,
    };
  }

  async saveIndex(index: TabIndex): Promise<void> {
    await this.ensureDirs();
    await writeJsonAtomic(this.app.vault.adapter, this.indexPath, index);
  }

  /* Debounced per-tab write. Coalesces rapid streaming updates so we write
     at most once every 500ms per tab. The TabState is snapshotted at
     schedule time so a later mutation (or destroy) doesn't corrupt the
     write payload mid-flight. */
  scheduleSaveTab(state: TabState): void {
    const existing = this.pendingWrites.get(state.id);
    if (existing) clearTimeout(existing.handle);
    const snapshot = this.snapshotState(state);
    const handle = setTimeout(() => {
      this.pendingWrites.delete(state.id);
      void this.saveTab(snapshot);
    }, 500);
    this.pendingWrites.set(state.id, { handle, state: snapshot });
  }

  /* Shallow-clone the persisted-relevant fields into a fresh object so
     a tab destroy or message mutation between schedule and flush doesn't
     surface as a torn write. messages is array-cloned with each entry
     shallow-cloned too, since streaming mutates entry.content in place. */
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

  private async doSaveTab(state: TabState): Promise<void> {
    await this.ensureDirs();
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
        toolCalls: m.toolCalls,
        durationMs: m.durationMs,
        thinking: m.thinking,
        selectionContext: m.selectionContext,
      })),
      messageCount: state.messages.length,
      model: state.model,
      effort: state.effort,
      permissionMode: state.permissionMode,
      envSnippetId: state.envSnippetId,
      pinnedFilePaths: state.pinnedFilePaths,
      stickyPinnedFilePaths: state.stickyPinnedFilePaths,
    };
    const adapter = this.app.vault.adapter;
    await writeJsonAtomic(adapter, this.convPath(state.id), stored);
    /* Sidecar meta file lets listConversations skip the full body read.
       Written atomically too so a crash mid-rotation never leaves the
       History dropdown reading half-written JSON. */
    const meta: TabMeta = {
      title: stored.title,
      updatedAt: stored.updatedAt,
      messageCount: stored.messages.length,
    };
    await writeJsonAtomic(adapter, this.metaPath(state.id), meta);
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
    const adapter = this.app.vault.adapter;
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
      triggered.push(this.saveTab(state));
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
  }

  /* List stored tab files (used by the History dropdown). Returns metadata
     only — reads the small `.meta.json` sidecar per tab so we don't slurp
     every conversation body just to count messages. Falls back to reading
     the full file if a sidecar is missing (e.g. old data from before
     sidecars existed). */
  async listConversations(): Promise<Array<{ id: string; title: string; updatedAt: number; messageCount: number }>> {
    const adapter = this.app.vault.adapter;
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
