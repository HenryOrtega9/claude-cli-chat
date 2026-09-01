/* TabRegistry — the tab store, the child-process budget, and the LRU.

   Tabs are cheap (a JSON file and a seq counter); children are not. The
   registry keeps every tab addressable forever and caps how many of them hold
   a live `claude` child at once (VAULT_GATEWAY_MAX_CHILDREN, default 4). When
   the budget is full, the least-recently-active EVICTABLE tab loses its child:
   the sessionId survives, so the next turn respawns with `--resume` and the
   conversation is unbroken.

   Evictable excludes any tab that is busy or holds a pending approval —
   killing either would strand a turn the phone is actively watching. If
   nothing is evictable the new turn is refused with 503 rather than
   over-subscribing the machine. */

import { randomUUID } from "node:crypto";

import { SubprocessManager } from "../../../src/claude/SubprocessManager";
import { Persistence } from "../../../src/storage/Persistence";
import type { TabState } from "../../../src/view/state";

import { DEFAULT_PERMISSION_MODE, TabEngine, type EngineDeps } from "./engine";
import type { Frame } from "./frames";

export class NoCapacityError extends Error {
  constructor() {
    super("no_capacity");
    this.name = "NoCapacityError";
  }
}

/* The id grammar the daemon actually mints — `ios-<base36>-<base36>` (see
   create() below) plus whatever a restored id already looked like, which was
   minted the same way in an earlier process. Any route that turns a
   caller-supplied id into a filesystem path (reopen() is the one today —
   everything else goes through the in-memory `tabs` Map) must reject
   anything outside this shape before it reaches Persistence, or a
   percent-encoded `../..` id survives WHATWG URL normalization (which only
   canonicalizes literal `..` segments, not encoded ones) long enough to read
   or create a file outside the tab store. */
export const TAB_ID_RE = /^[A-Za-z0-9_-]+$/;

export type RegistryDeps = {
  vault: string;
  storeDir: string;
  claudePath: string;
  maxChildren: number;
  approvalTimeoutMs: number;
  includePartialMessages: boolean;
  mcpDenyPatterns: () => string[];
  emit: (frame: Frame) => void;
  onStateChange: () => void;
  log: (msg: string) => void;
};

export class TabRegistry {
  readonly persistence: Persistence;
  readonly subprocess = new SubprocessManager();
  private tabs = new Map<string, TabEngine>();
  private activeTabId: string | null = null;

  constructor(private deps: RegistryDeps) {
    this.persistence = new Persistence(null, deps.storeDir);
  }

  /* Rehydrate whatever the last run left behind, so a daemon restart doesn't
     look like data loss to a phone holding tab ids. Children are NOT
     respawned: a tab gets one on its next turn. */
  async restore(): Promise<void> {
    const index = await this.persistence.loadIndex();
    if (!index) return;
    this.activeTabId = index.activeTabId;
    for (const entry of index.tabs) {
      const state = await this.persistence.loadTab(entry.id);
      if (!state) continue;
      const engine = this.makeEngine({ id: entry.id, restored: state });
      await engine.restoreFromDisk();
      this.tabs.set(entry.id, engine);
    }
    this.deps.log(`restored ${this.tabs.size} tab(s) from ${this.deps.storeDir}`);
  }

  private makeEngine(init: {
    id: string;
    sessionId?: string;
    title?: string;
    model?: string;
    effort?: string;
    permissionMode?: string;
    incognito?: boolean;
    restored?: TabState;
  }): TabEngine {
    const engineDeps: EngineDeps = {
      vault: this.deps.vault,
      claudePath: this.deps.claudePath,
      approvalTimeoutMs: this.deps.approvalTimeoutMs,
      includePartialMessages: this.deps.includePartialMessages,
      eventsDir: `${this.deps.vault}/${this.deps.storeDir}/events`,
      subprocess: this.subprocess,
      persistence: this.persistence,
      mcpDenyPatterns: this.deps.mcpDenyPatterns,
      emit: this.deps.emit,
      onActivity: () => this.deps.onStateChange(),
      log: this.deps.log,
    };
    return new TabEngine(engineDeps, init);
  }

  list(): TabEngine[] {
    return Array.from(this.tabs.values());
  }

  get(id: string): TabEngine | null {
    return this.tabs.get(id) ?? null;
  }

  index() {
    return {
      activeTabId: this.activeTabId,
      tabs: this.list().map(t => t.indexEntry()),
    };
  }

  setActive(id: string): void {
    if (!this.tabs.has(id)) return;
    this.activeTabId = id;
    void this.saveIndex();
  }

  create(opts: { title?: string; model?: string; effort?: string; permissionMode?: string; incognito?: boolean }): TabEngine {
    const id = `ios-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const engine = this.makeEngine({
      id,
      sessionId: randomUUID(),
      title: opts.title ?? "New chat",
      model: opts.model,
      effort: opts.effort,
      /* bypassPermissions is refused outright: a phone tab must never be able
         to run unprompted tools, and silently downgrading would leave the user
         believing they had set it. */
      permissionMode: opts.permissionMode === "bypassPermissions"
        ? DEFAULT_PERMISSION_MODE
        : (opts.permissionMode ?? DEFAULT_PERMISSION_MODE),
      incognito: opts.incognito,
    });
    this.tabs.set(id, engine);
    if (!this.activeTabId) this.activeTabId = id;
    void this.saveIndex();
    this.deps.onStateChange();
    return engine;
  }

  /* "Close" the tab: drop its live child and take it out of the OPEN index
     (GET /tabs, the tab bar) so it stops being addressable as a live tab.
     The conversation and its meta sidecar are deliberately left on disk —
     see reopen() below and GET /conversations — so History can still list
     and restore it. Only the replay ring's ndjson spill is discarded (via
     engine.destroy()); nothing streams into a closed tab, so there is
     nothing there for a client to catch up on. Incognito tabs are the one
     exception: they never wrote a conversation file to begin with
     (TabEngine.save() no-ops), so this is already the equivalent of a full
     delete for them. */
  async remove(id: string): Promise<boolean> {
    const engine = this.tabs.get(id);
    if (!engine) return false;
    this.tabs.delete(id);
    if (this.activeTabId === id) this.activeTabId = this.list()[0]?.id ?? null;
    await engine.destroy();
    await this.saveIndex();
    this.deps.onStateChange();
    return true;
  }

  /* Revive a tab History still knows about but that isn't currently live —
     either it was never restored (a cold rehydrate skips nothing, so this is
     really only reachable for a tab closed via remove() above) or it was
     closed and its conversation file survived. Returns the SAME engine
     (idempotent) if the tab is already open. Returns null when there is
     truly no persisted conversation under that id — a tab that never
     existed, or an incognito tab (which never wrote one). Reopening puts the
     tab back in the OPEN index, exactly like a fresh POST /tabs, so it shows
     up in the tab bar / GET /tabs again and is addressable for turns. */
  async reopen(id: string): Promise<TabEngine | null> {
    /* Guard here too, not just in server.ts's route: this is the one place a
       caller-supplied id turns into a filesystem path (Persistence.loadTab ->
       NodeFileStorage.abs, no containment check of its own), so any future
       caller of reopen() is covered even if it skips the HTTP layer's own
       check. */
    if (!TAB_ID_RE.test(id)) return null;
    const existing = this.tabs.get(id);
    if (existing) return existing;
    const state = await this.persistence.loadTab(id);
    if (!state) return null;
    const engine = this.makeEngine({ id, restored: state });
    await engine.restoreFromDisk();
    this.tabs.set(id, engine);
    if (!this.activeTabId) this.activeTabId = id;
    await this.saveIndex();
    this.deps.onStateChange();
    return engine;
  }

  liveChildren(): number {
    return this.list().filter(t => t.hasLiveChild).length;
  }

  /* Called before a turn spawns. Frees a slot if the budget is full; throws
     NoCapacityError when every live tab is busy or holding an approval. */
  async makeRoomFor(target: TabEngine): Promise<void> {
    if (target.hasLiveChild) return;
    while (this.liveChildren() >= this.deps.maxChildren) {
      const victim = this.list()
        .filter(t => t.id !== target.id && t.evictable)
        .sort((a, b) => a.lastActivityAt - b.lastActivityAt)[0];
      if (!victim) throw new NoCapacityError();
      await victim.evict("lru");
    }
  }

  /* The on-disk projection of the tab list: everything index() reports minus
     any incognito tab. index() itself stays unfiltered — GET /tabs and the
     live tab bar legitimately show an incognito tab for as long as THIS
     process has it open — but persisting its id, generated title and
     established sessionId into tabs.json is exactly the disk write
     CLAUDE.md's incognito rule (and TabEngine.save()'s no-op) exist to
     prevent. Falls back to the first surviving tab (or null) when the
     currently-active tab is the one being filtered out, so a restored index
     never points activeTabId at a tab that isn't in it. */
  private persistableIndex() {
    const tabs = this.list().filter(t => !t.incognito);
    const activeStillPresent = this.activeTabId !== null && tabs.some(t => t.id === this.activeTabId);
    return {
      activeTabId: activeStillPresent ? this.activeTabId : (tabs[0]?.id ?? null),
      tabs: tabs.map(t => t.indexEntry()),
    };
  }

  async saveIndex(): Promise<void> {
    try {
      await this.persistence.saveIndex(this.persistableIndex());
    } catch (err) {
      this.deps.log(`index save failed: ${String(err)}`);
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.list().map(t => t.evict("shutdown")));
    await Promise.all(this.list().map(t => t.flush()));
    await this.saveIndex();
    await this.persistence.flush().catch(() => undefined);
    await this.subprocess.killAll();
  }
}
