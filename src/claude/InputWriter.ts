import type { Writable } from "node:stream";
import type {
  ContentBlock,
  OutboundControlResponse,
  OutboundJson,
  OutboundUserMessage,
} from "./Events";

/* NDJSON writer for the Claude Code subprocess's stdin. Each call serializes one JSON
   object on its own line, matching the `--input-format stream-json` wire format.

   Writes are queued onto a per-instance promise chain so that concurrent
   `send()` calls cannot interleave bytes on the underlying pipe. This
   matters for image attachments and other payloads that exceed PIPE_BUF
   (4KB on macOS/Linux), where the kernel no longer guarantees atomic
   delivery of a single write(). Backpressure is also respected: if the
   stream's internal buffer is full, we await `drain` before continuing. */
export class InputWriter {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private stdin: Writable) {}

  send(message: OutboundJson) {
    if (!this.stdin.writable) {
      throw new Error("Claude subprocess stdin is no longer writable");
    }
    const payload = `${JSON.stringify(message)}\n`;
    /* Chain the write so concurrent callers are serialized. We swallow the
       chain's own rejection so one failed write doesn't poison the chain;
       individual write errors still propagate via the per-write Promise. */
    this.writeChain = this.writeChain.then(() => this.actuallyWrite(payload)).catch(() => {});
  }

  private actuallyWrite(payload: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.stdin.writable) {
        reject(new Error("Claude subprocess stdin is no longer writable"));
        return;
      }
      const ok = this.stdin.write(payload, (err) => {
        if (err) {
          reject(err);
          return;
        }
        if (ok) resolve();
        /* If write() returned false, the drain handler below resolves. */
      });
      if (!ok) {
        /* Stream backpressure: wait for the buffer to flush before resolving
           so the next chained write doesn't pile on top. The stream can also
           error or close before `drain` ever fires (child died mid-write),
           and a destroyed stream doesn't always invoke the write callback,
           so listen for those too — otherwise this promise never settles and
           the whole writeChain (and every later closeStdin()) hangs. Settle
           exactly once and remove all three listeners so nothing leaks per
           write. */
        let settled = false;
        const cleanup = () => {
          this.stdin.off("drain", onDrain);
          this.stdin.off("error", onError);
          this.stdin.off("close", onClose);
        };
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn();
        };
        const onDrain = () => settle(() => resolve());
        const onError = (err: Error) => settle(() => reject(err));
        const onClose = () => settle(() => reject(new Error("Claude subprocess stdin closed before drain")));
        this.stdin.on("drain", onDrain);
        this.stdin.on("error", onError);
        this.stdin.on("close", onClose);
      }
    });
  }

  sendUserText(text: string, sessionId?: string) {
    const message: OutboundUserMessage = {
      type: "user",
      session_id: sessionId,
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    };
    this.send(message);
  }

  sendUserContent(blocks: ContentBlock[], sessionId?: string) {
    const message: OutboundUserMessage = {
      type: "user",
      session_id: sessionId,
      message: { role: "user", content: blocks },
      parent_tool_use_id: null,
    };
    this.send(message);
  }

  /* Approval: pass `updatedInput` (the tool input the request was made with,
     possibly modified by the UI). Required by the Agent SDK schema. */
  sendApproval(requestId: string, updatedInput: Record<string, unknown>) {
    const response: OutboundControlResponse = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { behavior: "allow", updatedInput },
      },
    };
    this.send(response);
  }

  sendDenial(requestId: string, message?: string) {
    const response: OutboundControlResponse = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response: { behavior: "deny", message },
      },
    };
    this.send(response);
  }

  closeStdin(): Promise<void> {
    /* Wait for any queued writes to flush before signaling EOF; otherwise
       the child can miss the final NDJSON line. Returns a promise that
       settles once the EOF itself has been handed to the stream (end()'s
       callback), so a caller about to SIGTERM the child can wait for the
       pipe to actually drain first. Never rejects — a dead pipe settles too. */
    const done = this.writeChain
      .then(() => new Promise<void>(resolve => {
        if (this.stdin.writable) this.stdin.end(() => resolve());
        else resolve();
      }))
      .catch(() => {
        try { if (this.stdin.writable) this.stdin.end(); } catch { /* ignore */ }
      });
    this.writeChain = done;
    return done;
  }
}
