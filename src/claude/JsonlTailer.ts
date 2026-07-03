import { watch, statSync, createReadStream, type FSWatcher } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import type { StreamEvent } from "./Events";

type EventListener = (e: StreamEvent) => void;
type ErrorListener = (err: Error) => void;

/* Tails a Claude Code session JSONL file and emits StreamEvents synthesized
   to look like our live stream-json pipeline. Used in Remote Control mode
   where the CLI runs interactively (no stdout JSON) and the JSONL is the
   only authoritative event source.

   Strategy: read the entire file once on attach (replay), then watch for
   appends and parse new bytes only. Records are line-delimited JSON. */
export class JsonlTailer {
  private watcher: FSWatcher | null = null;
  private bytesRead = 0;
  private buffer = "";
  /* Persistent UTF-8 decoder shared across readRange() calls. Each readAppended()
     reads a raw byte range whose end can land mid-multibyte-character (the CLI's
     appends aren't atomic). A per-stream decoder would flush the incomplete leading
     bytes as U+FFFD and decode the trailing continuation bytes as a second U+FFFD,
     destroying the character. Keeping one decoder holds the partial sequence and
     completes it with the next read's leading bytes. Must be reset in lockstep with
     `buffer` (see readAppended's truncation branch). */
  private decoder = new StringDecoder("utf8");
  private listeners: EventListener[] = [];
  private errorListeners: ErrorListener[] = [];
  private path: string;
  /* FIFO-bounded uuid dedupe set. We track insertion order via a parallel
     array so we can drop the oldest entries once the set grows past
     SEEN_UUIDS_MAX. A Map keyed by uuid would be cleaner but uses more memory
     per entry; a Set + array is the smallest stable implementation. */
  private seenUuids = new Set<string>();
  private seenUuidsOrder: string[] = [];
  private static readonly SEEN_UUIDS_MAX = 10000;
  private static readonly SEEN_UUIDS_DROP = 1000;
  /* Tracks in-flight readAppended() invocations so stop() can await drain. */
  private readChain: Promise<void> = Promise.resolve();
  private stopped = false;
  /* Single pending re-attach timer. Tracked so stop() can cancel it and so a
     rename+close burst can't schedule two concurrent re-attaches. */
  private reattachTimer: ReturnType<typeof setTimeout> | null = null;
  /* Bounded budget for retrying a watch() that THREW (vs. the normal
     rename/close re-attach, which is event-driven and self-limiting). Reset
     whenever an attach succeeds. 40 × 250ms = 10s of tolerance for transient
     rename/EMFILE windows before giving up for good. */
  private reattachAttempts = 0;
  private static readonly REATTACH_MAX_ATTEMPTS = 40;

  constructor(path: string) {
    this.path = path;
  }

  onEvent(cb: EventListener) {
    this.listeners.push(cb);
  }

  onError(cb: ErrorListener) {
    this.errorListeners.push(cb);
  }

  async start(): Promise<void> {
    /* Wait for the file to exist. The CLI may not have created it by the
       time start() is called (Remote Control spawn race). Back off 50ms x
       up to 60 attempts = 3s total, then surface a controlled error rather
       than throwing into a void-promise rejection. */
    const MAX_ATTEMPTS = 60;
    const BACKOFF_MS = 50;
    let exists = false;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      if (this.stopped) return;
      try {
        statSync(this.path);
        exists = true;
        break;
      } catch {
        await new Promise(r => setTimeout(r, BACKOFF_MS));
      }
    }
    if (!exists) {
      const err = new Error(`JsonlTailer: file not found after ${MAX_ATTEMPTS * BACKOFF_MS}ms: ${this.path}`);
      for (const cb of this.errorListeners) {
        try { cb(err); } catch { /* listener error swallowed */ }
      }
      return;
    }

    if (this.stopped) return;
    /* Route the initial replay through readChain so stop()'s drain covers it —
       started bare, a long replay would keep emitting into a torn-down tab
       after stop() resolved. Rejections still surface to start()'s caller;
       the chain keeps its own swallowed copy. */
    const initial = this.readChain.then(() => this.readInitial());
    this.readChain = initial.then(() => undefined, () => undefined);
    await initial;
    if (this.stopped) return;
    this.attachWatcher();
    /* Close the gap between readInitial()'s stat and watch() registration:
       data appended in that window would be missed unless we re-poll once
       eagerly here. */
    this.scheduleRead();
  }

  /* (Re)attach a watcher to `this.path`. Also handles rename/close events by
     re-attaching, which covers the atomic-rename pattern (write to tmp, rename
     over) and macOS's tendency to unbind the watch from an inode after such
     replacements. */
  private attachWatcher(): void {
    if (this.stopped) return;
    try { this.watcher?.close(); } catch { /* ignore */ }
    try {
      const w = watch(this.path, (eventType) => {
        if (eventType === "rename") {
          /* File was renamed (or the inode the watcher was bound to was
             replaced). Re-stat from scratch and re-watch. */
          this.scheduleRead();
          /* Defer the re-attach a tick so the replacement file is in place. */
          this.scheduleReattach();
          return;
        }
        this.scheduleRead();
      });
      this.watcher = w;
      this.reattachAttempts = 0;
      w.on("close", () => {
        if (this.stopped) return;
        /* Closing the previous watcher to install a new one (top of this
           method) ALSO emits 'close' on the old instance. If we re-attached on
           every close we'd close→close→close in a perpetual 50ms loop. Guard on
           identity: only re-attach when the watcher that closed is still the
           current one (i.e. an unexpected close — kernel limit, unlink — not our
           own intentional replacement, after which this.watcher already points
           at the new instance). */
        if (this.watcher !== w) return;
        this.scheduleReattach();
      });
      w.on("error", (err) => {
        for (const cb of this.errorListeners) {
          try { cb(err); } catch { /* ignore */ }
        }
        /* An FSWatcher that emitted 'error' is dead. Replace it instead of
           leaving the tail permanently silent — both consumers swallow tailer
           errors, so without a retry the tab just stops updating. */
        if (this.watcher === w) {
          try { w.close(); } catch { /* ignore */ }
          this.scheduleReattach(250);
        }
      });
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      for (const cb of this.errorListeners) {
        try { cb(e); } catch { /* ignore */ }
      }
      /* watch() can throw transiently (file mid-rename/unlink+recreate,
         EMFILE). Retry with a bounded budget rather than giving up forever;
         a successful attach resets the counter. */
      if (++this.reattachAttempts <= JsonlTailer.REATTACH_MAX_ATTEMPTS) {
        this.scheduleReattach(250);
      }
    }
  }

  /* Schedule a single deferred re-attach. Idempotent while one is pending so a
     rename+close burst doesn't fan out into multiple concurrent watchers. */
  private scheduleReattach(delayMs = 50): void {
    if (this.stopped || this.reattachTimer !== null) return;
    this.reattachTimer = setTimeout(() => {
      this.reattachTimer = null;
      this.attachWatcher();
    }, delayMs);
  }

  /* Chain readAppended() so concurrent watcher events don't interleave reads. */
  private scheduleRead(): void {
    this.readChain = this.readChain.then(() => this.readAppended()).catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reattachTimer !== null) {
      clearTimeout(this.reattachTimer);
      this.reattachTimer = null;
    }
    try { this.watcher?.close(); } catch { /* ignore */ }
    this.watcher = null;
    /* Wait for any in-flight reads to drain so callers can rely on
       "no more events will fire after stop() resolves". */
    try { await this.readChain; } catch { /* ignore */ }
  }

  private async readInitial(): Promise<void> {
    let size = 0;
    try { size = statSync(this.path).size; } catch { return; }
    if (size === 0) return;
    await this.readRange(0, size);
    this.bytesRead = size;
  }

  private async readAppended(): Promise<void> {
    if (this.stopped) return;
    let size = 0;
    try { size = statSync(this.path).size; } catch { return; }
    /* Truncation detection: if the file shrank, the CLI may have rotated /
       overwritten the session file. Reset and re-read from start. */
    if (size < this.bytesRead) {
      this.bytesRead = 0;
      this.buffer = "";
      /* Drop any partial multibyte sequence held from the pre-rotation file so the
         rotated file decodes cleanly from byte 0. */
      this.decoder = new StringDecoder("utf8");
      /* Re-reading from byte 0 replays records we've already emitted. Their
         uuids are still in the dedupe set, so without clearing it every replayed
         record is silently dropped and the rotated session goes dark. */
      this.seenUuids.clear();
      this.seenUuidsOrder.length = 0;
      if (size === 0) return;
      await this.readRange(0, size);
      this.bytesRead = size;
      return;
    }
    if (size === this.bytesRead) return;
    await this.readRange(this.bytesRead, size);
    this.bytesRead = size;
  }

  /* Read [start, end) and emit each COMPLETE line. A trailing partial line (the
     read landed mid-record because the CLI's append wasn't atomic) is retained
     in this.buffer and stitched together with the next read rather than being
     handed to readline as a truncated line that fails JSON.parse and is lost —
     the previous readline-based implementation advanced bytesRead past such a
     split record, dropping it permanently. The stream is destroyed on error so
     a failed read can't leak the underlying fd. */
  private readRange(start: number, end: number): Promise<void> {
    return new Promise((resolve, reject) => {
      /* No encoding: chunks arrive as raw Buffers so the persistent decoder (not a
         throwaway per-stream one) owns multibyte reassembly across read boundaries. */
      const stream = createReadStream(this.path, { start, end: end - 1 });
      let settled = false;
      stream.on("data", (chunk: string | Buffer) => {
        /* With no encoding set the stream always yields Buffer at runtime; the
           Node typings keep the string union, so coerce for the decoder. */
        this.buffer += this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        let nl = this.buffer.indexOf("\n");
        while (nl !== -1) {
          const line = this.buffer.slice(0, nl);
          this.buffer = this.buffer.slice(nl + 1);
          this.handleLine(line);
          nl = this.buffer.indexOf("\n");
        }
      });
      stream.on("error", (err) => {
        if (settled) return;
        settled = true;
        stream.destroy();
        reject(err);
      });
      stream.on("close", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
    });
  }

  private handleLine(rawLine: string) {
    /* stop() promises "no more events after stop() resolves" — an in-flight
       readRange keeps streaming chunks after the watcher closes, so the
       emission gate has to live here. */
    if (this.stopped) return;
    const line = rawLine.trim();
    if (!line) return;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line); } catch { return; }

    /* Deduplicate by uuid in case the watcher fires multiple times for the
       same append region. Bounded FIFO to prevent unbounded memory growth on
       very long sessions. */
    const uuid = typeof record.uuid === "string" ? record.uuid : undefined;
    if (uuid) {
      if (this.seenUuids.has(uuid)) return;
      this.seenUuids.add(uuid);
      this.seenUuidsOrder.push(uuid);
      if (this.seenUuids.size > JsonlTailer.SEEN_UUIDS_MAX) {
        const dropped = this.seenUuidsOrder.splice(0, JsonlTailer.SEEN_UUIDS_DROP);
        for (const old of dropped) this.seenUuids.delete(old);
      }
    }

    const synthetic = this.toStreamEvent(record);
    if (!synthetic) return;
    for (const cb of this.listeners) cb(synthetic);
  }

  /* Maps a JSONL record to one of our existing StreamEvent variants so the
     TabController's onEvent handler can render it without special-casing
     remote mode. Records we don't care about (queue-operation, summary, etc.)
     return null. */
  private toStreamEvent(record: Record<string, unknown>): StreamEvent | null {
    const type = record.type;
    if (type === "user") {
      const msg = record.message as { role?: string; content?: unknown } | undefined;
      if (!msg) return null;
      /* Remote-control user turns store content as a plain string
         ({"content":"hi"}); locally-driven turns store an array of blocks. Normalize
         to the block-array shape the renderer expects. */
      const content: Array<Record<string, unknown>> = Array.isArray(msg.content)
        ? (msg.content as Array<Record<string, unknown>>)
        : typeof msg.content === "string"
          ? [{ type: "text", text: msg.content }]
          : [];
      /* Skip tool_result messages embedded in user records; they are paired
         with assistant tool_use turns and surface separately. */
      const hasToolResult = content.some((b: Record<string, unknown>) => b?.type === "tool_result");
      if (hasToolResult) {
        /* Emit a tool_result event for each block so the renderer can update
           the existing tool call bubble. */
        for (const block of content) {
          const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
          if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
            for (const cb of this.listeners) {
              cb({
                type: "tool_result",
                tool_use_id: b.tool_use_id,
                content: (b.content as string) ?? "",
                is_error: !!b.is_error,
              });
            }
          }
        }
        return null;
      }
      return {
        type: "user",
        uuid: typeof record.uuid === "string" ? record.uuid : undefined,
        session_id: typeof record.sessionId === "string" ? record.sessionId : undefined,
        message: {
          role: "user",
          content: content as Array<{ type: "text"; text: string }>,
        },
      };
    }
    if (type === "assistant") {
      const msg = record.message as { role?: string; content?: unknown; model?: string } | undefined;
      if (!msg) return null;
      const content = Array.isArray(msg.content) ? msg.content : [];

      /* Surface each tool_use block as a discrete event so the existing
         tool-call rendering path activates. */
      for (const block of content) {
        const b = block as { type?: string; id?: string; name?: string; input?: Record<string, unknown> };
        if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
          for (const cb of this.listeners) {
            cb({
              type: "tool_use",
              id: b.id,
              name: b.name,
              input: b.input ?? {},
            });
          }
        }
      }

      return {
        type: "assistant",
        uuid: typeof record.uuid === "string" ? record.uuid : undefined,
        session_id: typeof record.sessionId === "string" ? record.sessionId : undefined,
        message: {
          role: "assistant",
          model: msg.model,
          content: content as Array<{ type: "text"; text: string }>,
        },
      };
    }
    return null;
  }
}
