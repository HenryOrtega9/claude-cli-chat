/* The daemon-side owner of the Apple Health store and note writer.

   The store opens lazily, on the first /apple-health/ request, rather than at
   boot: a problem with node:sqlite or the Application Support directory must
   cost the health routes a 500, never the whole gateway its startup. */

import { HealthNoteWriter } from "./note";
import { HealthStore, validatePayload, type HealthStatus, type IngestPayload, type IngestResult } from "./store";

export type AppleHealthOptions = {
  dbPath: string;
  vault: string;
  log: (msg: string) => void;
  noteIntervalMs?: number;
};

export class AppleHealthService {
  private store: HealthStore | null = null;
  readonly notes: HealthNoteWriter;

  constructor(private readonly opts: AppleHealthOptions) {
    this.notes = new HealthNoteWriter({
      vault: opts.vault,
      dbPath: opts.dbPath,
      db: () => this.open().db,
      log: opts.log,
      intervalMs: opts.noteIntervalMs,
    });
  }

  private open(): HealthStore {
    if (!this.store) {
      this.store = new HealthStore(this.opts.dbPath);
      this.opts.log(`apple-health store opened: ${this.opts.dbPath}`);
    }
    return this.store;
  }

  /* Throws PayloadError (-> 400) before touching the database. The note is
     scheduled only after the transaction committed, and scheduling cannot
     throw, so the caller's response depends on the store alone. */
  ingest(raw: unknown): { payload: IngestPayload; result: IngestResult } {
    const payload = validatePayload(raw);
    const result = this.open().ingest(payload);
    this.notes.schedule();
    return { payload, result };
  }

  status(): HealthStatus {
    return this.open().status();
  }

  close(): void {
    this.notes.dispose();
    this.store?.close();
    this.store = null;
  }
}
