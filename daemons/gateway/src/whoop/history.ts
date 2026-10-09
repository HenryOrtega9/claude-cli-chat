/* Daily, workout and weekly views over the WHOOP history store, for the
   `whoop` CLI and everything built on it (the weekly health review, the
   WHOOP MCP server). Read-only: every function takes a connection and runs
   SELECTs only.

   The JSON shapes here are a contract: keys, order, units and rounding are
   documented in the README's WHOOP section and must not drift.

   Day rules come from the store (see store.ts): each row's `day` column was
   stamped through summary.ts's cycleDay, so these views and the watch's
   `week` always agree. When two cycles land on one day (rare: a split night
   or a timezone jump), the later-starting one is that day's cycle.

   Only SCORED records contribute numbers; a pending or unscorable record
   reads as null, like the watch summary. */

import { addDays, dateRange, sundayOf } from "../apple-health/dates";
import type { DatabaseSync, Row, SqlValue } from "../apple-health/sqlite";
import { band, kcalFromKj, type Band } from "./summary";

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;
const PRIOR_DAYS = 28;

export type DailyRow = {
  day: string;
  recovery: number | null;
  band: Band | null;
  hrv_ms: number | null;
  rhr_bpm: number | null;
  spo2_pct: number | null;
  skin_temp_c: number | null;
  strain: number | null;
  kcal: number | null;
  avg_hr_bpm: number | null;
  max_hr_bpm: number | null;
  sleep_performance_pct: number | null;
  sleep_hours: number | null;
  sleep_need_hours: number | null;
  sleep_debt_hours: number | null;
  sleep_efficiency_pct: number | null;
  sleep_consistency_pct: number | null;
  respiratory_rate: number | null;
  disturbances: number | null;
  nap_hours: number | null;
  workouts: number;
};

export type WorkoutRow = {
  day: string;
  start: string;
  end: string;
  sport: string;
  strain: number | null;
  kcal: number | null;
  avg_hr_bpm: number | null;
  max_hr_bpm: number | null;
  distance_km: number | null;
  altitude_gain_m: number | null;
  /* Minutes in zones 0..5 at 1 dp; null when WHOOP sent no zone data. */
  zones_min: number[] | null;
  duration_min: number;
};

export type WeekSummary = {
  days_with_recovery: number;
  recovery_avg: number | null;
  recovery_min: number | null;
  recovery_max: number | null;
  band_counts: { green: number; yellow: number; red: number };
  hrv_avg_ms: number | null;
  rhr_avg_bpm: number | null;
  strain_avg: number | null;
  strain_total: number | null;
  sleep_hours_avg: number | null;
  sleep_need_hours_avg: number | null;
  sleep_performance_avg: number | null;
  zone_minutes: number[];
  workout_count: number;
};

export type PriorWindow = {
  recovery_avg: number | null;
  hrv_avg_ms: number | null;
  rhr_avg_bpm: number | null;
  strain_avg: number | null;
  sleep_hours_avg: number | null;
};

export type WeekView = {
  week_start: string;
  week_end: string;
  days: DailyRow[];
  workouts: WorkoutRow[];
  summary: WeekSummary;
  prior_4wk: PriorWindow;
};

/* ---------- value helpers ---------- */

function num(v: SqlValue | undefined): number | null {
  if (typeof v === "bigint") return Number(v);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/* Half-up at `digits`, decided on the decimal value: toPrecision(12) first
   strips binary noise, so a mean that is exactly 6.845 in decimal but sums
   to 6.84499999... in floating point still rounds to 6.85. */
function round(v: number | null, digits = 0): number | null {
  if (v === null) return null;
  const f = 10 ** digits;
  return Math.round(Number((v * f).toPrecision(12))) / f;
}

function text(v: SqlValue | undefined): string | null {
  return typeof v === "string" ? v : null;
}

const scored = (r: Row | undefined): r is Row => !!r && r.score_state === "SCORED";

/* Sum of the non-null millisecond fields as hours (unrounded), or null when
   every one is null. */
function hoursOf(...millis: (SqlValue | undefined)[]): number | null {
  let total = 0;
  let any = false;
  for (const m of millis) {
    const n = num(m);
    if (n === null) continue;
    total += n;
    any = true;
  }
  return any ? total / MS_PER_HOUR : null;
}

const asleepHours = (s: Row) => hoursOf(s.light_ms, s.sws_ms, s.rem_ms);

/* Mean of the non-null values, rounded; null when there are none. */
function mean(values: (number | null)[], digits: number): number | null {
  const xs = values.filter((v): v is number => v !== null);
  return xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length, digits) : null;
}

/* ---------- daily ---------- */

/* One row per calendar day from `from` to `to` inclusive, oldest first; a day
   with nothing stored still appears, every value null and workouts 0. */
export function dailyRows(db: DatabaseSync, from: string, to: string): DailyRow[] {
  const cycleByDay = new Map<string, Row>();
  for (const c of db.prepare('SELECT * FROM cycles WHERE day BETWEEN ? AND ? ORDER BY start_ms').all(from, to)) {
    cycleByDay.set(c.day as string, c); // later starts win
  }
  const recoveryByCycle = new Map<number, Row>();
  for (const r of db.prepare(
    "SELECT r.* FROM recoveries r JOIN cycles c ON c.id = r.cycle_id WHERE c.day BETWEEN ? AND ?",
  ).all(from, to)) {
    recoveryByCycle.set(num(r.cycle_id) ?? -1, r);
  }
  const sleepsByDay = new Map<string, Row[]>();
  for (const s of db.prepare("SELECT * FROM sleeps WHERE day BETWEEN ? AND ? ORDER BY start_ms").all(from, to)) {
    const list = sleepsByDay.get(s.day as string) ?? [];
    list.push(s);
    sleepsByDay.set(s.day as string, list);
  }
  const workoutsByDay = new Map<string, number>();
  for (const w of db.prepare("SELECT day, COUNT(*) AS n FROM workouts WHERE day BETWEEN ? AND ? GROUP BY day").all(from, to)) {
    workoutsByDay.set(w.day as string, num(w.n) ?? 0);
  }

  return dateRange(from, to).map(day => {
    const cycle = cycleByDay.get(day);
    const cycleId = cycle ? num(cycle.id) : null;
    const rec = cycleId === null ? undefined : recoveryByCycle.get(cycleId);
    const sleeps = sleepsByDay.get(day) ?? [];
    const naps = sleeps.filter(s => num(s.nap) === 1);
    const mains = sleeps.filter(s => num(s.nap) !== 1);
    /* The night's sleep: the one tied to the day's cycle, else the longest
       in bed. Its numbers are WHOOP's for that night and are taken as one
       set; a split night's other part is left out. */
    const main = mains.find(s => cycleId !== null && num(s.cycle_id) === cycleId)
      ?? [...mains].sort((a, b) => (num(b.in_bed_ms) ?? 0) - (num(a.in_bed_ms) ?? 0))[0];
    const workouts = workoutsByDay.get(day) ?? 0;
    const hasData = !!cycle || sleeps.length > 0 || workouts > 0;

    const recovery = scored(rec) ? round(num(rec.recovery_score)) : null;
    const c = scored(cycle) ? cycle : undefined;
    const s = scored(main) ? main : undefined;
    const scoredNaps = naps.filter(scored);
    const napHours = scoredNaps.reduce((t, n) => t + (asleepHours(n) ?? 0), 0);

    return {
      day,
      recovery,
      band: band(recovery),
      hrv_ms: scored(rec) ? round(num(rec.hrv_rmssd_ms), 1) : null,
      rhr_bpm: scored(rec) ? round(num(rec.resting_hr)) : null,
      spo2_pct: scored(rec) ? round(num(rec.spo2_pct), 1) : null,
      skin_temp_c: scored(rec) ? round(num(rec.skin_temp_c), 2) : null,
      strain: c ? round(num(c.strain), 1) : null,
      kcal: c ? kcalFromKj(num(c.kilojoule)) : null,
      avg_hr_bpm: c ? round(num(c.avg_hr)) : null,
      max_hr_bpm: c ? round(num(c.max_hr)) : null,
      sleep_performance_pct: s ? round(num(s.performance_pct)) : null,
      sleep_hours: s ? round(asleepHours(s), 2) : null,
      sleep_need_hours: s ? round(hoursOf(s.need_baseline_ms, s.need_debt_ms, s.need_strain_ms, s.need_nap_ms), 2) : null,
      sleep_debt_hours: s ? round(hoursOf(s.need_debt_ms), 2) : null,
      sleep_efficiency_pct: s ? round(num(s.efficiency_pct), 1) : null,
      sleep_consistency_pct: s ? round(num(s.consistency_pct), 1) : null,
      respiratory_rate: s ? round(num(s.respiratory_rate), 1) : null,
      disturbances: s ? round(num(s.disturbances)) : null,
      /* 0 on a day with data and no scored nap; null on a day with none. */
      nap_hours: hasData ? round(napHours, 2) : null,
      workouts,
    };
  });
}

/* ---------- workouts ---------- */

const ZONES = ["zone0_ms", "zone1_ms", "zone2_ms", "zone3_ms", "zone4_ms", "zone5_ms"] as const;

/* Workouts whose day falls in the range, oldest first. Strain, kcal and heart
   rates only once scored; distance and altitude whenever WHOOP sent them. */
export function workoutRows(db: DatabaseSync, from: string, to: string): WorkoutRow[] {
  return db.prepare("SELECT * FROM workouts WHERE day BETWEEN ? AND ? ORDER BY start_ms").all(from, to).map(w => {
    const isScored = scored(w);
    const zones = ZONES.map(z => num(w[z]));
    const distance = num(w.distance_m);
    return {
      day: w.day as string,
      start: text(w.start) ?? "",
      end: text(w.end) ?? "",
      sport: text(w.sport_name) || "activity",
      strain: isScored ? round(num(w.strain), 1) : null,
      kcal: isScored ? kcalFromKj(num(w.kilojoule)) : null,
      avg_hr_bpm: isScored ? round(num(w.avg_hr)) : null,
      max_hr_bpm: isScored ? round(num(w.max_hr)) : null,
      distance_km: distance === null ? null : round(distance / 1000, 2),
      altitude_gain_m: round(num(w.altitude_gain_m), 1),
      zones_min: zones.every(z => z === null) ? null : zones.map(z => round((z ?? 0) / MS_PER_MINUTE, 1) ?? 0),
      duration_min: round(((num(w.end_ms) ?? 0) - (num(w.start_ms) ?? 0)) / MS_PER_MINUTE, 1) ?? 0,
    };
  });
}

/* ---------- week ---------- */

/* The Sunday-to-Saturday week containing `date`. */
export function weekRange(date: string): { start: string; end: string } {
  const start = sundayOf(date);
  return { start, end: addDays(start, 6) };
}

/* Averages are over the daily rows' own (rounded) values, non-null days
   only, so anyone holding the rows can reproduce them: 1 dp, hours 2 dp. */
function summarize(days: DailyRow[], workouts: WorkoutRow[]): WeekSummary {
  const recoveries = days.map(d => d.recovery).filter((v): v is number => v !== null);
  const strains = days.map(d => d.strain).filter((v): v is number => v !== null);
  const bands = { green: 0, yellow: 0, red: 0 };
  for (const d of days) if (d.band) bands[d.band]++;
  const zones = [0, 0, 0, 0, 0, 0];
  for (const w of workouts) w.zones_min?.forEach((m, i) => { zones[i] += m; });
  return {
    days_with_recovery: recoveries.length,
    recovery_avg: mean(recoveries, 1),
    recovery_min: recoveries.length ? Math.min(...recoveries) : null,
    recovery_max: recoveries.length ? Math.max(...recoveries) : null,
    band_counts: bands,
    hrv_avg_ms: mean(days.map(d => d.hrv_ms), 1),
    rhr_avg_bpm: mean(days.map(d => d.rhr_bpm), 1),
    strain_avg: mean(strains, 1),
    strain_total: strains.length ? round(strains.reduce((a, b) => a + b, 0), 1) : null,
    sleep_hours_avg: mean(days.map(d => d.sleep_hours), 2),
    sleep_need_hours_avg: mean(days.map(d => d.sleep_need_hours), 2),
    sleep_performance_avg: mean(days.map(d => d.sleep_performance_pct), 1),
    zone_minutes: zones.map(z => round(z, 1) ?? 0),
    workout_count: workouts.length,
  };
}

function priorWindow(days: DailyRow[]): PriorWindow {
  return {
    recovery_avg: mean(days.map(d => d.recovery), 1),
    hrv_avg_ms: mean(days.map(d => d.hrv_ms), 1),
    rhr_avg_bpm: mean(days.map(d => d.rhr_bpm), 1),
    strain_avg: mean(days.map(d => d.strain), 1),
    sleep_hours_avg: mean(days.map(d => d.sleep_hours), 2),
  };
}

/* The Sunday-to-Saturday week containing `weekOf`, plus the 28 days before
   its Sunday as a baseline. */
export function weekView(db: DatabaseSync, weekOf: string): WeekView {
  const { start, end } = weekRange(weekOf);
  const days = dailyRows(db, start, end);
  const workouts = workoutRows(db, start, end);
  const prior = dailyRows(db, addDays(start, -PRIOR_DAYS), addDays(start, -1));
  return { week_start: start, week_end: end, days, workouts, summary: summarize(days, workouts), prior_4wk: priorWindow(prior) };
}
