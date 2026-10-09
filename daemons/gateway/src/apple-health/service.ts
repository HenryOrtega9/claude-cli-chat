/* The daemon-side owner of the Apple Health store and note writer.

   The store opens lazily, on the first /apple-health/ request, rather than at
   boot: a problem with node:sqlite or the Application Support directory must
   cost the health routes a 500, never the whole gateway its startup. */

import { HealthNoteWriter, renderHealthNote } from "./note";
import { runHealthTask, WorkerUnavailableError, type HealthTask } from "./offload";
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
  private warnedNoWorker = false;

  constructor(private readonly opts: AppleHealthOptions) {
    this.notes = new HealthNoteWriter({
      vault: opts.vault,
      dbPath: opts.dbPath,
      db: () => this.open().db,
      render: () => this.offload("note", () => renderHealthNote(this.open().db, { dbPath: opts.dbPath })),
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

  /* status(), but on a worker thread: the per-type aggregate scans every
     sample and must not stall the event loop. */
  statusAsync(): Promise<HealthStatus> {
    return this.offload("status", () => this.open().status());
  }

  /* Runs a heavy read on the worker; inline only when the worker bundle is
     missing. open() first so the file and schema exist before the worker
     opens the store read-only. */
  private async offload<T>(task: HealthTask, inline: () => T): Promise<T> {
    this.open();
    try {
      return await runHealthTask<T>(task, this.opts.dbPath);
    } catch (err) {
      if (!(err instanceof WorkerUnavailableError)) throw err;
      if (!this.warnedNoWorker) {
        this.warnedNoWorker = true;
        this.opts.log(`${err.message}; running apple-health reads inline`);
      }
      return inline();
    }
  }

  close(): void {
    this.notes.dispose();
    this.store?.close();
    this.store = null;
  }
}
