/* Derived metrics, shared by the vault note and the CLI so the two can never
   disagree. Contract: docs/ios-gateway/APPLE-HEALTH.md § Derived metrics.

   - Totals come from daily_stats (HKStatisticsCollectionQuery on the phone,
     where HealthKit has already merged the iPhone and Watch sources). Raw
     cumulative samples are never summed here: summing them double counts
     every minute both devices were recording.
   - Sleep is the one place raw samples are aggregated, so it applies the
     single-source rule: per night, only the source with the most staged
     sleep counts. */

import { addDays, dateRange, mondayOf } from "./dates";
import type { DatabaseSync, Row, SqlValue } from "./sqlite";
import type { WorkoutInfo } from "./store";

export const HK = {
  basal: "HKQuantityTypeIdentifierBasalEnergyBurned",
  active: "HKQuantityTypeIdentifierActiveEnergyBurned",
  restingHr: "HKQuantityTypeIdentifierRestingHeartRate",
  hrv: "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
  heartRate: "HKQuantityTypeIdentifierHeartRate",
  vo2Max: "HKQuantityTypeIdentifierVO2Max",
  steps: "HKQuantityTypeIdentifierStepCount",
  exercise: "HKQuantityTypeIdentifierAppleExerciseTime",
  bodyMass: "HKQuantityTypeIdentifierBodyMass",
  bodyFat: "HKQuantityTypeIdentifierBodyFatPercentage",
  leanMass: "HKQuantityTypeIdentifierLeanBodyMass",
  sleep: "HKCategoryTypeIdentifierSleepAnalysis",
} as const;

export type DailyRow = {
  date: string;
  restingEnergy: number | null;
  activeEnergy: number | null;
  totalEnergy: number | null;
  restingHr: number | null;
  hrv: number | null;
  maxHr: number | null;
  vo2Max: number | null;
  steps: number | null;
  exerciseMin: number | null;
};

export type BodyCompRow = { date: string; weightLb: number | null; bodyFatPct: number | null; leanMassLb: number | null };

export type SleepRow = {
  night: string;
  totalHrs: number;
  deepHrs: number;
  remHrs: number;
  coreHrs: number;
  unspecifiedHrs: number;
  source: string;
};

export type WorkoutRow = {
  date: string;
  time: string;
  type: string;
  activityType: number | null;
  activityName: string | null;
  durationMin: number;
  calories: number | null;
  distanceMi: number | null;
  avgPace: string | null;
  avgHr: number | null;
  maxHr: number | null;
};

function n(v: SqlValue | undefined): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return null;
}

function s(v: SqlValue | undefined): string | null {
  return typeof v === "string" ? v : null;
}

/* ---------- daily ---------- */

/* One row per calendar day in [from, to], including days with no data (the
   weekly export wants every day, blank where empty). */
export function dailyMetrics(db: DatabaseSync, from: string, to: string): DailyRow[] {
  const wanted = [HK.basal, HK.active, HK.restingHr, HK.hrv, HK.heartRate, HK.steps, HK.exercise];
  const rows = db.prepare(
    `SELECT date, type, sum, avg, max FROM daily_stats WHERE date BETWEEN ? AND ? AND type IN (${wanted.map(() => "?").join(", ")})`,
  ).all(from, to, ...wanted);
  const byDay = new Map<string, Map<string, Row>>();
  for (const r of rows) {
    const day = s(r.date) ?? "";
    if (!byDay.has(day)) byDay.set(day, new Map());
    byDay.get(day)!.set(s(r.type) ?? "", r);
  }

  /* VO2 max is sparse (a few readings a month), so carry the most recent
     reading on or before each day forward. */
  const vo2 = db.prepare(
    "SELECT local_date, value FROM samples WHERE type = ? AND local_date <= ? AND value IS NOT NULL ORDER BY start_ms",
  ).all(HK.vo2Max, to).map(r => ({ date: s(r.local_date) ?? "", value: n(r.value) }));

  let vo2Index = 0;
  let vo2Latest: number | null = null;
  return dateRange(from, to).map(date => {
    while (vo2Index < vo2.length && vo2[vo2Index].date <= date) vo2Latest = vo2[vo2Index++].value;
    const day = byDay.get(date);
    const get = (type: string, field: "sum" | "avg" | "max") => n(day?.get(type)?.[field]);
    const restingEnergy = get(HK.basal, "sum");
    const activeEnergy = get(HK.active, "sum");
    return {
      date,
      restingEnergy,
      activeEnergy,
      /* Total Energy = Resting + Active, and only when both exist: a day with
         only one of them would print a "total" that is really a part. */
      totalEnergy: restingEnergy !== null && activeEnergy !== null ? restingEnergy + activeEnergy : null,
      restingHr: get(HK.restingHr, "avg"),
      hrv: get(HK.hrv, "avg"),
      maxHr: get(HK.heartRate, "max"),
      vo2Max: vo2Latest,
      steps: get(HK.steps, "sum"),
      exerciseMin: get(HK.exercise, "sum"),
    };
  });
}

/* ---------- body composition ---------- */

/* HealthKit percentages arrive as fractions (0.18 = 18%). A value above 1
   cannot be a body-fat fraction, so it is taken as already being a percent
   rather than displayed as 1800%. */
export function bodyFatPercent(value: number): number {
  return value <= 1 ? value * 100 : value;
}

export function bodyComposition(db: DatabaseSync, from: string, to: string): BodyCompRow[] {
  const rows = db.prepare(
    "SELECT local_date, type, value FROM samples WHERE type IN (?, ?, ?) AND local_date BETWEEN ? AND ? AND value IS NOT NULL ORDER BY start_ms",
  ).all(HK.bodyMass, HK.bodyFat, HK.leanMass, from, to);
  const byDay = new Map<string, BodyCompRow>();
  for (const r of rows) {
    const date = s(r.local_date) ?? "";
    const value = n(r.value);
    if (value === null) continue;
    const row = byDay.get(date) ?? { date, weightLb: null, bodyFatPct: null, leanMassLb: null };
    /* Rows arrive in time order, so the last write per field is that day's latest. */
    if (r.type === HK.bodyMass) row.weightLb = value;
    else if (r.type === HK.bodyFat) row.bodyFatPct = bodyFatPercent(value);
    else if (r.type === HK.leanMass) row.leanMassLb = value;
    byDay.set(date, row);
  }
  return Array.from(byDay.values()).sort((a, b) => a.date.localeCompare(b.date));
}

/* ---------- sleep ---------- */

type Stage = "core" | "deep" | "rem" | "unspecified";

/* HKCategoryValueSleepAnalysis: 0 inBed, 1 asleepUnspecified, 2 awake,
   3 asleepCore, 4 asleepDeep, 5 asleepREM. The raw value wins; the label is
   the fallback for a client that only sent the label. */
function sleepStage(category: number | null, label: string | null): Stage | null {
  switch (category) {
    case 1: return "unspecified";
    case 3: return "core";
    case 4: return "deep";
    case 5: return "rem";
    case 0: case 2: return null;
  }
  switch (label) {
    case "asleepUnspecified": case "asleep": return "unspecified";
    case "asleepCore": return "core";
    case "asleepDeep": return "deep";
    case "asleepREM": return "rem";
  }
  return null;
}

/* Night Of = the local date the sleep started on; anything starting before
   12:00 local belongs to the previous date's night. */
export function nightOf(startLocal: string): string {
  const date = startLocal.slice(0, 10);
  return Number(startLocal.slice(11, 13)) < 12 ? addDays(date, -1) : date;
}

type SourceTotals = Record<Stage, number> & { key: string; name: string };

export function sleepNights(db: DatabaseSync, from: string, to: string): SleepRow[] {
  /* A sample that starts on the morning of `to + 1` still belongs to night `to`. */
  const rows = db.prepare(
    "SELECT start_ms, end_ms, start_local, category, category_label, source_name, source_bundle_id FROM samples WHERE type = ? AND local_date BETWEEN ? AND ?",
  ).all(HK.sleep, from, addDays(to, 1));

  const nights = new Map<string, Map<string, SourceTotals>>();
  for (const r of rows) {
    const stage = sleepStage(n(r.category), s(r.category_label));
    if (!stage) continue;
    const night = nightOf(s(r.start_local) ?? "");
    if (night < from || night > to) continue;
    const durMs = Math.max(0, (n(r.end_ms) ?? 0) - (n(r.start_ms) ?? 0));
    const name = s(r.source_name) ?? "";
    const key = `${s(r.source_bundle_id) ?? ""}|${name}`;
    if (!nights.has(night)) nights.set(night, new Map());
    const sources = nights.get(night)!;
    const totals = sources.get(key) ?? { key, name, core: 0, deep: 0, rem: 0, unspecified: 0 };
    totals[stage] += durMs;
    sources.set(key, totals);
  }

  const out: SleepRow[] = [];
  for (const [night, sources] of nights) {
    const staged = (t: SourceTotals) => t.core + t.deep + t.rem;
    const total = (t: SourceTotals) => staged(t) + t.unspecified;
    /* Single-source rule: most staged time wins; ties (including the
       no-stages-anywhere case of an iPhone-only night) go to the most total
       sleep, then to the source key so the choice is deterministic. */
    const best = Array.from(sources.values()).sort((a, b) =>
      staged(b) - staged(a) || total(b) - total(a) || a.key.localeCompare(b.key))[0];
    if (!best || total(best) <= 0) continue;
    const hrs = (ms: number) => ms / 3_600_000;
    out.push({
      night,
      totalHrs: hrs(total(best)),
      deepHrs: hrs(best.deep),
      remHrs: hrs(best.rem),
      coreHrs: hrs(best.core),
      unspecifiedHrs: hrs(best.unspecified),
      source: best.name,
    });
  }
  return out.sort((a, b) => a.night.localeCompare(b.night));
}

/* ---------- workouts ---------- */

/* "traditionalStrengthTraining" -> "Traditional Strength Training". */
export function workoutLabel(name: string | null, activityType: number | null): string {
  if (!name) return activityType === null ? "Workout" : `Activity ${activityType}`;
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/* Avg Pace = duration / distance, as "m:ss /mi". */
export function formatPace(durationSec: number, distanceMi: number | null): string | null {
  if (distanceMi === null || !(distanceMi > 0) || !(durationSec > 0)) return null;
  const secPerMile = Math.round(durationSec / distanceMi);
  return `${Math.floor(secPerMile / 60)}:${String(secPerMile % 60).padStart(2, "0")} /mi`;
}

export function isRun(w: WorkoutRow): boolean {
  return w.activityType === 37 || w.activityName === "running";
}

export function isLift(w: WorkoutRow): boolean {
  return w.activityType === 50 || w.activityType === 20
    || w.activityName === "traditionalStrengthTraining" || w.activityName === "functionalStrengthTraining";
}

export function workouts(db: DatabaseSync, from: string, to: string): WorkoutRow[] {
  const rows = db.prepare(
    "SELECT local_date, start_local, workout FROM samples WHERE kind = 'workout' AND local_date BETWEEN ? AND ? ORDER BY start_ms",
  ).all(from, to);
  const out: WorkoutRow[] = [];
  for (const r of rows) {
    let w: WorkoutInfo;
    try {
      w = JSON.parse(s(r.workout) ?? "null") as WorkoutInfo;
    } catch {
      continue;
    }
    if (!w) continue;
    out.push({
      date: s(r.local_date) ?? "",
      time: (s(r.start_local) ?? "").slice(11, 16),
      type: workoutLabel(w.activityName, w.activityType),
      activityType: w.activityType,
      activityName: w.activityName,
      durationMin: w.durationSec / 60,
      calories: w.energyKcal,
      distanceMi: w.distanceMi !== null && w.distanceMi > 0 ? w.distanceMi : null,
      avgPace: formatPace(w.durationSec, w.distanceMi),
      avgHr: w.avgHeartRate,
      maxHr: w.maxHeartRate,
    });
  }
  return out;
}

/* ---------- formatting ---------- */

export function fmt(value: number | null | undefined, decimals: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return value.toFixed(decimals);
}

function mean(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;
}

function lastNonNull<T>(rows: T[], pick: (row: T) => number | null): number | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = pick(rows[i]);
    if (v !== null) return v;
  }
  return null;
}

function csvField(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/* The export prompt writes every header line with ", " between columns, and
   the rows follow the same separator so the file reads as one table. */
function csvLine(fields: string[]): string {
  return fields.map(csvField).join(", ");
}

/* ---------- weekly CSV ---------- */

/* Column headers below are copied character for character from the "Weekly
   Export Prompt" in the vault's Health/Metrics/Weekly Health Log.md. The
   only substitution is the literal date range in the DAILY METRICS title. */
export const WEEKLY_HEADERS = {
  daily: "Date, Resting Energy (kcal), Active Energy (kcal), Total Energy (kcal), Resting HR (bpm), HRV (ms), Max HR (bpm), VO2 Max (mL/min/kg)",
  body: "Date, Weight (lbs), Body Fat (%), Lean Mass (lbs)",
  sleep: "Night Of, Total Sleep (hrs), Deep (hrs), REM (hrs), Core (hrs)",
  workouts: "Date, Type, Duration (min), Calories, Distance (mi), Avg Pace, Avg HR (bpm), Max HR (bpm)",
  summary: "Metric, Value",
} as const;

export const WEEKLY_SUMMARY_ROWS = [
  "Avg Resting Energy (kcal/day)",
  "Avg Active Energy (kcal/day)",
  "Avg Resting HR (bpm)",
  "Avg HRV (ms)",
  "Latest VO2 Max (mL/min/kg)",
  "Weight (lbs) [most recent]",
  "Body Fat (%) [most recent]",
  "Lean Mass (lbs) [most recent]",
  "Avg Sleep (hrs)",
  "Total Runs",
  "Total Running Distance (mi)",
  "Total Lifting Sessions",
  "Other Workouts [list type and count]",
] as const;

/* Monday-to-Sunday week containing `date`. */
export function weekBounds(date: string): { start: string; end: string } {
  const start = mondayOf(date);
  return { start, end: addDays(start, 6) };
}

/* The most recent COMPLETED week: the one before the week `today` is in. */
export function lastCompletedWeekOf(today: string): string {
  // Sunday is check-in day, so the week ending today counts as completed.
  const monday = mondayOf(today);
  return addDays(monday, 6) === today ? monday : addDays(monday, -7);
}

export function weeklyCsv(db: DatabaseSync, weekOf: string): string {
  const { start, end } = weekBounds(weekOf);
  const days = dailyMetrics(db, start, end);
  const body = bodyComposition(db, start, end);
  const sleep = sleepNights(db, start, end);
  const sessions = workouts(db, start, end);

  const lines: string[] = [];
  lines.push(`=== DAILY METRICS (${start} to ${end}) ===`, WEEKLY_HEADERS.daily);
  for (const d of days) {
    lines.push(csvLine([d.date, fmt(d.restingEnergy, 0), fmt(d.activeEnergy, 0), fmt(d.totalEnergy, 0),
      fmt(d.restingHr, 0), fmt(d.hrv, 1), fmt(d.maxHr, 0), fmt(d.vo2Max, 1)]));
  }
  lines.push("", "=== BODY COMPOSITION ===", WEEKLY_HEADERS.body);
  for (const b of body) lines.push(csvLine([b.date, fmt(b.weightLb, 1), fmt(b.bodyFatPct, 1), fmt(b.leanMassLb, 1)]));

  lines.push("", "=== SLEEP (Night Of) ===", WEEKLY_HEADERS.sleep);
  for (const s of sleep) lines.push(csvLine([s.night, fmt(s.totalHrs, 2), fmt(s.deepHrs, 2), fmt(s.remHrs, 2), fmt(s.coreHrs, 2)]));

  lines.push("", "=== WORKOUTS ===", WEEKLY_HEADERS.workouts);
  for (const w of sessions) {
    lines.push(csvLine([w.date, w.type, fmt(w.durationMin, 1), fmt(w.calories, 0), fmt(w.distanceMi, 2),
      w.avgPace ?? "", fmt(w.avgHr, 0), fmt(w.maxHr, 0)]));
  }

  const runs = sessions.filter(isRun);
  const lifts = sessions.filter(w => !isRun(w) && isLift(w));
  const otherCounts = new Map<string, number>();
  for (const w of sessions) if (!isRun(w) && !isLift(w)) otherCounts.set(w.type, (otherCounts.get(w.type) ?? 0) + 1);
  const other = Array.from(otherCounts, ([type, count]) => `${type} x${count}`).join("; ") || "None";
  const vo2Latest = lastNonNull(days, d => d.vo2Max);

  const values = [
    fmt(mean(days.map(d => d.restingEnergy)), 0),
    fmt(mean(days.map(d => d.activeEnergy)), 0),
    fmt(mean(days.map(d => d.restingHr)), 1),
    fmt(mean(days.map(d => d.hrv)), 1),
    fmt(vo2Latest, 1),
    fmt(lastNonNull(body, b => b.weightLb), 1),
    fmt(lastNonNull(body, b => b.bodyFatPct), 1),
    fmt(lastNonNull(body, b => b.leanMassLb), 1),
    fmt(mean(sleep.map(s => s.totalHrs)), 2),
    String(runs.length),
    fmt(runs.reduce((a, w) => a + (w.distanceMi ?? 0), 0), 2),
    String(lifts.length),
    other,
  ];
  lines.push("", "=== WEEKLY SUMMARY ===", WEEKLY_HEADERS.summary);
  WEEKLY_SUMMARY_ROWS.forEach((label, i) => lines.push(csvLine([label, values[i]])));
  return `${lines.join("\n")}\n`;
}

/* ---------- markdown tables ---------- */

function mdCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function mdTable(headers: string[], rows: string[][]): string {
  const out = [`| ${headers.map(mdCell).join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`];
  for (const row of rows) out.push(`| ${row.map(mdCell).join(" | ")} |`);
  return out.join("\n");
}

/* Daily table used by both the note and `apple-health daily`: the weekly CSV
   columns plus Steps and Exercise min. */
export const DAILY_COLUMNS = [
  "Date", "Resting Energy (kcal)", "Active Energy (kcal)", "Total Energy (kcal)", "Resting HR (bpm)",
  "HRV (ms)", "Max HR (bpm)", "VO2 Max (mL/min/kg)", "Steps", "Exercise (min)",
];

export function dailyCells(d: DailyRow): string[] {
  return [d.date, fmt(d.restingEnergy, 0), fmt(d.activeEnergy, 0), fmt(d.totalEnergy, 0), fmt(d.restingHr, 0),
    fmt(d.hrv, 1), fmt(d.maxHr, 0), fmt(d.vo2Max, 1), fmt(d.steps, 0), fmt(d.exerciseMin, 0)];
}

export function plainCsv(headers: string[], rows: string[][]): string {
  return `${[headers, ...rows].map(r => r.map(csvField).join(",")).join("\n")}\n`;
}
