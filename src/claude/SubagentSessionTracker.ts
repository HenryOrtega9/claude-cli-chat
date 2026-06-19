/* Tracks one subagent (Task tool) invocation by watching the parent
   session's on-disk subagents/ dir for the nested JSONL the CLI writes when
   it spawns the agent, then tailing that JSONL with JsonlTailer and
   surfacing each record as a NestedSubagentEvent on the parent ToolCall.

   On-disk layout discovered empirically:

       ~/.claude/projects/<slug>/<parent-session-uuid>/subagents/agent-<short-id>.jsonl

   `<slug>` is projectDirFor(cwd)'s last segment; `<parent-session-uuid>` is
   the parent session's UUID (state.sessionId on the active tab). New files
   appear in this dir when the CLI dispatches a Task call; the first record
   inside each is a synthetic `user` event whose text content is the
   parent's tool_use input.prompt. We match against that prompt prefix to
   disambiguate concurrent Task calls.

   Match precedence:
     1. If the file existed before our Task tool fired, skip it.
     2. If the first user-content prefix matches our parent prompt, claim
        it.
     3. Otherwise leave the file alone — another tracker (a sibling Task
        tool) should pick it up.

   When matched, the tracker opens a JsonlTailer and forwards events. When
   the parent's tool_result for our Task arrives, the caller invokes stop()
   which tears down the watcher and tailer and releases the session-file
   claim. */

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JsonlTailer } from "./JsonlTailer";
import { projectDirFor } from "./RemoteControlSession";
import type { SubprocessManager } from "./SubprocessManager";
import type { StreamEvent, AssistantEvent, ToolUseEvent, ToolResultEvent } from "./Events";
import type { NestedSubagentEvent, ToolCall } from "../view/state";

const POLL_INTERVAL_MS = 250;
const POLL_MAX_ATTEMPTS = 240;  /* 60s total — well past the spawn race window */
const PROMPT_MATCH_PREFIX_LEN = 64;
/* Cap on how much of a candidate JSONL we read to inspect its first record.
   A parent prompt larger than this is read only partially, so we fall back
   to the short-prefix bidirectional match for those (and never cache the
   size on such an inconclusive read). */
const MAX_FIRST_RECORD_READ = 65536;

export type SubagentTrackerUpdate = {
  /* Appended nested events. */
  events: NestedSubagentEvent[];
  /* Updates to existing nested tool_use entries, keyed by tool_use id. */
  toolUseUpdates?: Array<{
    id: string;
    status: ToolCall["status"];
    result?: string;
    isError?: boolean;
  }>;
  /* Set once on first match — the subagent's own session ID (from filename). */
  sessionId?: string;
  /* Set when the tracker gives up looking for a matching JSONL. UI can
     surface this as a non-fatal "no nested events available" hint. */
  matchFailed?: boolean;
};

export type SubagentSessionTrackerOpts = {
  cwd: string;
  parentSessionId: string;
  parentToolUseId: string;
  /* The parent's Task-tool input.prompt — used as the disambiguator
     between concurrent subagent JSONLs that land in the same dir. */
  parentPrompt: string;
  onUpdate: (update: SubagentTrackerUpdate) => void;
  subprocessManager: SubprocessManager;
};

export class SubagentSessionTracker {
  private opts: SubagentSessionTrackerOpts;
  private pollHandle: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  /* Files present in the subagents dir when we started polling. Any file
     in this set is from an earlier invocation and we ignore it. */
  private preExistingFiles = new Set<string>();
  private inspectedSizes = new Map<string, number>();
  private matchedPath: string | null = null;
  private tailer: JsonlTailer | null = null;
  /* Tracks nested tool_use ids we've already pushed as events so the loop
     in handleAssistant can be tolerant of duplicate emits from JsonlTailer
     (which emits both an assistant event AND a separate tool_use event for
     each tool_use block in the same assistant record). */
  private seenNestedToolIds = new Set<string>();
  private stopped = false;

  constructor(opts: SubagentSessionTrackerOpts) {
    this.opts = opts;
  }

  /* Begin watching for a matching subagent JSONL. Returns immediately;
     polling happens on a setTimeout cadence so we don't block the parent
     event loop. */
  start(): void {
    const dir = this.subagentsDir();
    try {
      if (existsSync(dir)) {
        for (const name of readdirSync(dir)) {
          if (name.endsWith(".jsonl")) this.preExistingFiles.add(name);
        }
      }
    } catch { /* ignore — directory may not exist yet */ }
    this.scheduleNextPoll();
  }

  /* Tear down. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollHandle) {
      clearTimeout(this.pollHandle);
      this.pollHandle = null;
    }
    if (this.tailer) {
      try { await this.tailer.stop(); } catch { /* ignore */ }
      this.tailer = null;
    }
    if (this.matchedPath) {
      this.opts.subprocessManager.releaseSessionFile(this.matchedPath);
    }
  }

  private subagentsDir(): string {
    return join(projectDirFor(this.opts.cwd), this.opts.parentSessionId, "subagents");
  }

  private scheduleNextPoll(): void {
    if (this.stopped || this.matchedPath) return;
    this.pollHandle = setTimeout(() => this.poll(), POLL_INTERVAL_MS);
  }

  private poll(): void {
    if (this.stopped || this.matchedPath) return;
    this.attempts++;
    if (this.attempts > POLL_MAX_ATTEMPTS) {
      this.opts.onUpdate({ events: [], matchFailed: true });
      return;
    }
    const dir = this.subagentsDir();
    if (!existsSync(dir)) {
      this.scheduleNextPoll();
      return;
    }
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { /* ignore */ }
    for (const name of entries) {
      if (!name.endsWith(".jsonl")) continue;
      if (this.preExistingFiles.has(name)) continue;
      const fullPath = join(dir, name);
      if (this.opts.subprocessManager.isSessionFileClaimed(fullPath)) continue;
      let size = 0;
      try { size = statSync(fullPath).size; } catch { continue; }
      const lastSize = this.inspectedSizes.get(fullPath) ?? -1;
      if (size === lastSize) continue;
      if (size === 0) {
        /* Don't cache size 0 — an empty file tells us nothing definitive
           and we must re-inspect once it grows. */
        continue;
      }
      const verdict = this.firstRecordMatchesPrompt(fullPath, size);
      if (verdict === "match") {
        this.inspectedSizes.set(fullPath, size);
        if (!this.opts.subprocessManager.claimSessionFile(fullPath)) continue;
        this.matchedPath = fullPath;
        this.attachTailer(fullPath);
        return;
      }
      if (verdict === "no-match") {
        /* Definitive: a fully-parsed user record whose prompt differs.
           Cache so we skip this settled non-match on future polls. */
        this.inspectedSizes.set(fullPath, size);
      }
      /* verdict === "inconclusive": the first record was incomplete or
         un-parseable (e.g. a prompt larger than our read cap cut mid-line,
         or a torn concurrent write). Do NOT cache the size, so we re-inspect
         on the next poll even if the file doesn't grow. */
    }
    this.scheduleNextPoll();
  }

  /* Reads the head of a candidate JSONL and checks whether the first user
     record's text content shares a prefix with our parent Task tool's
     prompt. The CLI writes the parent's input.prompt verbatim as the first
     user message of the subagent's session.

     Returns:
       "match"        — first user record's text is (a prefix of) our prompt.
       "no-match"     — a fully-parsed first user record whose prompt differs.
       "inconclusive" — couldn't read/parse a complete first user record
                        (read cap cut mid-record, torn concurrent write, or
                        no user record present yet). Caller must NOT cache the
                        size on this verdict, so the file is re-inspected. */
  private firstRecordMatchesPrompt(path: string, size: number): "match" | "no-match" | "inconclusive" {
    if (!this.opts.parentPrompt) {
      /* No prompt to match against — fall back to "newest unclaimed file"
         semantics, which means any new file matches. Last resort for Task
         calls whose input.prompt was empty (rare but possible). */
      return "match";
    }
    const readSize = Math.min(size, MAX_FIRST_RECORD_READ);
    let buf: string;
    try {
      buf = readFileSync(path, { encoding: "utf8", flag: "r" }).slice(0, readSize);
    } catch {
      return "inconclusive";
    }
    const lines = buf.split("\n");
    /* The matched record is taken from safeLines; when lines.length > 1 that
       slice is guaranteed newline-terminated, so the matched record is complete
       regardless of whether the buffer's final (partial) line ended on a
       newline. When lines.length === 1 the single line may be the unterminated
       tail, so it is not safe to treat as complete. */
    const matchedRecordComplete = lines.length > 1;
    const safeLines = lines.length > 1 ? lines.slice(0, -1) : lines;
    for (const line of safeLines) {
      const t = line.trim();
      if (!t) continue;
      let record: Record<string, unknown>;
      try { record = JSON.parse(t); } catch { return "inconclusive"; }
      if (record.type !== "user") continue;
      const msg = record.message as { content?: unknown } | undefined;
      const text = extractFirstText(msg?.content);
      if (text === null) continue;
      return this.comparePrompt(text, matchedRecordComplete && size <= readSize);
    }
    /* No complete user record found. If the buffer was fully read and ended
       cleanly, there genuinely is no user record yet (or only non-user
       records) — but the CLI always writes the user echo first, so this is a
       transient pre-write state, not a settled non-match: stay inconclusive
       so we re-inspect. */
    return "inconclusive";
  }

  /* Compares a candidate first-record text against the parent prompt. When
     we have the full record (not truncated by our read cap) we require the
     record to START WITH the parent prompt prefix in one direction — the CLI
     writes the parent prompt verbatim, so a real subagent's first user echo
     is always a superset of (or equal to) the parent prompt. A long prefix
     disambiguates concurrent Task calls whose prompts share a short header.
     When the record was truncated we fall back to the shorter bidirectional
     check, which is all we can verify. */
  private comparePrompt(text: string, fullRecordAvailable: boolean): "match" | "no-match" {
    const parent = this.opts.parentPrompt.trim();
    const record = text.trim();
    if (!parent || !record) return "no-match";
    if (fullRecordAvailable) {
      /* Compare up to the parent prompt's full length (bounded by our read
         cap). The record should begin with the entire parent prompt. */
      const bound = Math.min(parent.length, MAX_FIRST_RECORD_READ);
      const parentPrefix = parent.slice(0, bound);
      return record.startsWith(parentPrefix) ? "match" : "no-match";
    }
    /* Truncated record: only the short prefix is trustworthy. Keep the
       bidirectional check as a last resort. */
    const parentPrefix = parent.slice(0, PROMPT_MATCH_PREFIX_LEN);
    const recordPrefix = record.slice(0, PROMPT_MATCH_PREFIX_LEN);
    if (!parentPrefix || !recordPrefix) return "no-match";
    return recordPrefix.startsWith(parentPrefix) || parentPrefix.startsWith(recordPrefix)
      ? "match"
      : "no-match";
  }

  private attachTailer(path: string): void {
    const sessionId = path.split("/").pop()?.replace(/\.jsonl$/, "");
    /* Push a sessionId-only update first so the UI can show "matched" state
       even before any events arrive. */
    this.opts.onUpdate({ events: [], sessionId });
    const tailer = new JsonlTailer(path);
    this.tailer = tailer;
    tailer.onEvent((e) => this.handleStreamEvent(e));
    tailer.onError(() => { /* swallow — non-fatal */ });
    void tailer.start();
  }

  private handleStreamEvent(e: StreamEvent): void {
    if (this.stopped) return;
    const events: NestedSubagentEvent[] = [];
    const toolUseUpdates: SubagentTrackerUpdate["toolUseUpdates"] = [];

    if (e.type === "assistant") {
      const ae = e as AssistantEvent;
      for (const block of ae.message.content) {
        if (block.type === "text" && block.text) {
          events.push({ kind: "text", text: block.text });
        } else if (block.type === "thinking" && block.thinking) {
          events.push({ kind: "thinking", text: block.thinking });
        }
        /* tool_use blocks arrive as separate ToolUseEvent emissions from
           JsonlTailer's translator. Handled below; skip here. */
      }
    } else if (e.type === "tool_use") {
      const tu = e as ToolUseEvent;
      if (!this.seenNestedToolIds.has(tu.id)) {
        this.seenNestedToolIds.add(tu.id);
        events.push({
          kind: "tool_use",
          id: tu.id,
          name: tu.name,
          input: tu.input,
          status: "running",
        });
      }
    } else if (e.type === "tool_result") {
      const tr = e as ToolResultEvent;
      const flat = typeof tr.content === "string"
        ? tr.content
        : Array.isArray(tr.content)
          ? tr.content.map(b => (b.type === "text" ? b.text : `[${b.type} block]`)).join("")
          : "";
      toolUseUpdates.push({
        id: tr.tool_use_id,
        status: tr.is_error ? "errored" : "completed",
        result: flat,
        isError: !!tr.is_error,
      });
    }
    /* type === "user" is skipped (echo of parent prompt). System events,
       result events, etc. are also skipped since they describe the parent
       session, not the subagent. */

    if (events.length === 0 && toolUseUpdates.length === 0) return;
    this.opts.onUpdate({
      events,
      toolUseUpdates: toolUseUpdates.length > 0 ? toolUseUpdates : undefined,
    });
  }
}

/* Extracts the first text payload from a message.content shape, which may
   be either a plain string or an array of blocks. Returns null if no text
   was found. */
function extractFirstText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") return b.text;
    }
  }
  return null;
}
