/* Per-tab event replay ring.

   Two tiers, because a phone that has been backgrounded for an hour and a
   phone whose socket blipped for two seconds want very different things:

   - An in-memory ring of the last RING_MAX frames answers the common
     reconnect instantly.
   - Every frame is also appended to
     `<vault>/.claude-cli-chat/ios/events/<tabId>.ndjson`, so a longer gap can
     still be filled exactly (no gaps, no duplicates) by reading back from
     disk. The file is the reason `resync` is rare rather than routine.

   The file is truncated once it passes FILE_MAX_BYTES; everything below the
   surviving floor is gone for good, and a client asking for it gets a
   `resync` frame telling it to re-fetch the tab and resubscribe. Appends are
   serialized through a promise chain so two frames can never interleave
   inside one line. */

import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import type { Frame } from "./frames";

const RING_MAX = 4000;
const FILE_MAX_BYTES = 64 * 1024 * 1024;

export class ReplayRing {
  private ring: Frame[] = [];
  /* Lowest seq still answerable from EITHER tier. Rises only when the ndjson
     is rotated, or when recoverTail() finds the surviving file already
     started above seq 1 (a previous process's rotation). */
  private floor = 1;
  private writeChain: Promise<void> = Promise.resolve();
  private bytes = 0;
  private dirReady = false;
  /* Kept open for the life of the ring instead of open+write+close per push
     (see recoverTail()'s header note and push() below): with
     --include-partial-messages on by default, every token delta is one
     frame, so re-opening the file per line was thousands of syscalls per
     turn. Null whenever nothing has been written yet, or right after a
     rotation/reset/destroy. */
  private handle: FileHandle | null = null;

  constructor(private readonly filePath: string) {}

  /* Restores what a fresh `new ReplayRing()` can't know about a file that
     already existed before this process started: the byte count (so the 64
     MB rotation cap keeps meaning something instead of re-measuring from 0
     every restart) and the floor (so `since()` reports `evicted` correctly
     for a file that survived a PRIOR rotation). Returns the highest seq
     already on disk, 0 when there is no file yet — the caller (TabEngine)
     uses that to resume its own counter instead of restarting it at 0 and
     colliding with frames already sitting under those same seq numbers.
     Only ever meaningful before the first push() of this process's
     lifetime; call it once, right after construction, for a restored or
     reopened tab. */
  async recoverTail(): Promise<number> {
    let size: number;
    try {
      size = (await stat(this.filePath)).size;
    } catch {
      return 0;
    }
    this.bytes = size;
    let firstSeq: number | undefined;
    let lastSeq = 0;
    try {
      const rl = createInterface({ input: createReadStream(this.filePath, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        try {
          const frame = JSON.parse(line) as Frame;
          if (firstSeq === undefined) firstSeq = frame.seq;
          lastSeq = frame.seq;
        } catch {
          /* A torn line from a crash mid-append; skip it. */
        }
      }
    } catch {
      return 0;
    }
    if (firstSeq !== undefined) this.floor = firstSeq;
    return lastSeq;
  }

  push(frame: Frame): void {
    this.ring.push(frame);
    if (this.ring.length > RING_MAX) this.ring.splice(0, this.ring.length - RING_MAX);
    const line = `${JSON.stringify(frame)}\n`;
    this.bytes += Buffer.byteLength(line);
    const shouldRotate = this.bytes > FILE_MAX_BYTES;
    this.writeChain = this.writeChain
      .then(async () => {
        if (!this.dirReady) {
          await mkdir(dirname(this.filePath), { recursive: true });
          this.dirReady = true;
        }
        if (shouldRotate) {
          /* Drop the file entirely rather than rewriting a tail: the
             in-memory ring still covers the recent past, and anything older
             is what `resync` exists for. */
          await this.closeHandle();
          await rm(this.filePath, { force: true });
          this.bytes = Buffer.byteLength(line);
          this.floor = this.ring[0]?.seq ?? frame.seq;
        }
        if (!this.handle) this.handle = await open(this.filePath, "a");
        await this.handle.appendFile(line, "utf8");
      })
      .catch(err => {
        console.error(`[vault-gateway] replay spill failed for ${this.filePath}:`, err);
      });
  }

  /* Frames with seq > since, in order. `evicted: true` means the caller asked
     for frames the ring can no longer produce and must resync. `truncated:
     true` means frames beyond `limit` existed and were left out — the ring
     branch can't hit this in practice (RING_MAX sits under the default
     limit) but the disk branch reads a file with no such bound. Callers must
     treat `truncated` the same as `evicted`: a partial replay silently
     rendered as complete is a worse bug than an extra resync. */
  async since(since: number, limit = 5000): Promise<{ frames: Frame[]; evicted: boolean; truncated: boolean }> {
    const oldestInRing = this.ring[0]?.seq;
    if (oldestInRing !== undefined && since >= oldestInRing - 1) {
      const matched = this.ring.filter(f => f.seq > since);
      return { frames: matched.slice(0, limit), evicted: false, truncated: matched.length > limit };
    }
    if (since + 1 < this.floor) return { frames: [], evicted: true, truncated: false };
    /* Gap is older than the ring but still on disk. Streamed line-by-line and
       stopped as soon as `limit` matches are found, rather than reading the
       whole (up to 64 MB) file into memory and JSON.parse-ing every line
       first: a phone backgrounded through a long turn hits this on every
       reconnect, and it runs on the daemon's single thread. */
    await this.writeChain;
    const frames: Frame[] = [];
    let truncated = false;
    try {
      const rl = createInterface({ input: createReadStream(this.filePath, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line) continue;
        try {
          const frame = JSON.parse(line) as Frame;
          if (frame.seq > since) frames.push(frame);
        } catch {
          /* A torn final line from a crash mid-append; skip it. */
        }
        if (frames.length >= limit) { truncated = true; break; }
      }
    } catch {
      return { frames: [], evicted: this.ring.length > 0, truncated: false };
    }
    return { frames, evicted: false, truncated };
  }

  /* Await any queued appends. Called on shutdown so the last frames of a
     turn are on disk before the process exits. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  private async closeHandle(): Promise<void> {
    const h = this.handle;
    this.handle = null;
    if (h) await h.close().catch(() => undefined);
  }

  /* Throw the whole history away but keep serving the tab (POST /tabs/:id/clear).
     `nextSeq` is the seq the FIRST frame after the reset will carry, which
     becomes the new floor: a client whose cursor sits below it gets
     `evicted: true` and resyncs, which is exactly right — the frames it missed
     describe a conversation that no longer exists. A client that was fully
     caught up has `since + 1 === nextSeq`, clears the floor check, finds no
     file, and correctly receives nothing. */
  async reset(nextSeq: number): Promise<void> {
    await this.writeChain;
    await this.closeHandle();
    this.ring = [];
    this.bytes = 0;
    this.floor = nextSeq;
    await rm(this.filePath, { force: true }).catch(() => undefined);
  }

  async destroy(): Promise<void> {
    await this.writeChain;
    await this.closeHandle();
    this.ring = [];
    await rm(this.filePath, { force: true }).catch(() => undefined);
  }
}
