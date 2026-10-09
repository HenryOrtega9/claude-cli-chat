/* Runs the Apple Health store's heavy reads on a worker thread.

   node:sqlite's DatabaseSync is fully synchronous. Rendering the feed note
   (and GET /apple-health/status) aggregates over every stored sample, which on
   a multi-GB store takes seconds when the pages are cold. On the daemon's one
   thread that froze every WebSocket token stream, /health probe and /wait
   long-poll for the duration. The worker opens its own read-only connection
   (the store is in WAL mode, so a concurrent reader is safe) and posts back
   the result; ingest stays on the main thread.

   The worker is its own bundle (dist/apple-health-worker.js, built by
   build.mjs next to dist/gateway.js). When that file is missing (a bundle
   built some other way, such as the offline test's) callers get
   WorkerUnavailableError and fall back to running the read inline. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

export const HEALTH_WORKER_FILE = "apple-health-worker.js";

export type HealthTask = "note" | "status";

export type HealthWorkerData = { task: HealthTask; dbPath: string };
export type HealthWorkerReply = { ok: true; value: unknown } | { ok: false; error: string };

export class WorkerUnavailableError extends Error {
  constructor(file: string) {
    super(`apple-health worker not found at ${file}`);
    this.name = "WorkerUnavailableError";
  }
}

export function runHealthTask<T>(task: HealthTask, dbPath: string): Promise<T> {
  const file = join(__dirname, HEALTH_WORKER_FILE);
  if (!existsSync(file)) return Promise.reject(new WorkerUnavailableError(file));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const data: HealthWorkerData = { task, dbPath };
    const worker = new Worker(file, { workerData: data });
    worker.once("message", (reply: HealthWorkerReply) => {
      if (settled) return;
      settled = true;
      if (reply.ok) resolve(reply.value as T);
      else reject(new Error(reply.error));
    });
    worker.once("error", err => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    worker.once("exit", code => {
      if (settled) return;
      settled = true;
      reject(new Error(`apple-health worker exited (code ${code}) before answering`));
    });
  });
}
