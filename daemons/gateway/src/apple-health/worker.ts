/* Worker-thread entry for the Apple Health store's heavy reads (see
   offload.ts). Bundled by build.mjs to dist/apple-health-worker.js. One job
   per worker: open read-only, run it, post the result, exit. */

import { parentPort, workerData } from "node:worker_threads";

import type { HealthWorkerData, HealthWorkerReply } from "./offload";
import { renderHealthNote } from "./note";
import { openDatabase } from "./sqlite";
import { readStatus } from "./store";

function run(): HealthWorkerReply {
  const { task, dbPath } = workerData as HealthWorkerData;
  try {
    const db = openDatabase(dbPath, { readOnly: true });
    try {
      /* The writer holds the main connection; a reader can still hit a
         transient SQLITE_BUSY around a checkpoint. */
      db.exec("PRAGMA busy_timeout = 5000;");
      const value = task === "note" ? renderHealthNote(db, { dbPath }) : readStatus(db, dbPath);
      return { ok: true, value };
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

parentPort?.postMessage(run());
