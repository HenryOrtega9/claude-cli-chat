/* Apple Health store: payload validation, SQLite schema, upserts, status.
   Contract: docs/ios-gateway/APPLE-HEALTH.md.

   The database lives OUTSIDE the vault (default
   ~/Library/Application Support/vault-gateway/apple-health.sqlite): the vault
   is a git repo synced through iCloud, and raw health samples must never be
   committed or synced through it. Only the derived summary note goes there.

   Validation is all-or-nothing and runs before the transaction opens, so a
   400 never leaves a half-written batch behind. The phone persists its
   HealthKit anchor only after a 200, which means a rejected batch is resent;
   that is why the checks here are structural (types, dates, ids, sizes) and
   not opinions about the data, which would wedge the sync on one odd sample. */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { isIsoDate, parseInstant } from "./dates";
import { openDatabase, type DatabaseSync, type Row, type SqlValue } from "./sqlite";

export const SCHEMA_VERSION = 1;

/* Per-batch caps. Samples and daily rows are the contract's own batch sizes;
   deletions ride along with an anchored query page, so they get the larger. */
export const LIMITS = { samples: 2000, deleted: 5000, daily: 5000 } as const;

const UUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const MAX_STRING = 512;
const MAX_METADATA_BYTES = 16 * 1024;

export type SampleKind = "quantity" | "category" | "workout";

export type WorkoutInfo = {
  activityType: number | null;
  activityName: string | null;
  durationSec: number;
  energyKcal: number | null;
  distanceMi: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  isIndoor: boolean | null;
};

export type IngestSample = {
  uuid: string;
  kind: SampleKind;
  type: string;
  start: string;
  end: string;
  startMs: number;
  endMs: number;
  startLocal: string;
  endLocal: string;
  value: number | null;
  unit: string | null;
  category: number | null;
  categoryLabel: string | null;
  sourceName: string;
  sourceBundleId: string;
  sourceVersion: string | null;
  deviceName: string | null;
  deviceModel: string | null;
  metadata: Record<string, unknown> | null;
  workout: WorkoutInfo | null;
};

export type IngestDaily = {
  date: string;
  type: string;
  unit: string | null;
  sum: number | null;
  avg: number | null;
  min: number | null;
  max: number | null;
  mostRecent: number | null;
};

export type DeviceInfo = {
  name: string | null;
  model: string | null;
  systemVersion: string | null;
  timeZone: string | null;
};

export type IngestPayload = {
  schema: 1;
  batchId: string;
  device: DeviceInfo | null;
  samples: IngestSample[];
  deleted: Array<{ uuid: string; type: string | null }>;
  daily: IngestDaily[];
  characteristics: Record<string, unknown> | null;
};

/* `deletedFrom` is the earliest local_date among the deleted samples that
   actually existed (null when none matched). Deleting a sample does not
   touch daily_stats, which the phone computes; this tells the phone from
   which day to recompute and resend its daily stats. */
export type IngestResult = { samples: number; deleted: number; daily: number; deletedFrom: string | null };

export type HealthStatus = {
  dbPath: string;
  samples: number;
  daily: number;
  lastIngestAt: string | null;
  lastBatch: { batchId: string; at: string; samples: number; deleted: number; daily: number } | null;
  types: Array<{ type: string; kind: string; count: number; first: string | null; last: string | null }>;
};

export class PayloadError extends Error {}

/* ---------- validation ---------- */

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(path: string, expected: string): never {
  throw new PayloadError(`${path}: expected ${expected}`);
}

function optString(v: unknown, path: string, required = false): string | null {
  if (v === undefined || v === null) {
    if (required) fail(path, "a string");
    return null;
  }
  if (typeof v !== "string" || v.length > MAX_STRING) fail(path, `a string of at most ${MAX_STRING} chars`);
  return v;
}

function reqString(v: unknown, path: string): string {
  const s = optString(v, path, true);
  if (!s) fail(path, "a non-empty string");
  return s;
}

function optNumber(v: unknown, path: string): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "a finite number or null");
  return v;
}

function optInt(v: unknown, path: string): number | null {
  const n = optNumber(v, path);
  if (n !== null && !Number.isInteger(n)) fail(path, "an integer or null");
  return n;
}

function optBool(v: unknown, path: string): boolean | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "boolean") fail(path, "a boolean or null");
  return v;
}

function uuid(v: unknown, path: string): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) fail(path, "a UUID string");
  return v.toUpperCase();
}

function optArray(v: unknown, path: string, max: number): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) fail(path, "an array");
  if (v.length > max) throw new PayloadError(`${path}: at most ${max} items per batch (got ${v.length})`);
  return v;
}

function validZone(zone: string | null): string | null {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/* `fallbackSec` is end - start: the app sends null for any non-finite
   statistic, and a workout with no reported duration is still a workout. */
function validateWorkout(v: unknown, path: string, fallbackSec: number): WorkoutInfo {
  if (!isObject(v)) fail(path, "a workout object");
  const durationSec = optNumber(v.durationSec, `${path}.durationSec`) ?? Math.max(0, fallbackSec);
  if (durationSec < 0) fail(`${path}.durationSec`, "a non-negative number");
  return {
    activityType: optInt(v.activityType, `${path}.activityType`),
    activityName: optString(v.activityName, `${path}.activityName`),
    durationSec,
    energyKcal: optNumber(v.energyKcal, `${path}.energyKcal`),
    distanceMi: optNumber(v.distanceMi, `${path}.distanceMi`),
    avgHeartRate: optNumber(v.avgHeartRate, `${path}.avgHeartRate`),
    maxHeartRate: optNumber(v.maxHeartRate, `${path}.maxHeartRate`),
    isIndoor: optBool(v.isIndoor, `${path}.isIndoor`),
  };
}

function validateSample(v: unknown, path: string, zone: string | null): IngestSample {
  if (!isObject(v)) fail(path, "an object");
  const kind = v.kind;
  if (kind !== "quantity" && kind !== "category" && kind !== "workout") fail(`${path}.kind`, `"quantity", "category" or "workout"`);
  const start = parseInstant(v.start, zone);
  if (!start) fail(`${path}.start`, "an ISO 8601 date-time with an offset");
  const end = parseInstant(v.end, zone);
  if (!end) fail(`${path}.end`, "an ISO 8601 date-time with an offset");
  const source = v.source;
  if (!isObject(source)) fail(`${path}.source`, "an object");
  let metadata: Record<string, unknown> | null = null;
  if (v.metadata !== undefined && v.metadata !== null) {
    if (!isObject(v.metadata)) fail(`${path}.metadata`, "an object or null");
    /* Oversized metadata is dropped, not rejected: it is never load-bearing
       here, and a 400 would wedge the sync on that one sample forever. */
    metadata = JSON.stringify(v.metadata).length > MAX_METADATA_BYTES ? { _dropped: "metadata over 16 KiB" } : v.metadata;
  }
  const workout = v.workout === undefined || v.workout === null
    ? null
    : validateWorkout(v.workout, `${path}.workout`, (end.ms - start.ms) / 1000);
  if (kind === "workout" && !workout) fail(`${path}.workout`, "a workout object for kind \"workout\"");
  return {
    uuid: uuid(v.uuid, `${path}.uuid`),
    kind,
    type: reqString(v.type, `${path}.type`),
    start: v.start as string,
    end: v.end as string,
    startMs: start.ms,
    endMs: end.ms,
    startLocal: start.local,
    endLocal: end.local,
    value: optNumber(v.value, `${path}.value`),
    unit: optString(v.unit, `${path}.unit`),
    category: optInt(v.category, `${path}.category`),
    categoryLabel: optString(v.categoryLabel, `${path}.categoryLabel`),
    sourceName: optString(source.name, `${path}.source.name`) ?? "",
    sourceBundleId: optString(source.bundleId, `${path}.source.bundleId`) ?? "",
    sourceVersion: optString(source.version, `${path}.source.version`),
    deviceName: optString(v.deviceName, `${path}.deviceName`),
    deviceModel: optString(v.deviceModel, `${path}.deviceModel`),
    metadata,
    workout,
  };
}

function validateDaily(v: unknown, path: string): IngestDaily {
  if (!isObject(v)) fail(path, "an object");
  if (!isIsoDate(v.date)) fail(`${path}.date`, "a YYYY-MM-DD date");
  return {
    date: v.date,
    type: reqString(v.type, `${path}.type`),
    unit: optString(v.unit, `${path}.unit`),
    sum: optNumber(v.sum, `${path}.sum`),
    avg: optNumber(v.avg, `${path}.avg`),
    min: optNumber(v.min, `${path}.min`),
    max: optNumber(v.max, `${path}.max`),
    mostRecent: optNumber(v.mostRecent, `${path}.mostRecent`),
  };
}

function validateCharacteristics(v: unknown): Record<string, unknown> | null {
  if (v === undefined || v === null) return null;
  if (!isObject(v)) fail("characteristics", "an object or null");
  const dob = v.dateOfBirth;
  if (dob !== undefined && dob !== null && !isIsoDate(dob)) fail("characteristics.dateOfBirth", "a YYYY-MM-DD date or null");
  for (const key of ["biologicalSex", "bloodType", "fitzpatrickSkinType"]) optString(v[key], `characteristics.${key}`);
  optBool(v.wheelchairUse, "characteristics.wheelchairUse");
  return {
    dateOfBirth: dob ?? null,
    biologicalSex: v.biologicalSex ?? null,
    bloodType: v.bloodType ?? null,
    fitzpatrickSkinType: v.fitzpatrickSkinType ?? null,
    wheelchairUse: v.wheelchairUse ?? null,
  };
}

export function validatePayload(raw: unknown): IngestPayload {
  if (!isObject(raw)) throw new PayloadError("body: expected a JSON object");
  if (raw.schema !== 1) fail("schema", "1");
  uuid(raw.batchId, "batchId");
  const batchId = raw.batchId as string; // kept as sent: it is the client's handle for this batch in the logs
  let device: DeviceInfo | null = null;
  if (raw.device !== undefined && raw.device !== null) {
    if (!isObject(raw.device)) fail("device", "an object");
    device = {
      name: optString(raw.device.name, "device.name"),
      model: optString(raw.device.model, "device.model"),
      systemVersion: optString(raw.device.systemVersion, "device.systemVersion"),
      timeZone: optString(raw.device.timeZone, "device.timeZone"),
    };
  }
  const zone = validZone(device?.timeZone ?? null);
  const samples = optArray(raw.samples, "samples", LIMITS.samples).map((s, i) => validateSample(s, `samples[${i}]`, zone));
  const deleted = optArray(raw.deleted, "deleted", LIMITS.deleted).map((d, i) => {
    if (!isObject(d)) fail(`deleted[${i}]`, "an object");
    return { uuid: uuid(d.uuid, `deleted[${i}].uuid`), type: optString(d.type, `deleted[${i}].type`) };
  });
  const daily = optArray(raw.daily, "daily", LIMITS.daily).map((d, i) => validateDaily(d, `daily[${i}]`));
  return { schema: 1, batchId, device, samples, deleted, daily, characteristics: validateCharacteristics(raw.characteristics) };
}

/* ---------- schema ---------- */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS samples (
  uuid             TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  type             TEXT NOT NULL,
  start_at         TEXT NOT NULL,   -- ISO 8601 exactly as sent (device offset)
  end_at           TEXT NOT NULL,
  start_ms         INTEGER NOT NULL,
  end_ms           INTEGER NOT NULL,
  start_local      TEXT NOT NULL,   -- local wall clock, YYYY-MM-DDTHH:MM:SS
  end_local        TEXT NOT NULL,
  local_date       TEXT NOT NULL,   -- YYYY-MM-DD of start_local
  value            REAL,
  unit             TEXT,
  category         INTEGER,
  category_label   TEXT,
  source_name      TEXT,
  source_bundle_id TEXT,
  source_version   TEXT,
  device_name      TEXT,
  device_model     TEXT,
  metadata         TEXT,            -- JSON
  workout          TEXT,            -- JSON
  ingested_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS samples_type_kind_start ON samples(type, kind, start_ms);
CREATE INDEX IF NOT EXISTS samples_type_date ON samples(type, local_date);
CREATE INDEX IF NOT EXISTS samples_kind_date ON samples(kind, local_date);

CREATE TABLE IF NOT EXISTS daily_stats (
  date        TEXT NOT NULL,
  type        TEXT NOT NULL,
  unit        TEXT,
  sum         REAL,
  avg         REAL,
  min         REAL,
  max         REAL,
  most_recent REAL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (date, type)
);

CREATE TABLE IF NOT EXISTS characteristics (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  data       TEXT NOT NULL,         -- JSON
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL,
  at       TEXT NOT NULL,
  samples  INTEGER NOT NULL,
  deleted  INTEGER NOT NULL,
  daily    INTEGER NOT NULL,
  device   TEXT                     -- JSON
);
`;

const UPSERT_SAMPLE = `
INSERT INTO samples (uuid, kind, type, start_at, end_at, start_ms, end_ms, start_local, end_local, local_date,
  value, unit, category, category_label, source_name, source_bundle_id, source_version,
  device_name, device_model, metadata, workout, ingested_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(uuid) DO UPDATE SET
  kind = excluded.kind, type = excluded.type, start_at = excluded.start_at, end_at = excluded.end_at,
  start_ms = excluded.start_ms, end_ms = excluded.end_ms, start_local = excluded.start_local,
  end_local = excluded.end_local, local_date = excluded.local_date, value = excluded.value,
  unit = excluded.unit, category = excluded.category, category_label = excluded.category_label,
  source_name = excluded.source_name, source_bundle_id = excluded.source_bundle_id,
  source_version = excluded.source_version, device_name = excluded.device_name,
  device_model = excluded.device_model, metadata = excluded.metadata, workout = excluded.workout,
  ingested_at = excluded.ingested_at`;

const UPSERT_DAILY = `
INSERT INTO daily_stats (date, type, unit, sum, avg, min, max, most_recent, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(date, type) DO UPDATE SET
  unit = excluded.unit, sum = excluded.sum, avg = excluded.avg, min = excluded.min,
  max = excluded.max, most_recent = excluded.most_recent, updated_at = excluded.updated_at`;

/* ---------- store ---------- */

export class HealthStore {
  readonly db: DatabaseSync;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = openDatabase(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /* One transaction per batch: a crash mid-batch leaves nothing behind, and
     the phone resends the whole batch because its anchor never advanced.
     Upserts run before deletions so a sample added and deleted inside the
     same anchored page ends up deleted. */
  ingest(p: IngestPayload, now: Date = new Date()): IngestResult {
    const at = now.toISOString();
    const upsertSample = this.db.prepare(UPSERT_SAMPLE);
    const deleteSample = this.db.prepare("DELETE FROM samples WHERE uuid = ?");
    const sampleDate = this.db.prepare("SELECT local_date FROM samples WHERE uuid = ?");
    const upsertDaily = this.db.prepare(UPSERT_DAILY);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const s of p.samples) {
        upsertSample.run(
          s.uuid, s.kind, s.type, s.start, s.end, s.startMs, s.endMs, s.startLocal, s.endLocal, s.startLocal.slice(0, 10),
          s.value, s.unit, s.category, s.categoryLabel, s.sourceName, s.sourceBundleId, s.sourceVersion,
          s.deviceName, s.deviceModel,
          s.metadata ? JSON.stringify(s.metadata) : null,
          s.workout ? JSON.stringify(s.workout) : null,
          at,
        );
      }
      let deleted = 0;
      let deletedFrom: string | null = null;
      for (const d of p.deleted) {
        const date = sampleDate.get(d.uuid)?.local_date;
        if (typeof date === "string" && (deletedFrom === null || date < deletedFrom)) deletedFrom = date;
        deleted += Number(deleteSample.run(d.uuid).changes);
      }
      for (const d of p.daily) {
        upsertDaily.run(d.date, d.type, d.unit, d.sum, d.avg, d.min, d.max, d.mostRecent, at);
      }
      if (p.characteristics) {
        this.db.prepare(
          "INSERT INTO characteristics (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
        ).run(JSON.stringify(p.characteristics), at);
      }
      this.db.prepare("INSERT INTO ingest_log (batch_id, at, samples, deleted, daily, device) VALUES (?, ?, ?, ?, ?, ?)")
        .run(p.batchId, at, p.samples.length, deleted, p.daily.length, p.device ? JSON.stringify(p.device) : null);
      this.db.exec("COMMIT");
      return { samples: p.samples.length, deleted, daily: p.daily.length, deletedFrom };
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw err;
    }
  }

  status(): HealthStatus {
    return readStatus(this.db, this.path);
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }
}

function num(v: SqlValue | undefined): number {
  return typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0;
}

function str(v: SqlValue | undefined): string | null {
  return typeof v === "string" ? v : null;
}

/* Shared by GET /apple-health/status and `apple-health status`. The per-type
   aggregate walks the (type, kind, start_ms) index rather than the table. */
export function readStatus(db: DatabaseSync, dbPath: string): HealthStatus {
  const samples = num(db.prepare("SELECT COUNT(*) AS n FROM samples").get()?.n);
  const daily = num(db.prepare("SELECT COUNT(*) AS n FROM daily_stats").get()?.n);
  const last: Row | undefined = db.prepare("SELECT batch_id, at, samples, deleted, daily FROM ingest_log ORDER BY id DESC LIMIT 1").get();
  const types = db.prepare(
    "SELECT type, kind, COUNT(*) AS count, MIN(start_ms) AS first, MAX(start_ms) AS last FROM samples GROUP BY type, kind ORDER BY type",
  ).all().map(r => ({
    type: str(r.type) ?? "",
    kind: str(r.kind) ?? "",
    count: num(r.count),
    first: r.first === null ? null : new Date(num(r.first)).toISOString(),
    last: r.last === null ? null : new Date(num(r.last)).toISOString(),
  }));
  return {
    dbPath,
    samples,
    daily,
    lastIngestAt: last ? str(last.at) : null,
    lastBatch: last
      ? { batchId: str(last.batch_id) ?? "", at: str(last.at) ?? "", samples: num(last.samples), deleted: num(last.deleted), daily: num(last.daily) }
      : null,
    types,
  };
}
