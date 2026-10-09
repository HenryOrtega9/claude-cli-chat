/* WHOOP history store: SQLite schema, upserts, backfill markers, status.

   The database lives OUTSIDE the vault (default
   ~/Library/Application Support/vault-gateway/whoop.sqlite), next to the
   Apple Health store and for the same reason: raw health data must never be
   committed or synced through the vault's git repo.

   Every table is keyed by WHOOP's own id (a cycle's integer id, a recovery's
   cycle_id, a sleep's or workout's UUID) and written with INSERT ... ON
   CONFLICT DO UPDATE, so a record WHOOP rescored overwrites the earlier copy.
   The update is skipped only when the stored copy carries a strictly newer
   updated_at, so a slow backfill page can never roll back what a poll just
   wrote. Each row also keeps the record's raw JSON, so a field this schema
   does not have yet can be backfilled from `raw` without refetching.

   Day attribution is stamped at write time and always comes from
   summary.ts's cycleDay through the cycles table:
   - a cycle's day is cycleDay(start, timezone_offset);
   - a sleep (nap or not) takes its cycle's day, which for the main sleep is
     the day it ends in; a sleep whose cycle is not stored yet falls back to
     the local date of its end;
   - a workout takes the day of the cycle it started in (a 22:00 run is the
     day it was run, a 00:30 one before bed is still the previous day); with
     no stored cycle covering it, the local date of its start.
   Writing a cycle re-stamps the sleeps and workouts it covers, so the order
   records arrive in (poll or backfill, cycles or workouts first) does not
   change the result. */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { openDatabase, type DatabaseSync, type Row, type SqlValue } from "../apple-health/sqlite";
import type { WhoopCollection, WhoopCycle, WhoopRecovery, WhoopSleep, WhoopWorkout } from "./api";
import { cycleDay, localDay, type WhoopRaw } from "./summary";

export const SCHEMA_VERSION = 1;

/* Backfill walks the collections in this order: cycles first, so every sleep
   and workout that follows lands on its cycle's day straight away. */
export const BACKFILL_ORDER: readonly WhoopCollection[] = ["cycle", "recovery", "sleep", "workout"];

export type WhoopBatch = {
  cycles?: WhoopCycle[];
  recoveries?: WhoopRecovery[];
  sleeps?: WhoopSleep[];
  workouts?: WhoopWorkout[];
};

export type WriteCounts = { cycles: number; recoveries: number; sleeps: number; workouts: number };

export type BackfillMarker = {
  collection: WhoopCollection;
  /* The token for the next page to fetch; null before the first page and
     once complete. */
  next_token: string | null;
  pages: number;
  records: number;
  started_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  last_error: string | null;
};

export type BackfillCollectionStatus = {
  state: "not_started" | "in_progress" | "complete";
  pages: number;
  records: number;
  has_next_token: boolean;
  started_at: string | null;
  updated_at: string | null;
  completed_at: string | null;
  last_error: string | null;
};

export type BackfillState = "not_started" | "in_progress" | "complete";

export type WhoopStoreStatus = {
  db_path: string;
  schema_version: number;
  counts: { cycles: number; recoveries: number; sleeps: number; workouts: number };
  oldest_day: string | null;
  newest_day: string | null;
  last_poll_write_at: string | null;
  backfill: {
    state: BackfillState;
    completed_at: string | null;
    collections: Record<WhoopCollection, BackfillCollectionStatus>;
  };
};

/* ---------- schema ---------- */

/* `end` is an SQL keyword: quote it ("end") in queries. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cycles (
  id              INTEGER PRIMARY KEY,
  day             TEXT NOT NULL,     -- cycleDay(start, timezone_offset)
  start           TEXT NOT NULL,
  "end"           TEXT,              -- null while the cycle is open
  start_ms        INTEGER NOT NULL,
  end_ms          INTEGER,
  timezone_offset TEXT,
  score_state     TEXT,
  strain          REAL,
  kilojoule       REAL,
  avg_hr          REAL,
  max_hr          REAL,
  updated_at      TEXT,
  fetched_at      TEXT NOT NULL,
  raw             TEXT NOT NULL      -- the record as WHOOP sent it (JSON)
);
CREATE INDEX IF NOT EXISTS cycles_day ON cycles(day);
CREATE INDEX IF NOT EXISTS cycles_start ON cycles(start_ms);

CREATE TABLE IF NOT EXISTS recoveries (
  cycle_id         INTEGER PRIMARY KEY,
  sleep_id         TEXT,
  score_state      TEXT,
  recovery_score   REAL,
  hrv_rmssd_ms     REAL,
  resting_hr       REAL,
  spo2_pct         REAL,
  skin_temp_c      REAL,
  user_calibrating INTEGER,          -- 0 / 1 / null
  updated_at       TEXT,
  fetched_at       TEXT NOT NULL,
  raw              TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sleeps (
  id               TEXT PRIMARY KEY,
  cycle_id         INTEGER,
  day              TEXT NOT NULL,    -- the cycle's day (else the local date of end)
  start            TEXT NOT NULL,
  "end"            TEXT NOT NULL,
  start_ms         INTEGER NOT NULL,
  end_ms           INTEGER NOT NULL,
  timezone_offset  TEXT,
  nap              INTEGER NOT NULL, -- 0 / 1
  score_state      TEXT,
  performance_pct  REAL,
  efficiency_pct   REAL,
  consistency_pct  REAL,
  respiratory_rate REAL,
  in_bed_ms        INTEGER,
  awake_ms         INTEGER,
  light_ms         INTEGER,
  sws_ms           INTEGER,
  rem_ms           INTEGER,
  disturbances     INTEGER,
  need_baseline_ms INTEGER,
  need_debt_ms     INTEGER,
  need_strain_ms   INTEGER,
  need_nap_ms      INTEGER,
  updated_at       TEXT,
  fetched_at       TEXT NOT NULL,
  raw              TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sleeps_day ON sleeps(day);
CREATE INDEX IF NOT EXISTS sleeps_cycle ON sleeps(cycle_id);

CREATE TABLE IF NOT EXISTS workouts (
  id              TEXT PRIMARY KEY,
  day             TEXT NOT NULL,     -- the day of the cycle it started in
  start           TEXT NOT NULL,
  "end"           TEXT NOT NULL,
  start_ms        INTEGER NOT NULL,
  end_ms          INTEGER NOT NULL,
  timezone_offset TEXT,
  sport_name      TEXT,
  score_state     TEXT,
  strain          REAL,
  kilojoule       REAL,
  avg_hr          REAL,
  max_hr          REAL,
  distance_m      REAL,
  altitude_gain_m REAL,
  zone0_ms        INTEGER,
  zone1_ms        INTEGER,
  zone2_ms        INTEGER,
  zone3_ms        INTEGER,
  zone4_ms        INTEGER,
  zone5_ms        INTEGER,
  updated_at      TEXT,
  fetched_at      TEXT NOT NULL,
  raw             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workouts_day ON workouts(day);
CREATE INDEX IF NOT EXISTS workouts_start ON workouts(start_ms);

CREATE TABLE IF NOT EXISTS backfill (
  collection   TEXT PRIMARY KEY,     -- cycle | recovery | sleep | workout
  next_token   TEXT,
  pages        INTEGER NOT NULL DEFAULT 0,
  records      INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT,
  updated_at   TEXT,
  completed_at TEXT,
  last_error   TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

/* Overwrite unless the stored copy is strictly newer (see the header). */
const NEWER = (table: string) =>
  `WHERE excluded.updated_at IS NULL OR ${table}.updated_at IS NULL OR excluded.updated_at >= ${table}.updated_at`;

const UPSERT_CYCLE = `
INSERT INTO cycles (id, day, start, "end", start_ms, end_ms, timezone_offset, score_state, strain, kilojoule, avg_hr, max_hr,
  updated_at, fetched_at, raw)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  day = excluded.day, start = excluded.start, "end" = excluded."end", start_ms = excluded.start_ms, end_ms = excluded.end_ms,
  timezone_offset = excluded.timezone_offset, score_state = excluded.score_state, strain = excluded.strain,
  kilojoule = excluded.kilojoule, avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, updated_at = excluded.updated_at,
  fetched_at = excluded.fetched_at, raw = excluded.raw
${NEWER("cycles")}`;

const UPSERT_RECOVERY = `
INSERT INTO recoveries (cycle_id, sleep_id, score_state, recovery_score, hrv_rmssd_ms, resting_hr, spo2_pct, skin_temp_c,
  user_calibrating, updated_at, fetched_at, raw)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(cycle_id) DO UPDATE SET
  sleep_id = excluded.sleep_id, score_state = excluded.score_state, recovery_score = excluded.recovery_score,
  hrv_rmssd_ms = excluded.hrv_rmssd_ms, resting_hr = excluded.resting_hr, spo2_pct = excluded.spo2_pct,
  skin_temp_c = excluded.skin_temp_c, user_calibrating = excluded.user_calibrating, updated_at = excluded.updated_at,
  fetched_at = excluded.fetched_at, raw = excluded.raw
${NEWER("recoveries")}`;

const UPSERT_SLEEP = `
INSERT INTO sleeps (id, cycle_id, day, start, "end", start_ms, end_ms, timezone_offset, nap, score_state, performance_pct,
  efficiency_pct, consistency_pct, respiratory_rate, in_bed_ms, awake_ms, light_ms, sws_ms, rem_ms, disturbances,
  need_baseline_ms, need_debt_ms, need_strain_ms, need_nap_ms, updated_at, fetched_at, raw)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  cycle_id = excluded.cycle_id, day = excluded.day, start = excluded.start, "end" = excluded."end",
  start_ms = excluded.start_ms, end_ms = excluded.end_ms, timezone_offset = excluded.timezone_offset, nap = excluded.nap,
  score_state = excluded.score_state, performance_pct = excluded.performance_pct, efficiency_pct = excluded.efficiency_pct,
  consistency_pct = excluded.consistency_pct, respiratory_rate = excluded.respiratory_rate, in_bed_ms = excluded.in_bed_ms,
  awake_ms = excluded.awake_ms, light_ms = excluded.light_ms, sws_ms = excluded.sws_ms, rem_ms = excluded.rem_ms,
  disturbances = excluded.disturbances, need_baseline_ms = excluded.need_baseline_ms, need_debt_ms = excluded.need_debt_ms,
  need_strain_ms = excluded.need_strain_ms, need_nap_ms = excluded.need_nap_ms, updated_at = excluded.updated_at,
  fetched_at = excluded.fetched_at, raw = excluded.raw
${NEWER("sleeps")}`;

const UPSERT_WORKOUT = `
INSERT INTO workouts (id, day, start, "end", start_ms, end_ms, timezone_offset, sport_name, score_state, strain, kilojoule,
  avg_hr, max_hr, distance_m, altitude_gain_m, zone0_ms, zone1_ms, zone2_ms, zone3_ms, zone4_ms, zone5_ms,
  updated_at, fetched_at, raw)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  day = excluded.day, start = excluded.start, "end" = excluded."end", start_ms = excluded.start_ms, end_ms = excluded.end_ms,
  timezone_offset = excluded.timezone_offset, sport_name = excluded.sport_name, score_state = excluded.score_state,
  strain = excluded.strain, kilojoule = excluded.kilojoule, avg_hr = excluded.avg_hr, max_hr = excluded.max_hr,
  distance_m = excluded.distance_m, altitude_gain_m = excluded.altitude_gain_m, zone0_ms = excluded.zone0_ms,
  zone1_ms = excluded.zone1_ms, zone2_ms = excluded.zone2_ms, zone3_ms = excluded.zone3_ms, zone4_ms = excluded.zone4_ms,
  zone5_ms = excluded.zone5_ms, updated_at = excluded.updated_at, fetched_at = excluded.fetched_at, raw = excluded.raw
${NEWER("workouts")}`;

/* ---------- value helpers ---------- */

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function bool(v: unknown): number | null {
  return typeof v === "boolean" ? (v ? 1 : 0) : null;
}

function ms(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function sqlNum(v: SqlValue | undefined): number {
  return typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : 0;
}

function sqlStr(v: SqlValue | undefined): string | null {
  return typeof v === "string" ? v : null;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/* ---------- store ---------- */

export class WhoopStore {
  readonly db: DatabaseSync;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = openDatabase(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
    this.db.prepare("INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)").run(SCHEMA_VERSION, new Date().toISOString());
  }

  /* One transaction for the whole batch. Records missing an id or a start
     are skipped and left out of the counts: one odd record must not cost
     the rest of the page. */
  write(batch: WhoopBatch, now: Date = new Date()): WriteCounts {
    return this.transaction(() => this.writeInside(batch, now.toISOString()));
  }

  /* Everything one poll fetched. The per-cycle recovery and sleep and the
     collection pages overlap; the upsert makes that harmless. */
  writePoll(raw: WhoopRaw, now: Date = new Date()): WriteCounts {
    const cycles = raw.cycles?.length ? raw.cycles : [raw.cycle, raw.previousCycle].filter((c): c is WhoopCycle => !!c);
    const recoveries = [...(raw.recoveries ?? []), raw.previousRecovery, raw.recovery].filter((r): r is WhoopRecovery => !!r);
    const workouts = raw.workouts?.length ? raw.workouts : [raw.workout].filter((w): w is WhoopWorkout => !!w);
    const at = now.toISOString();
    return this.transaction(() => {
      const counts = this.writeInside({ cycles, recoveries, sleeps: raw.sleep ? [raw.sleep] : [], workouts }, at);
      this.setMeta("last_poll_write_at", at);
      return counts;
    });
  }

  /* One backfill page and its marker, atomically: after a crash the marker
     never points past records that were not written. `done` marks the
     collection complete. */
  writeBackfillPage(collection: WhoopCollection, records: unknown[], nextToken: string | null, done: boolean, now: Date = new Date()): number {
    const at = now.toISOString();
    return this.transaction(() => {
      const batch: WhoopBatch = {};
      if (collection === "cycle") batch.cycles = records as WhoopCycle[];
      else if (collection === "recovery") batch.recoveries = records as WhoopRecovery[];
      else if (collection === "sleep") batch.sleeps = records as WhoopSleep[];
      else batch.workouts = records as WhoopWorkout[];
      const c = this.writeInside(batch, at);
      const written = c.cycles + c.recoveries + c.sleeps + c.workouts;
      this.db.prepare(`
        INSERT INTO backfill (collection, next_token, pages, records, started_at, updated_at, completed_at, last_error)
        VALUES (?, ?, 1, ?, ?, ?, ?, NULL)
        ON CONFLICT(collection) DO UPDATE SET
          next_token = excluded.next_token, pages = backfill.pages + 1, records = backfill.records + excluded.records,
          started_at = COALESCE(backfill.started_at, excluded.started_at), updated_at = excluded.updated_at,
          completed_at = excluded.completed_at, last_error = NULL`)
        .run(collection, done ? null : nextToken, written, at, at, done ? at : null);
      return written;
    });
  }

  backfillMarkers(): Map<WhoopCollection, BackfillMarker> {
    return readMarkers(this.db);
  }

  /* The first collection, in BACKFILL_ORDER, not yet complete; null when the
     whole history is in. */
  nextBackfill(): BackfillMarker | null {
    const markers = this.backfillMarkers();
    for (const collection of BACKFILL_ORDER) {
      const m = markers.get(collection);
      if (!m) return emptyMarker(collection);
      if (!m.completed_at) return m;
    }
    return null;
  }

  backfillComplete(): boolean {
    return this.nextBackfill() === null;
  }

  noteBackfillError(collection: WhoopCollection, message: string, now: Date = new Date()): void {
    const at = now.toISOString();
    this.db.prepare(`
      INSERT INTO backfill (collection, started_at, updated_at, last_error) VALUES (?, ?, ?, ?)
      ON CONFLICT(collection) DO UPDATE SET updated_at = excluded.updated_at, last_error = excluded.last_error`)
      .run(collection, at, at, message.slice(0, 500));
  }

  /* Forget one collection's progress (a resume token WHOOP no longer
     accepts) or all of it (`whoop backfill`). Records stay; the next pass
     upserts over them. */
  resetBackfill(collection?: WhoopCollection): void {
    if (collection) this.db.prepare("DELETE FROM backfill WHERE collection = ?").run(collection);
    else this.db.exec("DELETE FROM backfill");
  }

  status(): WhoopStoreStatus {
    return readStoreStatus(this.db, this.path);
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw err;
    }
  }

  /* Caller holds the transaction. Cycles go first, oldest first, so the
     re-stamping in upsertCycle leaves every sleep and workout on the newest
     cycle that covers it. */
  private writeInside(batch: WhoopBatch, at: string): WriteCounts {
    const counts: WriteCounts = { cycles: 0, recoveries: 0, sleeps: 0, workouts: 0 };
    const cycles = [...(batch.cycles ?? [])].filter(isObject).sort((a, b) => (ms(a.start) ?? 0) - (ms(b.start) ?? 0));
    for (const c of cycles) if (this.upsertCycle(c, at)) counts.cycles++;
    for (const r of (batch.recoveries ?? []).filter(isObject)) if (this.upsertRecovery(r, at)) counts.recoveries++;
    for (const s of (batch.sleeps ?? []).filter(isObject)) if (this.upsertSleep(s, at)) counts.sleeps++;
    for (const w of (batch.workouts ?? []).filter(isObject)) if (this.upsertWorkout(w, at)) counts.workouts++;
    return counts;
  }

  private upsertCycle(c: WhoopCycle, at: string): boolean {
    const startMs = ms(c.start);
    const id = int(c.id);
    if (startMs === null || id === null) return false;
    const day = cycleDay(c.start, c.timezone_offset);
    if (day === null) return false;
    const endMs = ms(c.end);
    const s = isObject(c.score) ? c.score : {};
    this.db.prepare(UPSERT_CYCLE).run(
      id, day, c.start, str(c.end), startMs, endMs, str(c.timezone_offset), str(c.score_state),
      num(s.strain), num(s.kilojoule), num(s.average_heart_rate), num(s.max_heart_rate),
      str(c.updated_at), at, JSON.stringify(c),
    );
    /* Re-stamp what this cycle covers: its sleeps by id, its workouts by
       start time. An open cycle (no end) covers everything after its start
       until the next cycle is written. */
    this.db.prepare("UPDATE sleeps SET day = ? WHERE cycle_id = ? AND day <> ?").run(day, id, day);
    if (endMs === null) {
      this.db.prepare("UPDATE workouts SET day = ? WHERE start_ms >= ? AND day <> ?").run(day, startMs, day);
    } else {
      this.db.prepare("UPDATE workouts SET day = ? WHERE start_ms >= ? AND start_ms < ? AND day <> ?").run(day, startMs, endMs, day);
    }
    return true;
  }

  private upsertRecovery(r: WhoopRecovery, at: string): boolean {
    const cycleId = int(r.cycle_id);
    if (cycleId === null) return false;
    const s = isObject(r.score) ? r.score : {};
    this.db.prepare(UPSERT_RECOVERY).run(
      cycleId, str(r.sleep_id), str(r.score_state), num(s.recovery_score), num(s.hrv_rmssd_milli), num(s.resting_heart_rate),
      num(s.spo2_percentage), num(s.skin_temp_celsius), bool(s.user_calibrating),
      str(r.updated_at), at, JSON.stringify(r),
    );
    return true;
  }

  private upsertSleep(sl: WhoopSleep, at: string): boolean {
    const startMs = ms(sl.start);
    const endMs = ms(sl.end);
    if (typeof sl.id !== "string" || !sl.id || startMs === null || endMs === null) return false;
    const cycleId = int(sl.cycle_id);
    const cycleDayRow = cycleId === null ? undefined : this.db.prepare("SELECT day FROM cycles WHERE id = ?").get(cycleId);
    const day = sqlStr(cycleDayRow?.day) ?? localDay(sl.end, sl.timezone_offset);
    if (day === null) return false;
    const s = isObject(sl.score) ? sl.score : {};
    const st = isObject(s.stage_summary) ? s.stage_summary : {};
    const need = isObject(s.sleep_needed) ? s.sleep_needed : {};
    this.db.prepare(UPSERT_SLEEP).run(
      sl.id, cycleId, day, sl.start, sl.end, startMs, endMs, str(sl.timezone_offset), sl.nap === true ? 1 : 0, str(sl.score_state),
      num(s.sleep_performance_percentage), num(s.sleep_efficiency_percentage), num(s.sleep_consistency_percentage),
      num(s.respiratory_rate), int(st.total_in_bed_time_milli), int(st.total_awake_time_milli),
      int(st.total_light_sleep_time_milli), int(st.total_slow_wave_sleep_time_milli), int(st.total_rem_sleep_time_milli),
      int(st.disturbance_count), int(need.baseline_milli), int(need.need_from_sleep_debt_milli),
      int(need.need_from_recent_strain_milli), int(need.need_from_recent_nap_milli),
      str(sl.updated_at), at, JSON.stringify(sl),
    );
    return true;
  }

  private upsertWorkout(w: WhoopWorkout, at: string): boolean {
    const startMs = ms(w.start);
    const endMs = ms(w.end);
    if (typeof w.id !== "string" || !w.id || startMs === null || endMs === null) return false;
    const covering = this.db.prepare(
      "SELECT day FROM cycles WHERE start_ms <= ? AND (end_ms IS NULL OR end_ms > ?) ORDER BY start_ms DESC LIMIT 1",
    ).get(startMs, startMs);
    const day = sqlStr(covering?.day) ?? localDay(w.start, w.timezone_offset);
    if (day === null) return false;
    const s = isObject(w.score) ? w.score : {};
    const z = isObject(s.zone_durations) ? s.zone_durations : {};
    this.db.prepare(UPSERT_WORKOUT).run(
      w.id, day, w.start, w.end, startMs, endMs, str(w.timezone_offset), str(w.sport_name), str(w.score_state),
      num(s.strain), num(s.kilojoule), num(s.average_heart_rate), num(s.max_heart_rate),
      num(s.distance_meter), num(s.altitude_gain_meter),
      int(z.zone_zero_milli), int(z.zone_one_milli), int(z.zone_two_milli),
      int(z.zone_three_milli), int(z.zone_four_milli), int(z.zone_five_milli),
      str(w.updated_at), at, JSON.stringify(w),
    );
    return true;
  }
}

function emptyMarker(collection: WhoopCollection): BackfillMarker {
  return { collection, next_token: null, pages: 0, records: 0, started_at: null, updated_at: null, completed_at: null, last_error: null };
}

function readMarkers(db: DatabaseSync): Map<WhoopCollection, BackfillMarker> {
  const out = new Map<WhoopCollection, BackfillMarker>();
  for (const r of db.prepare("SELECT * FROM backfill").all() as Row[]) {
    const collection = sqlStr(r.collection) as WhoopCollection | null;
    if (!collection || !BACKFILL_ORDER.includes(collection)) continue;
    out.set(collection, {
      collection,
      next_token: sqlStr(r.next_token),
      pages: sqlNum(r.pages),
      records: sqlNum(r.records),
      started_at: sqlStr(r.started_at),
      updated_at: sqlStr(r.updated_at),
      completed_at: sqlStr(r.completed_at),
      last_error: sqlStr(r.last_error),
    });
  }
  return out;
}

/* Shared by the daemon (POST /whoop/backfill's answer) and `whoop status`,
   which reads through its own read-only connection. */
export function readStoreStatus(db: DatabaseSync, dbPath: string): WhoopStoreStatus {
  const count = (table: string) => sqlNum(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n);
  const span = db.prepare("SELECT MIN(day) AS oldest, MAX(day) AS newest FROM cycles").get();
  const version = sqlNum(db.prepare("SELECT MAX(version) AS v FROM schema_version").get()?.v);
  const lastWrite = sqlStr(db.prepare("SELECT value FROM meta WHERE key = 'last_poll_write_at'").get()?.value);
  const markers = readMarkers(db);
  const collections = {} as Record<WhoopCollection, BackfillCollectionStatus>;
  for (const c of BACKFILL_ORDER) {
    const m = markers.get(c) ?? emptyMarker(c);
    collections[c] = {
      state: m.completed_at ? "complete" : m.started_at ? "in_progress" : "not_started",
      pages: m.pages,
      records: m.records,
      has_next_token: m.next_token !== null,
      started_at: m.started_at,
      updated_at: m.updated_at,
      completed_at: m.completed_at,
      last_error: m.last_error,
    };
  }
  const states = BACKFILL_ORDER.map(c => collections[c].state);
  const state: BackfillState = states.every(s => s === "complete")
    ? "complete"
    : states.every(s => s === "not_started") ? "not_started" : "in_progress";
  const completedAt = state === "complete"
    ? BACKFILL_ORDER.map(c => collections[c].completed_at ?? "").sort().at(-1) ?? null
    : null;
  return {
    db_path: dbPath,
    schema_version: version,
    counts: { cycles: count("cycles"), recoveries: count("recoveries"), sleeps: count("sleeps"), workouts: count("workouts") },
    oldest_day: sqlStr(span?.oldest),
    newest_day: sqlStr(span?.newest),
    last_poll_write_at: lastWrite,
    backfill: { state, completed_at: completedAt, collections },
  };
}
