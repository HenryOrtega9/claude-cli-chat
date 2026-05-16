import { createInterface, Interface } from "node:readline";
import type { Readable } from "node:stream";
import type { StreamEvent } from "./Events";

/* Line-delimited JSON parser over a Readable stream (typically a child process's stdout).
   Each non-empty line is parsed as a single StreamEvent and dispatched to the listener.
   Malformed lines surface as `error` events so the caller can decide whether to abort. */
export class StreamJsonParser {
  private rl: Interface | null = null;
  private listeners: Array<(e: StreamEvent) => void> = [];
  private rawListeners: Array<(line: string) => void> = [];

  attach(stream: Readable) {
    this.rl = createInterface({ input: stream, crlfDelay: Infinity });
    this.rl.on("line", line => this.handleLine(line));
  }

  detach() {
    this.rl?.close();
    this.rl = null;
  }

  onEvent(cb: (e: StreamEvent) => void) {
    this.listeners.push(cb);
  }

  onRawLine(cb: (line: string) => void) {
    this.rawListeners.push(cb);
  }

  private handleLine(line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;

    for (const cb of this.rawListeners) cb(trimmed);

    let event: StreamEvent;
    try {
      event = JSON.parse(trimmed) as StreamEvent;
    } catch (err) {
      event = {
        type: "error",
        subtype: "parse_error",
        message: `Failed to parse stream-json line: ${err instanceof Error ? err.message : String(err)}`,
        error: trimmed.slice(0, 200),
      };
    }

    for (const cb of this.listeners) cb(event);
  }
}
