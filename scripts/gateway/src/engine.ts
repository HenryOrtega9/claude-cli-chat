/* TabEngine — one chat tab's whole server-side life.

   Owns: the CLI child (via the shared SubprocessManager/TabSession), the tab's
   status, its monotonic seq counter and replay ring, pending approvals and
   their deadline timers, the busy flag, and the projection of the event stream
   into a StoredTab on disk so `GET /tabs/:id` returns something a freshly
   installed phone can render.

   Two things it deliberately does NOT do: render, and decide policy. Frames go
   out through the `emit` callback the registry hands it; eviction and the max-
   children budget are the registry's business.

   Session identity: the id is generated at tab creation and passed as
   `--session-id` on the FIRST spawn, so a tab has a stable identity before it
   has ever run. Every later spawn (after an LRU eviction, a crash, or a
   model/effort change) passes `--resume <sessionId>` instead. That is why
   there is no transcript-discovery path here, unlike RemoteControlSession. */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

import { SubprocessManager, type SpawnOptions, type TabSession } from "../../../src/claude/SubprocessManager";
import type {
  AssistantEvent,
  ContentBlock,
  ControlRequestEvent,
  ResultEvent,
  StreamEvent,
  ToolUseBlock,
  UsageSnapshot,
} from "../../../src/claude/Events";
import { projectDirFor, sessionFilePathFor } from "../../../src/claude/session-files";
import type { Persistence } from "../../../src/storage/Persistence";
import type { ChatMessage, TabState, ToolCall } from "../../../src/view/state";
import { MODEL_IDS, type ModelKey, type PermissionMode } from "../../../src/settings-data";

import { makeFrame, type Frame, type FrameType } from "./frames";
import { ReplayRing } from "./replay";

export type TabStatus = "idle" | "starting" | "ready" | "running" | "exited" | "error";

export const APPROVAL_TIMEOUT_MESSAGE = "Client unreachable; denied by gateway timeout";

/* Phone tabs default to acceptEdits: the user is on a 6-inch screen and every
   approval round-trip costs a push notification, so file edits ride through
   while genuinely risky tools (Bash, WebFetch, deletes) still prompt.
   bypassPermissions is never a legal value here — see setConfig(). */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "acceptEdits";

export type TabPatch = {
  title?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  pinnedFilePaths?: string[];
  /* Composer draft text. The one field of a StoredTab write the client
     legitimately owns — see RemoteFileStorage's applyConversation(). */
  draft?: string;
};

export type EngineDeps = {
  vault: string;
  claudePath: string;
  approvalTimeoutMs: number;
  includePartialMessages: boolean;
  eventsDir: string;
  subprocess: SubprocessManager;
  persistence: Persistence;
  mcpDenyPatterns: () => string[];
  emit: (frame: Frame) => void;
  onActivity: (engine: TabEngine) => void;
  log: (msg: string) => void;
};

function makeMessageId(): string {
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* Accepts either a ModelKey from the picker ("opus-5") or a raw CLI model id
   ("claude-opus-5[1m]", "haiku", "opusplan"). The phone sends keys; a power
   user poking the HTTP API directly may send an id. */
function resolveModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  if (model in MODEL_IDS) return MODEL_IDS[model as ModelKey];
  return model;
}

export class TabEngine {
  readonly id: string;
  readonly incognito: boolean;

  /* Mutable behind a getter rather than `readonly`: clear() mints a new one so
     the next turn starts a genuinely fresh CLI conversation instead of
     `--resume`-ing the one the user just discarded. Every reader outside this
     class only ever reads it. */
  private _sessionId: string;
  get sessionId(): string { return this._sessionId; }

  /* The sessionId exposed to callers OUTSIDE this class (POST /tabs,
     GET /tabs, GET /tabs/:id). Null until a conversation genuinely exists
     under it — see canResume(). Internal spawn logic keeps reading the real
     `sessionId` getter above directly; that identity is stable from the
     moment the tab is created regardless of whether the CLI has used it yet.

     This matters because the client's incognito lock keys off
     `state.sessionId !== null` (TabController): a phone tab whose id and
     sessionId are BOTH minted synchronously at POST /tabs time (registry.ts
     assigns `randomUUID()` unconditionally) used to report a non-null
     sessionId before the CLI had ever seen it, which permanently locked the
     incognito toggle on a tab that had nothing to protect yet. */
  get establishedSessionId(): string | null {
    return this.canResume() ? this._sessionId : null;
  }

  status: TabStatus = "idle";
  busy = false;
  lastActivityAt = Date.now();

  private seq = 0;
  private session: TabSession | null = null;
  /* True once THIS process has seen the child's `system/init`, which proves
     the CLI created the session and `--resume` is legal. Deliberately not set
     from the fact of rehydration; see canResume(). */
  private sessionEstablished = false;
  /* Set when a `--resume` spawn died before it ever emitted `system/init`,
     i.e. the CLI rejected the session id. Forces `--session-id` from then on. */
  private resumeUnavailable = false;
  /* Per-spawn: did this child resume, and did it get as far as `system/init`? */
  private resumedThisSpawn = false;
  private sawInitThisSpawn = false;
  private ring: ReplayRing;
  private pending = new Map<string, { req: ControlRequestEvent; timer: ReturnType<typeof setTimeout> }>();
  private state: TabState;
  private toolToMessage = new Map<string, string>();
  private currentAssistant: ChatMessage | null = null;
  /* The API message id (`msg_…`) the current bubble belongs to. One turn can
     span several API calls (text, then a tool_use, then the answer), and the
     client's live rendering starts a new bubble per call. Tracking the id here
     keeps the persisted projection split the same way; without it a restored
     conversation folded the whole turn into one bubble and rendered its tool
     rows AFTER the answer they produced. */
  private currentAssistantId: string | null = null;
  private currentTurn: { turnId: string; startedAt: number; blocks: ContentBlock[]; retriedWithoutResume?: boolean } | null = null;
  private stderrTail = "";
  private disposed = false;
  /* An engine-affecting patch landed while a child was alive: that child is
     running on the old model/effort/mode and must be replaced before the next
     turn. See patch() / prepareForTurn(). */
  private needsRespawn = false;
  private pendingTeardown: Promise<void> | null = null;
  /* Session ids THIS incognito tab has used. `--no-session-persistence`
     suppresses the transcript but the CLI still writes a one-line `ai-title`
     record (Wire Format Gotcha #6) — and any subagent transcripts — keyed by
     session id, under ~/.claude/projects/<slug>/. clear() mints a fresh id
     without cleaning up the one it's discarding (that would race a child
     that hasn't finished dying), so ids accumulate here and are purged in
     clear() and destroy(). Mirrors TabController.cleanupIncognitoSessionFiles
     on desktop. Always empty for a non-incognito tab. */
  private readonly incognitoSessionIds = new Set<string>();

  constructor(
    private deps: EngineDeps,
    init: {
      id: string;
      sessionId?: string;
      title?: string;
      model?: string;
      effort?: string;
      permissionMode?: string;
      incognito?: boolean;
      restored?: TabState;
    },
  ) {
    this.id = init.id;
    this._sessionId = init.sessionId ?? init.restored?.sessionId ?? randomUUID();
    this.incognito = init.incognito ?? false;
    this.ring = new ReplayRing(`${deps.eventsDir}/${this.id}.ndjson`);
    const now = Date.now();
    this.state = init.restored ?? {
      id: this.id,
      sessionId: this.sessionId,
      title: init.title ?? "New chat",
      createdAt: now,
      updatedAt: now,
      messages: [],
      pendingApprovals: new Map(),
      busy: false,
      model: init.model,
      effort: init.effort,
      permissionMode: init.permissionMode ?? DEFAULT_PERMISSION_MODE,
    };
    /* NOTE: a restored tab is NOT assumed to have an established session.
       POST /tabs mints a session id without spawning anything, so a tab that
       never took a turn before the daemon restarted has an id and no
       conversation. canResume() asks the disk instead. */
    this.state.sessionId = this.sessionId;
    if (init.title) this.state.title = init.title;
    if (init.model) this.state.model = init.model;
    if (init.effort) this.state.effort = init.effort;
    if (init.permissionMode) this.state.permissionMode = init.permissionMode;
    /* Persist a brand-new tab straight away. The index lists it either way,
       but restore() drops any entry whose conversation file is missing, so a
       tab created and not used before a restart would otherwise 404 on the
       phone that is holding its id. */
    if (!init.restored) this.save();
  }

  /* ---------- public surface ---------- */

  get title(): string { return this.state.title; }
  get model(): string | undefined { return this.state.model; }
  get effort(): string | undefined { return this.state.effort; }
  get permissionMode(): string { return this.state.permissionMode ?? DEFAULT_PERMISSION_MODE; }
  get lastSeq(): number { return this.seq; }
  get pid(): number | undefined { return this.session?.pid; }
  get hasLiveChild(): boolean { return this.session !== null && !this.session.isTerminal(); }
  get hasPendingApprovals(): boolean { return this.pending.size > 0; }
  get evictable(): boolean { return !this.busy && this.pending.size === 0 && this.hasLiveChild; }

  snapshot() {
    return {
      id: this.id,
      status: this.status,
      busy: this.busy,
      sessionId: this.sessionId,
      model: this.state.model ?? null,
      effort: this.state.effort ?? null,
      permissionMode: this.permissionMode,
      pid: this.pid ?? null,
      lastSeq: this.seq,
    };
  }

  storedTab() {
    return {
      id: this.state.id,
      sessionId: this.establishedSessionId,
      title: this.state.title,
      createdAt: this.state.createdAt,
      updatedAt: this.state.updatedAt,
      messages: this.state.messages,
      messageCount: this.state.messages.length,
      model: this.state.model,
      effort: this.state.effort,
      permissionMode: this.state.permissionMode,
      pinnedFilePaths: this.state.pinnedFilePaths,
      draft: this.state.draft,
      pendingApprovals: this.pendingApprovalFrames(),
      busy: this.busy,
      status: this.status,
      lastSeq: this.seq,
    };
  }

  indexEntry() {
    return { id: this.id, title: this.state.title, sessionId: this.establishedSessionId };
  }

  /* Engine-affecting patches (model/effort/permissionMode) do NOT restart a
     live child — the contract says they take effect on the next turn's
     respawn, so a patch mid-turn can never orphan a running child. */
  patch(p: TabPatch): void {
    const before = `${this.state.model}|${this.state.effort}|${this.state.permissionMode}`;
    if (typeof p.title === "string" && p.title.trim()) this.state.title = p.title.trim();
    if (typeof p.model === "string") this.state.model = p.model;
    if (typeof p.effort === "string") this.state.effort = p.effort;
    if (typeof p.permissionMode === "string" && p.permissionMode !== "bypassPermissions") {
      this.state.permissionMode = p.permissionMode;
    }
    /* A live child cannot change model, effort or permission mode: those are
       argv. The desktop client kills its child on such a change and the remote
       client's dispose() maps to /abort, but a client that patched WITHOUT
       holding a session (a page that just reloaded, or any second client)
       would otherwise leave the daemon reusing a child spawned on the old
       settings, and the change would silently not apply. Own it here instead
       of trusting the caller: drop the child now if the tab is idle, or at the
       start of the next turn if it is mid-turn or holding an approval. */
    if (`${this.state.model}|${this.state.effort}|${this.state.permissionMode}` !== before && this.hasLiveChild) {
      this.needsRespawn = true;
      if (!this.busy && this.pending.size === 0) this.pendingTeardown = this.dropChildForRespawn();
    }
    if (Array.isArray(p.pinnedFilePaths)) this.state.pinnedFilePaths = p.pinnedFilePaths;
    /* Draft is not engine-affecting — it never touches `before` above, so a
       draft-only patch never drops a live child. */
    if (typeof p.draft === "string") this.state.draft = p.draft || undefined;
    this.state.updatedAt = Date.now();
    this.save();
    this.emit("tab_status", this.statusPayload());
  }

  firstUserMessage(): string | null {
    const msg = this.state.messages.find(m => m.role === "user");
    return msg ? msg.content : null;
  }

  firstAssistantMessage(): string | null {
    const msg = this.state.messages.find(m => m.role === "assistant");
    return msg ? msg.content : null;
  }

  setTitle(title: string): void {
    this.state.title = title;
    this.state.updatedAt = Date.now();
    this.save();
  }

  async replaySince(since: number, limit?: number) {
    return this.ring.since(since, limit);
  }

  /* Resume the seq counter from whatever this tab's replay ndjson already
     holds, instead of leaving it at the constructor's 0. Restricted to
     restored/reopened tabs (the registry calls this only when `init.restored`
     was passed) — a brand-new tab has no existing file, and ring.recoverTail()
     is a no-op (returns 0) when there is none.

     Without this, a daemon restart (launchd KeepAlive: crash, `kickstart -k`
     after a rebuild, a Mac wake) left `seq` at 0 while a phone still resident
     in memory kept its last-seen cursor from before the restart. The first
     live frame after restart then carried seq 1, sitting below every cursor
     the client already held, so `GatewayConnection`'s monotonic guard dropped
     it and everything after it — the tab went permanently silent until the
     app was force-reloaded. Resuming the counter here means the client's old
     cursor and the engine's restored one agree, so a reconnect either needs
     no replay at all (cursor === restored seq) or a normal bounded one — and
     it means the ndjson spill on disk, which nothing truncates across a
     restart, never ends up holding two generations of frames under the same
     seq numbers. */
  async restoreFromDisk(): Promise<void> {
    this.seq = await this.ring.recoverTail();
  }

  /* ---------- turns ---------- */

  /* Awaited by the server immediately before submit(): settles any child
     replacement an engine-affecting patch asked for, so the turn always spawns
     on the settings the tab currently advertises. */
  async prepareForTurn(): Promise<void> {
    const pending = this.pendingTeardown;
    if (pending) {
      this.pendingTeardown = null;
      await pending;
    }
    /* A busy tab is about to be rejected with 409; never take its child. */
    if (this.busy) return;
    if (this.needsRespawn && this.hasLiveChild) await this.dropChildForRespawn();
  }

  private async dropChildForRespawn(): Promise<void> {
    this.needsRespawn = false;
    await this.teardownSession();
    if (this.disposed) return;
    this.status = "idle";
    this.emit("tab_status", this.statusPayload());
    this.deps.log(`tab ${this.id}: child released (config change)`);
  }

  submit(blocks: ContentBlock[], clientTurnId?: string): { turnId: string; seq: number } {
    if (this.busy) throw new BusyError();
    const turnId = clientTurnId || `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.busy = true;
    this.state.busy = true;
    this.currentTurn = { turnId, startedAt: Date.now(), blocks };
    this.touch();

    /* Project the user turn immediately rather than waiting for the CLI's
       echo: if the child dies before it reads stdin, the phone must still see
       what it sent when it re-fetches the tab. */
    const text = blocks.filter((b): b is { type: "text"; text: string } => b.type === "text").map(b => b.text).join("\n");
    const attachmentCount = blocks.length - blocks.filter(b => b.type === "text").length;
    const userMsg: ChatMessage = {
      id: makeMessageId(),
      role: "user",
      content: text,
      timestamp: Date.now(),
      ...(attachmentCount > 0
        ? { attachments: blocks.filter(b => b.type !== "text").map(b => ({
            kind: (b.type === "image" ? "image" : "pdf") as ChatMessage["attachments"] extends undefined ? never : "image" | "pdf",
            mediaType: b.type === "image" || b.type === "document" ? b.source.media_type : "application/octet-stream",
          })) }
        : {}),
    };
    this.state.messages.push(userMsg);
    this.currentAssistant = null;
    this.currentAssistantId = null;
    this.state.updatedAt = Date.now();
    this.save();

    const session = this.ensureSession();
    const seq = this.emit("tab_status", this.statusPayload("running"));
    try {
      session.sendUserContent(blocks);
    } catch (err) {
      this.busy = false;
      this.state.busy = false;
      this.currentTurn = null;
      throw err;
    }
    return { turnId, seq };
  }

  /* Mirrors TabController.cancelStream: deny every outstanding approval so the
     CLI isn't left waiting on a response that will never come, then kill the
     child. The next turn respawns with --resume, so the conversation survives
     a cancel. */
  async abort(): Promise<void> {
    for (const requestId of Array.from(this.pending.keys())) {
      this.resolveApproval(requestId, false, "User cancelled", undefined, "cancel");
    }
    const hadTurn = this.currentTurn;
    await this.teardownSession();
    this.busy = false;
    this.state.busy = false;
    this.markRunningToolsErrored();
    if (hadTurn) {
      this.emit("turn_done", {
        turnId: hadTurn.turnId,
        subtype: "aborted",
        durationMs: Date.now() - hadTurn.startedAt,
      });
    }
    this.currentTurn = null;
    this.status = "idle";
    this.emit("tab_status", this.statusPayload());
    this.save();
  }

  /* Reset the tab IN PLACE — the desktop's TabController.clear(), moved to the
     side that actually owns the conversation. The tab id, its slot in the index
     and its model / effort / permission mode survive; the child, the messages,
     the replay history and the session id do not.

     The new session id is the whole point. Wiping only the projection would
     leave the next turn spawning `--resume <old uuid>`, so the model would
     answer carrying the full context of a conversation the user believes they
     discarded. That is precisely why the phone could not just call
     TabController.clear() locally, and why this is a server operation. */
  async clear(): Promise<{ sessionId: string; lastSeq: number }> {
    /* Settle a queued child-replacement first: it must not land on the child
       the next turn will spawn under the new id. */
    const queued = this.pendingTeardown;
    if (queued) {
      this.pendingTeardown = null;
      await queued;
    }
    /* abort() denies every outstanding approval, kills the child, releases the
       busy flag and tells clients the in-flight turn is over — all four are
       what discarding a conversation mid-stream should do. */
    if (this.busy || this.hasLiveChild || this.pending.size > 0) await this.abort();

    /* The child that used the OLD id is confirmed dead now (abort() awaited
       teardownSession()), so its ai-title residue is safe to remove before
       a new id takes its place. */
    if (this.incognito) await this.cleanupIncognitoSessionFiles();

    this._sessionId = randomUUID();
    this.sessionEstablished = false;
    this.resumeUnavailable = false;
    this.resumedThisSpawn = false;
    this.sawInitThisSpawn = false;
    this.needsRespawn = false;
    this.toolToMessage.clear();
    this.currentAssistant = null;
    this.currentAssistantId = null;
    this.currentTurn = null;
    this.stderrTail = "";
    this.busy = false;
    this.status = "idle";

    const now = Date.now();
    this.state.messages = [];
    this.state.pendingApprovals.clear();
    this.state.sessionId = this._sessionId;
    this.state.title = "New chat";
    this.state.createdAt = now;
    this.state.updatedAt = now;
    this.state.busy = false;
    /* "New chat" discards whatever was mid-typed too. */
    this.state.draft = undefined;

    /* Wipe the replay history BEFORE the two frames below, so they become the
       first entries of the new one and any client still holding an older cursor
       is told to resync rather than being handed frames from a conversation
       that no longer exists. */
    await this.ring.reset(this.seq + 1);
    this.emit("tab_status", this.statusPayload());
    const lastSeq = this.emit("resync", { reason: "cleared", sessionId: this._sessionId });

    /* Straight to disk rather than through the 500 ms debounce: a daemon killed
       inside that window would come back holding the conversation the user just
       discarded, which is exactly the bug this route exists to fix. Incognito
       tabs keep touching nothing. */
    if (!this.incognito) await this.deps.persistence.saveTab(this.state).catch(() => undefined);
    this.touch();
    return { sessionId: this._sessionId, lastSeq };
  }

  approve(requestId: string, allowed: boolean, reason?: string, updatedInput?: Record<string, unknown>): boolean {
    if (!this.pending.has(requestId)) return false;
    this.resolveApproval(requestId, allowed, reason, updatedInput, "client");
    return true;
  }

  pendingApprovalFrames(): Array<Record<string, unknown>> {
    return Array.from(this.pending.values()).map(p => ({ ...p.req.request, request_id: p.req.request_id }));
  }

  /* Drop the child but keep the tab: LRU eviction, and the shutdown path.
     sessionId survives, so the next turn resumes the same conversation. */
  async evict(reason: "lru" | "shutdown" | "delete"): Promise<void> {
    for (const requestId of Array.from(this.pending.keys())) {
      this.resolveApproval(requestId, false, APPROVAL_TIMEOUT_MESSAGE, undefined, "restart");
    }
    await this.teardownSession();
    if (reason !== "delete") {
      this.status = "idle";
      this.emit("tab_status", this.statusPayload());
    }
    this.deps.log(`tab ${this.id}: child released (${reason})`);
  }

  async destroy(): Promise<void> {
    this.disposed = true;
    await this.evict("delete");
    if (this.incognito) await this.cleanupIncognitoSessionFiles();
    await this.ring.destroy();
  }

  /* Delete every on-disk file the CLI wrote for this incognito tab's
     sessions: the per-session `<id>.jsonl` (ai-title residue) and the
     `<id>/` subdirectory (subagent transcripts). Best-effort and idempotent
     — `rm` with `force` never throws on a missing path. Only this tab's own
     session ids are ever in the set, so this never touches another tab's
     files in the shared project dir. Mirrors
     TabController.cleanupIncognitoSessionFiles on desktop; the daemon has no
     `plugin.removeSessionFiles` host indirection to go through since it IS
     the node process. */
  private async cleanupIncognitoSessionFiles(): Promise<void> {
    if (this.incognitoSessionIds.size === 0) return;
    const ids = Array.from(this.incognitoSessionIds);
    this.incognitoSessionIds.clear();
    const dir = projectDirFor(this.deps.vault);
    await Promise.all(ids.flatMap(id => [
      rm(sessionFilePathFor(this.deps.vault, id), { force: true }).catch(() => undefined),
      rm(`${dir}/${id}`, { force: true, recursive: true }).catch(() => undefined),
    ]));
  }

  async flush(): Promise<void> {
    await this.ring.flush();
  }

  /* ---------- internals ---------- */

  private touch(): void {
    this.lastActivityAt = Date.now();
    this.deps.onActivity(this);
  }

  private emit(t: FrameType, payload: Record<string, unknown>): number {
    this.seq += 1;
    const frame = makeFrame(t, this.id, this.seq, payload);
    this.ring.push(frame);
    this.deps.emit(frame);
    return this.seq;
  }

  private statusPayload(override?: TabStatus): Record<string, unknown> {
    if (override) this.status = override;
    return {
      status: this.status,
      sessionId: this.sessionId,
      pid: this.pid ?? null,
      model: this.state.model ?? null,
      effort: this.state.effort ?? null,
      permissionMode: this.permissionMode,
      ...(this.stderrTail ? { stderrTail: this.stderrTail.slice(-2000) } : {}),
    };
  }

  private save(): void {
    if (this.incognito) return;
    this.deps.persistence.scheduleSaveTab(this.state);
  }

  /* `--resume <uuid>` is only legal for a conversation that actually exists.
     Three ways to know:
       - this process watched the child emit `system/init` for it (authoritative);
       - the CLI wrote a transcript for it under ~/.claude/projects (the case
         after a daemon restart, where the flag above is gone but the
         conversation is not);
       - otherwise it does not exist, and resuming it makes the CLI exit 1 with
         "No conversation found with session ID", surfacing every turn as
         error_during_execution forever.
     Incognito tabs spawn with --no-session-persistence, so their transcript is
     never a resume source; only the in-process flag counts for them. */
  private canResume(): boolean {
    if (this.resumeUnavailable) return false;
    if (this.sessionEstablished) return true;
    if (this.incognito) return false;
    try {
      return existsSync(sessionFilePathFor(this.deps.vault, this.sessionId));
    } catch {
      return false;
    }
  }

  private spawnOptions(): SpawnOptions {
    const extraArgs = ["--replay-user-messages"];
    /* First spawn declares the id; every later one resumes it. Passing both
       makes the CLI reject the invocation. */
    const resume = this.canResume();
    this.resumedThisSpawn = resume;
    if (!resume) extraArgs.push("--session-id", this.sessionId);
    return {
      cwd: this.deps.vault,
      sessionId: resume ? this.sessionId : undefined,
      model: resolveModel(this.state.model),
      effort: this.state.effort,
      claudePath: this.deps.claudePath,
      permissionMode: this.permissionMode as SpawnOptions["permissionMode"],
      includePartialMessages: this.deps.includePartialMessages,
      noSessionPersistence: this.incognito,
      mcpDenyPatterns: this.deps.mcpDenyPatterns(),
      extraArgs,
    };
  }

  private ensureSession(): TabSession {
    if (this.session && !this.session.isTerminal()) return this.session;
    this.status = "starting";
    this.stderrTail = "";
    this.sawInitThisSpawn = false;
    const session = this.deps.subprocess.spawn(this.id, this.spawnOptions());
    this.session = session;
    /* Identity guards: teardownSession() nulls `this.session` before the
       child has finished dying, so a replaced child's trailing events, stderr
       and exit must not be projected onto the tab that has already moved on.
       An ungated onExit would null out the session that replaced it. */
    session.onEvent(e => { if (this.session === session) this.handleEvent(e); });
    session.onStderr(chunk => {
      if (this.session !== session) return;
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    session.onError(err => {
      if (this.session === session) this.handleFatal(`spawn failed: ${err.message}`);
    });
    session.onExit((code, signal) => {
      if (this.session === session) this.handleExit(code, signal);
    });
    return session;
  }

  private async teardownSession(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (!session) return;
    try { await session.dispose(); } catch { /* already gone */ }
  }

  private handleEvent(event: StreamEvent): void {
    /* Every event goes out raw, exactly as StreamJsonParser yielded it. The
       phone's renderer is the same code the desktop UI runs, so it wants the
       unmodified wire shape — the typed frames below are additive. */
    this.emit("event", event as unknown as Record<string, unknown>);

    try {
      switch (event.type) {
        case "system":
          if ((event as { subtype?: string }).subtype === "init") {
            this.sessionEstablished = true;
            this.sawInitThisSpawn = true;
            /* A re-declared id that reached init exists again. */
            this.resumeUnavailable = false;
            this.status = this.busy ? "running" : "ready";
            /* Only an ESTABLISHED session actually wrote anything to disk
               (the ai-title residue), so only established ids need cleanup. */
            if (this.incognito) this.incognitoSessionIds.add(this._sessionId);
            this.emit("tab_status", this.statusPayload());
          }
          return;
        case "control_request":
          this.handleControlRequest(event as ControlRequestEvent);
          return;
        case "assistant":
          this.projectAssistant(event as AssistantEvent);
          return;
        case "user":
          this.projectToolResults(event as { message?: { content?: unknown } });
          return;
        case "result":
          this.handleResult(event as ResultEvent);
          return;
        default:
          return;
      }
    } catch (err) {
      /* Wire data is unvalidated JSON. A shape we've never seen must not take
         the daemon down or wedge the tab's busy flag. */
      this.deps.log(`tab ${this.id}: event projection failed (${event.type}): ${String(err)}`);
    }
  }

  private handleControlRequest(req: ControlRequestEvent): void {
    if (this.pending.has(req.request_id)) return;
    const timer = setTimeout(() => {
      this.deps.log(`tab ${this.id}: approval ${req.request_id} timed out after ${this.deps.approvalTimeoutMs}ms`);
      this.resolveApproval(req.request_id, false, APPROVAL_TIMEOUT_MESSAGE, undefined, "timeout");
    }, this.deps.approvalTimeoutMs);
    /* unref so a tab sitting on an approval doesn't hold the event loop open
       past a shutdown request. */
    timer.unref?.();
    this.pending.set(req.request_id, { req, timer });
    this.touch();
    this.emit("approval_request", { ...req.request, request_id: req.request_id });
  }

  private resolveApproval(
    requestId: string,
    allowed: boolean,
    reason: string | undefined,
    updatedInput: Record<string, unknown> | undefined,
    by: "client" | "timeout" | "restart" | "cancel",
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    const session = this.session;
    if (session && !session.isTerminal()) {
      /* Wire gotcha #4: the control_response schema is exactly
         {behavior:"allow", updatedInput} or {behavior:"deny", message}.
         TabSession.approve/deny build both; never hand-roll them here. */
      if (allowed) session.approve(requestId, updatedInput ?? entry.req.request.input ?? {});
      else session.deny(requestId, reason ?? "Denied");
    }
    this.touch();
    this.emit("approval_resolved", { request_id: requestId, allowed, by });
  }

  private projectAssistant(event: AssistantEvent): void {
    const apiId = (event.message as { id?: string } | undefined)?.id;
    if (apiId && apiId !== this.currentAssistantId) {
      this.currentAssistantId = apiId;
      this.currentAssistant = null;
    }
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const block of blocks) {
      if (block.type === "text") {
        const msg = this.ensureAssistantMessage();
        msg.content += block.text;
      } else if (block.type === "thinking") {
        const msg = this.ensureAssistantMessage();
        msg.thinking = (msg.thinking ?? "") + block.thinking;
      } else if (block.type === "tool_use") {
        /* Wire gotcha #2: tool_use blocks live INSIDE the assistant message's
           content array, never as top-level events. Filtering to text here
           would drop every tool row silently. */
        const tu = block as ToolUseBlock;
        const msg = this.ensureAssistantMessage();
        if (!msg.toolCalls) msg.toolCalls = [];
        if (!msg.toolCalls.some(t => t.id === tu.id)) {
          const call: ToolCall = { id: tu.id, name: tu.name, input: tu.input ?? {}, status: "running" };
          msg.toolCalls.push(call);
          this.toolToMessage.set(tu.id, msg.id);
        }
      }
    }
    this.state.updatedAt = Date.now();
    this.save();
  }

  /* Wire gotcha #3: tool_result blocks arrive inside synthetic `user` events.
     Missing this leaves every tool row stuck on RUNNING forever. Plain user
     echoes (which `--replay-user-messages` also produces) are ignored — the
     turn was already projected at submit time. */
  private projectToolResults(event: { message?: { content?: unknown } }): void {
    const content = event.message?.content;
    if (!Array.isArray(content)) return;
    let touched = false;
    for (const raw of content) {
      const block = raw as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      const msgId = this.toolToMessage.get(block.tool_use_id);
      const msg = msgId ? this.state.messages.find(m => m.id === msgId) : undefined;
      const call = msg?.toolCalls?.find(t => t.id === block.tool_use_id);
      if (!call) continue;
      call.status = block.is_error ? "errored" : "completed";
      call.isError = block.is_error === true;
      call.result = typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content ?? "");
      touched = true;
    }
    if (touched) {
      this.state.updatedAt = Date.now();
      this.save();
    }
  }

  private handleResult(event: ResultEvent): void {
    const turn = this.currentTurn;
    this.busy = false;
    this.state.busy = false;
    this.status = "ready";
    if (this.currentAssistant) {
      this.currentAssistant.streaming = false;
      if (turn) this.currentAssistant.durationMs = Date.now() - turn.startedAt;
    }
    this.currentAssistant = null;
    this.currentAssistantId = null;
    this.currentTurn = null;
    this.state.updatedAt = Date.now();
    this.save();
    this.touch();
    const usage: UsageSnapshot | undefined = event.usage;
    this.emit("turn_done", {
      turnId: turn?.turnId ?? null,
      subtype: event.subtype ?? (event.is_error ? "error" : "success"),
      durationMs: event.duration_ms ?? (turn ? Date.now() - turn.startedAt : 0),
      ...(usage ? { usage } : {}),
      ...(typeof event.total_cost_usd === "number" ? { costUsd: event.total_cost_usd } : {}),
    });
    this.emit("tab_status", this.statusPayload());
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.disposed) return;
    this.session = null;
    const failedResume = this.resumedThisSpawn && !this.sawInitThisSpawn && code !== 0;
    this.resumedThisSpawn = false;

    /* Belt and braces for the resume check above: if a --resume child died
       before `system/init`, the session id was rejected (deleted transcript,
       a `claude` that cleaned up, a resume the CLI would not take). Nothing
       was streamed, so re-declaring the id and re-sending the same blocks is
       safe and invisible. Once per turn only. */
    const retryTurn = this.currentTurn;
    if (failedResume && this.busy && retryTurn && !retryTurn.retriedWithoutResume) {
      this.resumeUnavailable = true;
      retryTurn.retriedWithoutResume = true;
      this.deps.log(
        `tab ${this.id}: --resume ${this.sessionId} failed (exit ${code}); respawning with --session-id`,
      );
      try {
        const session = this.ensureSession();
        this.emit("tab_status", this.statusPayload("starting"));
        session.sendUserContent(retryTurn.blocks);
        return;
      } catch (err) {
        this.deps.log(`tab ${this.id}: resume fallback failed: ${String(err)}`);
        this.session = null;
      }
    }
    for (const requestId of Array.from(this.pending.keys())) {
      this.resolveApproval(requestId, false, "Subprocess exited", undefined, "restart");
    }
    this.markRunningToolsErrored();
    const turn = this.currentTurn;
    if (this.busy && turn) {
      /* The child died mid-turn. Release busy and tell the client the turn is
         over, otherwise the composer stays locked until the app restarts. */
      this.busy = false;
      this.state.busy = false;
      this.currentTurn = null;
      this.emit("turn_done", {
        turnId: turn.turnId,
        subtype: "error_during_execution",
        durationMs: Date.now() - turn.startedAt,
      });
    }
    this.status = code === 0 || signal === "SIGTERM" ? "idle" : "exited";
    this.emit("tab_status", { ...this.statusPayload(), exitCode: code });
    this.save();
  }

  private handleFatal(message: string): void {
    this.status = "error";
    this.busy = false;
    this.state.busy = false;
    this.currentTurn = null;
    this.deps.log(`tab ${this.id}: ${message}`);
    this.emit("tab_status", { ...this.statusPayload(), error: message });
  }

  private markRunningToolsErrored(): void {
    for (const m of this.state.messages) {
      if (!m.toolCalls) continue;
      for (const t of m.toolCalls) {
        if (t.status === "running" || t.status === "pending") {
          t.status = "errored";
          t.isError = true;
        }
      }
    }
  }

  private ensureAssistantMessage(): ChatMessage {
    if (this.currentAssistant) return this.currentAssistant;
    const msg: ChatMessage = {
      id: makeMessageId(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
      streaming: true,
    };
    this.state.messages.push(msg);
    this.currentAssistant = msg;
    return msg;
  }
}

export class BusyError extends Error {
  constructor() {
    super("busy");
    this.name = "BusyError";
  }
}
