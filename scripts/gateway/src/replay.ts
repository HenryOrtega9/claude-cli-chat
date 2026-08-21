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

import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { Frame } from "./frames";

const RING_MAX = 4000;
const FILE_MAX_BYTES = 64 * 1024 * 1024;

export class ReplayRing {
  private ring: Frame[] = [];
  /* Lowest seq still answerable from EITHER tier. Rises only when the ndjson
     is rotated. */
  private floor = 1;
  private writeChain: Promise<void> = Promise.resolve();
  private bytes = 0;
  private dirReady = false;

  constructor(private readonly filePath: string) {}

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
          await rm(this.filePath, { force: true });
          this.bytes = Buffer.byteLength(line);
          this.floor = this.ring[0]?.seq ?? frame.seq;
        }
        await appendFile(this.filePath, line, "utf8");
      })
      .catch(err => {
        console.error(`[vault-gateway] replay spill failed for ${this.filePath}:`, err);
      });
  }

  /* Frames with seq > since, in order. `evicted: true` means the caller asked
     for frames the ring can no longer produce and must resync. */
  async since(since: number, limit = 5000): Promise<{ frames: Frame[]; evicted: boolean }> {
    const oldestInRing = this.ring[0]?.seq;
    if (oldestInRing !== undefined && since >= oldestInRing - 1) {
      return { frames: this.ring.filter(f => f.seq > since).slice(0, limit), evicted: false };
    }
    if (since + 1 < this.floor) return { frames: [], evicted: true };
    /* Gap is older than the ring but still on disk. */
    await this.writeChain;
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch {
      return { frames: [], evicted: this.ring.length > 0 };
    }
    const frames: Frame[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const frame = JSON.parse(line) as Frame;
        if (frame.seq > since) frames.push(frame);
      } catch {
        /* A torn final line from a crash mid-append; skip it. */
      }
      if (frames.length >= limit) break;
    }
    return { frames, evicted: false };
  }

  /* Await any queued appends. Called on shutdown so the last frames of a
     turn are on disk before the process exits. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  async destroy(): Promise<void> {
    await this.writeChain;
    this.ring = [];
    await rm(this.filePath, { force: true }).catch(() => undefined);
  }
}
