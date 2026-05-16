import { watch, statSync, createReadStream, type FSWatcher } from "node:fs";
import { createInterface } from "node:readline";
import type { StreamEvent } from "./Events";

type EventListener = (e: StreamEvent) => void;

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
  private listeners: EventListener[] = [];
  private path: string;
  private seenUuids = new Set<string>();

  constructor(path: string) {
    this.path = path;
  }

  onEvent(cb: EventListener) {
    this.listeners.push(cb);
  }

  async start(): Promise<void> {
    await this.readInitial();
    this.watcher = watch(this.path, () => this.readAppended());
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private async readInitial(): Promise<void> {
    let size = 0;
    try { size = statSync(this.path).size; } catch { return; }
    if (size === 0) return;
    await this.readRange(0, size);
    this.bytesRead = size;
  }

  private async readAppended(): Promise<void> {
    let size = 0;
    try { size = statSync(this.path).size; } catch { return; }
    if (size <= this.bytesRead) return;
    await this.readRange(this.bytesRead, size);
    this.bytesRead = size;
  }

  private readRange(start: number, end: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const stream = createReadStream(this.path, { start, end: end - 1, encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      rl.on("line", line => this.handleLine(line));
      rl.on("close", () => resolve());
      stream.on("error", reject);
    });
  }

  private handleLine(rawLine: string) {
    const line = rawLine.trim();
    if (!line) return;
    let record: Record<string, unknown>;
    try { record = JSON.parse(line); } catch { return; }

    /* Deduplicate by uuid in case the watcher fires multiple times for the
       same append region. */
    const uuid = typeof record.uuid === "string" ? record.uuid : undefined;
    if (uuid) {
      if (this.seenUuids.has(uuid)) return;
      this.seenUuids.add(uuid);
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
      /* Skip tool_result messages embedded in user records — they are paired
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
