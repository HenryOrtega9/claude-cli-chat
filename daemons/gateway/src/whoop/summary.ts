/* GET /whoop/summary's body, built from the raw WHOOP records. Pure: no I/O,
   no clock but the `now` it is handed, so the tests drive it directly.

   Shape rules the watch decodes against:
   - recovery, strain, sleep and strain_today are ALWAYS objects (fields null
     when there is nothing to show); only workout may be null;
   - week and workouts_today are ALWAYS arrays, oldest first, [] when empty;
   - every `state` is scored | pending | unscorable | missing, mapped from
     WHOOP's score_state, with "missing" for no record at all.

   "Today" is the newest cycle. Its recovery only exists once the sleep that
   opened it has been scored, so in the early morning (and all day for a
   cycle WHOOP could not score) the newest recovery is pending or absent; the
   previous cycle's recovery is shown instead, flagged is_current_cycle:false.
   Strain and sleep always describe the newest cycle.

   History for the complications: `week` is the last 7 cycles from the cycle
   and recovery collections, `workouts_today` the workouts since the newest
   cycle began, and `strain_today` the intraday strain steps the service
   records poll by poll (WHOOP keeps no such series; see advanceStrainSeries). */

import type { ScoreState, WhoopCycle, WhoopRecovery, WhoopSleep, WhoopWorkout } from "./api";

export type WhoopRaw = {
  cycle: WhoopCycle | null;
  previousCycle: WhoopCycle | null;
  recovery: WhoopRecovery | null;
  /* Only fetched when `recovery` is missing or pending. */
  previousRecovery: WhoopRecovery | null;
  sleep: WhoopSleep | null;
  workout: WhoopWorkout | null;
  /* The collections behind the history fields, newest first: up to 8 cycles
     (cycles[0] is `cycle`), up to 8 recoveries, up to 10 workouts (workouts[0]
     is `workout`). Optional because caches written before they existed lack
     them; absent reads as []. */
  cycles?: WhoopCycle[];
  recoveries?: WhoopRecovery[];
  workouts?: WhoopWorkout[];
};

export type StrainPoint = { t: string; strain: number };
/* The intraday strain steps of one cycle, kept by the service. */
export type StrainSeries = { cycle_id: number; points: StrainPoint[] };

export type AuthState = "ok" | "not_configured" | "reauth_required" | "error";
export type RecordState = "scored" | "pending" | "unscorable" | "missing";
export type Band = "green" | "yellow" | "red";

export type WeekDay = {
  cycle_start: string;
  day: string;
  recovery: number | null;
  band: Band | null;
  strain: number | null;
};

export type WorkoutToday = { sport: string; start: string; end: string; strain: number | null };

export type SummaryMeta = {
  auth: AuthState;
  fetchedAt: number | null;
  /* False when the most recent poll attempt failed. */
  lastPollOk: boolean;
  nextPollAt: number | null;
  lastError: string | null;
};

export type WhoopSummary = {
  schema: 1;
  auth: AuthState;
  stale: boolean;
  fetched_at: string | null;
  updated_at: string | null;
  next_poll_at: string | null;
  last_error: string | null;
  recovery: {
    state: RecordState;
    is_current_cycle: boolean;
    score: number | null;
    band: Band | null;
    hrv_ms: number | null;
    rhr_bpm: number | null;
    spo2_pct: number | null;
    skin_temp_c: number | null;
    calibrating: boolean;
    updated_at: string | null;
  };
  strain: {
    state: RecordState;
    day_strain: number | null;
    kilojoule: number | null;
    kcal: number | null;
    avg_hr_bpm: number | null;
    max_hr_bpm: number | null;
    cycle_start: string | null;
    cycle_end: string | null;
  };
  sleep: {
    state: RecordState;
    performance_pct: number | null;
    hours_slept: number | null;
    hours_needed: number | null;
    hours_in_bed: number | null;
    efficiency_pct: number | null;
    consistency_pct: number | null;
    respiratory_rate: number | null;
    stages: { light_h: number; sws_h: number; rem_h: number; awake_h: number } | null;
    disturbances: number | null;
    start: string | null;
    end: string | null;
  };
  workout: {
    state: RecordState;
    sport: string;
    strain: number | null;
    kcal: number | null;
    avg_hr_bpm: number | null;
    max_hr_bpm: number | null;
    start: string;
    end: string;
  } | null;
  week: WeekDay[];
  strain_today: { cycle_start: string | null; wake: string | null; points: StrainPoint[] };
  workouts_today: WorkoutToday[];
};

/* Past this age the data is stale even when the last poll succeeded. */
export const STALE_AFTER_MS = 45 * 60_000;
/* 5-minute polls fill about 288 a day; a cycle can run past 24 h. */
export const STRAIN_SERIES_CAP = 400;
const WEEK_DAYS = 7;
const MS_PER_HOUR = 3_600_000;
const KJ_PER_KCAL = 4.184;

export function recordState(record: { score_state?: ScoreState } | null | undefined): RecordState {
  if (!record) return "missing";
  switch (record.score_state) {
    case "SCORED": return "scored";
    case "PENDING_SCORE": return "pending";
    case "UNSCORABLE": return "unscorable";
    default: return "missing";
  }
}

/* WHOOP's published bands: green 67-100, yellow 34-66, red 0-33. */
export function band(score: number | null): Band | null {
  if (score === null) return null;
  if (score >= 67) return "green";
  if (score >= 34) return "yellow";
  return "red";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function round(v: unknown, digits = 0): number | null {
  const n = num(v);
  if (n === null) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function hours(...millis: unknown[]): number | null {
  let total = 0;
  let any = false;
  for (const m of millis) {
    const n = num(m);
    if (n === null) continue;
    total += n;
    any = true;
  }
  return any ? round(total / MS_PER_HOUR, 2) : null;
}

export function kcalFromKj(kj: unknown): number | null {
  const n = num(kj);
  return n === null ? null : Math.round(n / KJ_PER_KCAL);
}

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function newest(...stamps: (string | undefined | null)[]): string | null {
  let best: number | null = null;
  for (const s of stamps) {
    const ms = s ? Date.parse(s) : NaN;
    if (Number.isFinite(ms) && (best === null || ms > best)) best = ms;
  }
  return iso(best);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/* The calendar day a cycle belongs to, YYYY-MM-DD in the gateway's timezone.
   A cycle starts when the main sleep does, so a start from noon on counts as
   the next day: bed at 23:10 Thursday opens Friday's cycle, and bed at 00:40
   Friday does too. The plain start date would label the first Thursday and
   could give two cycles the same day. */
export function cycleDay(start: string): string | null {
  const ms = Date.parse(start);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + 12 * MS_PER_HOUR);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/* A cycle's strain as the watch shows it (1 dp), only once WHOOP scored it. */
function cycleStrain(cycle: WhoopCycle | null | undefined): number | null {
  return recordState(cycle) === "scored" ? round(cycle?.score?.strain, 1) : null;
}

/* One poll's step for the intraday strain series: a new cycle id starts a new
   series, and a point (the poll time, the strain) is added only when the
   strain moved since the last point or there is none yet. Oldest points drop
   past STRAIN_SERIES_CAP. Never mutates its input. */
export function advanceStrainSeries(series: StrainSeries | null, cycle: WhoopCycle | null, at: number): StrainSeries | null {
  if (!cycle) return series;
  const base: StrainSeries = series && series.cycle_id === cycle.id ? series : { cycle_id: cycle.id, points: [] };
  const strain = cycleStrain(cycle);
  if (strain === null || base.points.at(-1)?.strain === strain) return base;
  const points = [...base.points, { t: new Date(at).toISOString(), strain }];
  return { cycle_id: cycle.id, points: points.length > STRAIN_SERIES_CAP ? points.slice(-STRAIN_SERIES_CAP) : points };
}

/* True when the newest cycle's recovery cannot be shown yet, which is also
   when the poller fetches the previous cycle's. */
export function needsFallback(recovery: WhoopRecovery | null): boolean {
  const state = recordState(recovery);
  return state === "missing" || state === "pending";
}

function buildWeek(r: WhoopRaw): WeekDay[] {
  const recoveryByCycle = new Map((r.recoveries ?? []).map(x => [x.cycle_id, x]));
  const week: WeekDay[] = [];
  for (const c of (r.cycles ?? []).slice(0, WEEK_DAYS).reverse()) {
    const day = cycleDay(c.start);
    if (day === null) continue;
    const rec = recoveryByCycle.get(c.id);
    const score = recordState(rec) === "scored" ? round(rec?.score?.recovery_score) : null;
    week.push({ cycle_start: c.start, day, recovery: score, band: band(score), strain: cycleStrain(c) });
  }
  return week;
}

function buildWorkoutsToday(r: WhoopRaw): WorkoutToday[] {
  const since = r.cycle ? Date.parse(r.cycle.start) : NaN;
  if (!Number.isFinite(since)) return [];
  return (r.workouts ?? [])
    .filter(w => Date.parse(w.start) >= since)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .map(w => ({
      sport: w.sport_name || "activity",
      start: w.start,
      end: w.end,
      strain: recordState(w) === "scored" ? round(w.score?.strain, 1) : null,
    }));
}

/* `series` is the service's intraday strain record; points only show while
   it belongs to the newest cycle. */
export function buildSummary(raw: WhoopRaw | null, now: Date, meta: SummaryMeta, series: StrainSeries | null = null): WhoopSummary {
  const r = raw ?? { cycle: null, previousCycle: null, recovery: null, previousRecovery: null, sleep: null, workout: null };

  const fallback = needsFallback(r.recovery) && r.previousRecovery !== null;
  const rec = fallback ? r.previousRecovery : r.recovery;
  const recState = recordState(rec);
  const recScore = recState === "scored" ? rec?.score : undefined;
  const score = round(recScore?.recovery_score);

  const cycleState = recordState(r.cycle);
  const cs = cycleState === "scored" ? r.cycle?.score : undefined;

  const sleepState = recordState(r.sleep);
  const ss = sleepState === "scored" ? r.sleep?.score : undefined;
  const st = ss?.stage_summary;
  const need = ss?.sleep_needed;

  const w = r.workout;
  const ws = recordState(w) === "scored" ? w?.score : undefined;

  /* The per-cycle sleep endpoint answers this cycle's main sleep; its end is
     when the day started. */
  const wake = r.cycle && r.sleep && !r.sleep.nap && (r.sleep.cycle_id === undefined || r.sleep.cycle_id === r.cycle.id)
    ? r.sleep.end ?? null
    : null;

  const stale = !meta.lastPollOk || meta.fetchedAt === null || now.getTime() - meta.fetchedAt > STALE_AFTER_MS;

  return {
    schema: 1,
    auth: meta.auth,
    stale,
    fetched_at: iso(meta.fetchedAt),
    updated_at: newest(r.cycle?.updated_at, rec?.updated_at, r.sleep?.updated_at, w?.updated_at),
    next_poll_at: iso(meta.nextPollAt),
    last_error: meta.lastError,
    recovery: {
      state: recState,
      is_current_cycle: !fallback,
      score,
      band: band(score),
      hrv_ms: round(recScore?.hrv_rmssd_milli, 1),
      rhr_bpm: round(recScore?.resting_heart_rate),
      spo2_pct: round(recScore?.spo2_percentage, 1),
      skin_temp_c: round(recScore?.skin_temp_celsius, 2),
      calibrating: recScore?.user_calibrating === true,
      updated_at: rec?.updated_at ?? null,
    },
    strain: {
      state: cycleState,
      day_strain: round(cs?.strain, 1),
      kilojoule: round(cs?.kilojoule, 1),
      kcal: kcalFromKj(cs?.kilojoule),
      avg_hr_bpm: round(cs?.average_heart_rate),
      max_hr_bpm: round(cs?.max_heart_rate),
      cycle_start: r.cycle?.start ?? null,
      cycle_end: r.cycle?.end ?? null,
    },
    sleep: {
      state: sleepState,
      performance_pct: round(ss?.sleep_performance_percentage),
      /* Asleep = light + slow-wave + REM; in-bed time also counts awake. */
      hours_slept: st ? hours(st.total_light_sleep_time_milli, st.total_slow_wave_sleep_time_milli, st.total_rem_sleep_time_milli) : null,
      hours_needed: need
        ? hours(need.baseline_milli, need.need_from_sleep_debt_milli, need.need_from_recent_strain_milli, need.need_from_recent_nap_milli)
        : null,
      hours_in_bed: st ? hours(st.total_in_bed_time_milli) : null,
      efficiency_pct: round(ss?.sleep_efficiency_percentage, 1),
      consistency_pct: round(ss?.sleep_consistency_percentage, 1),
      respiratory_rate: round(ss?.respiratory_rate, 1),
      stages: st
        ? {
          light_h: hours(st.total_light_sleep_time_milli) ?? 0,
          sws_h: hours(st.total_slow_wave_sleep_time_milli) ?? 0,
          rem_h: hours(st.total_rem_sleep_time_milli) ?? 0,
          awake_h: hours(st.total_awake_time_milli) ?? 0,
        }
        : null,
      disturbances: round(st?.disturbance_count),
      start: r.sleep?.start ?? null,
      end: r.sleep?.end ?? null,
    },
    workout: w
      ? {
        state: recordState(w),
        sport: w.sport_name || "activity",
        strain: round(ws?.strain, 1),
        kcal: kcalFromKj(ws?.kilojoule),
        avg_hr_bpm: round(ws?.average_heart_rate),
        max_hr_bpm: round(ws?.max_heart_rate),
        start: w.start,
        end: w.end,
      }
      : null,
    week: buildWeek(r),
    strain_today: {
      cycle_start: r.cycle?.start ?? null,
      wake,
      points: r.cycle && series?.cycle_id === r.cycle.id ? series.points : [],
    },
    workouts_today: buildWorkoutsToday(r),
  };
}

/* One line for whoop-auth and the daemon log, e.g.
   "Recovery 72% (green) | Strain 8.4 | Sleep 7.21 h of 8.05 h needed (88%)". */
export function summaryLine(s: WhoopSummary): string {
  const parts: string[] = [];
  const rec = s.recovery;
  if (rec.state === "scored" && rec.score !== null) {
    parts.push(`Recovery ${rec.score}% (${rec.band})${rec.is_current_cycle ? "" : " from the previous cycle"}`);
  } else {
    parts.push(`Recovery ${rec.state}`);
  }
  parts.push(s.strain.day_strain !== null ? `Strain ${s.strain.day_strain.toFixed(1)}` : `Strain ${s.strain.state}`);
  const sl = s.sleep;
  if (sl.state === "scored" && sl.hours_slept !== null) {
    const needed = sl.hours_needed !== null ? ` of ${sl.hours_needed} h needed` : "";
    const perf = sl.performance_pct !== null ? ` (${sl.performance_pct}%)` : "";
    parts.push(`Sleep ${sl.hours_slept} h${needed}${perf}`);
  } else {
    parts.push(`Sleep ${sl.state}`);
  }
  return parts.join(" | ");
}
