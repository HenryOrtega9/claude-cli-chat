/* The generated vault note: <vault>/Health/Metrics/Apple Health Feed.md.

   It is a SUMMARY, never a dump: the last 30 days of derived metrics plus a
   coverage table, all computed by derive.ts. Raw samples stay in SQLite
   outside the vault (see store.ts for why).

   Regeneration is throttled to at most once per 60 s: a first-run backfill
   lands hundreds of batches back to back, and rewriting an iCloud-synced
   file for each one would be pure churn. The write is atomic (temp file in
   the same directory, then rename) so Obsidian and iCloud never see a torn
   file, and it runs on a timer after the ingest response has gone out, so a
   slow or failing write can never delay or fail an ingest. */

import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { addDays, localToday, wallClock } from "./dates";
import {
  bodyComposition, dailyCells, DAILY_COLUMNS, dailyMetrics, fmt, mdTable, sleepNights, workouts,
} from "./derive";
import type { DatabaseSync, SqlValue } from "./sqlite";
import { readStatus } from "./store";

export const NOTE_REL_PATH = "Health/Metrics/Apple Health Feed.md";
export const NOTE_INTERVAL_MS = 60_000;
/* A short settle delay even when the throttle window is open, so the first
   few batches of a burst coalesce into one write. */
const NOTE_SETTLE_MS = 2_000;
const WINDOW_DAYS = 30;

function shortType(type: string): string {
  if (type === "HKWorkoutTypeIdentifier") return "Workout";
  return type.replace(/^HK(?:Quantity|Category|Correlation|DataType)TypeIdentifier/, "") || type;
}

function localStamp(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const local = wallClock(ms) ?? iso;
  return `${local.slice(0, 10)} ${local.slice(11, 16)}`;
}

function parseJson(v: SqlValue | undefined): Record<string, unknown> | null {
  if (typeof v !== "string") return null;
  try {
    const parsed = JSON.parse(v) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function renderHealthNote(db: DatabaseSync, opts: { dbPath: string; now?: Date }): string {
  const now = opts.now ?? new Date();
  const today = localToday(now);
  const from = addDays(today, -(WINDOW_DAYS - 1));
  const status = readStatus(db, opts.dbPath);
  const lastLog = db.prepare("SELECT device FROM ingest_log ORDER BY id DESC LIMIT 1").get();
  const device = parseJson(lastLog?.device);

  const days = dailyMetrics(db, from, today);
  const body = bodyComposition(db, from, today);
  const sleep = sleepNights(db, addDays(today, -WINDOW_DAYS), addDays(today, -1));
  const sessions = workouts(db, from, today);

  const out: string[] = [];
  out.push(
    "---",
    `title: "Apple Health Feed"`,
    "type: health-note",
    `updated: ${today}`,
    "tags: [health, metrics, applehealth]",
    "---",
    "",
    "# Apple Health Feed",
    "",
    "> [!info] Generated note",
    "> The Vault Gateway daemon on the Mac mini writes this file from the iPhone's Apple Health sync, and every sync overwrites it, so edits made here will be lost. Raw samples live in SQLite outside the vault; use the `apple-health` CLI below for anything this summary leaves out.",
    "",
    "## Last Sync",
    "",
  );
  const lastBatch = status.lastBatch;
  out.push(`- **Last ingest:** ${localStamp(status.lastIngestAt)}${lastBatch ? ` (${lastBatch.samples} samples, ${lastBatch.deleted} deleted, ${lastBatch.daily} daily rows)` : ""}`);
  if (device) {
    const name = typeof device.name === "string" ? device.name : "unknown device";
    const detail = [device.model, device.systemVersion ? `iOS ${String(device.systemVersion)}` : null, device.timeZone]
      .filter(v => typeof v === "string" && v).join(", ");
    out.push(`- **Device:** ${name}${detail ? ` (${detail})` : ""}`);
  }
  out.push(`- **Stored:** ${status.samples} samples across ${status.types.length} types, ${status.daily} daily stat rows`);
  out.push(`- **Generated:** ${localStamp(now.toISOString())}`);

  out.push("", `## Daily Metrics (last ${WINDOW_DAYS} days)`, "");
  out.push(mdTable(DAILY_COLUMNS, days.map(dailyCells)));

  out.push("", `## Body Composition (last ${WINDOW_DAYS} days)`, "");
  out.push(body.length
    ? mdTable(["Date", "Weight (lbs)", "Body Fat (%)", "Lean Mass (lbs)"],
      body.map(b => [b.date, fmt(b.weightLb, 1), fmt(b.bodyFatPct, 1), fmt(b.leanMassLb, 1)]))
    : "No body composition samples in this window.");

  out.push("", `## Sleep (last ${WINDOW_DAYS} nights)`, "");
  out.push("Night Of is the date the sleep started on. Each night counts one source only (the one with the most staged sleep) so the iPhone and the Watch are not double counted.", "");
  out.push(sleep.length
    ? mdTable(["Night Of", "Total Sleep (hrs)", "Deep (hrs)", "REM (hrs)", "Core (hrs)", "Source"],
      sleep.map(s => [s.night, fmt(s.totalHrs, 2), fmt(s.deepHrs, 2), fmt(s.remHrs, 2), fmt(s.coreHrs, 2), s.source]))
    : "No sleep samples in this window.");

  out.push("", `## Workouts (last ${WINDOW_DAYS} days)`, "");
  out.push(sessions.length
    ? mdTable(["Date", "Type", "Duration (min)", "Calories", "Distance (mi)", "Avg Pace", "Avg HR (bpm)", "Max HR (bpm)"],
      sessions.map(w => [w.date, w.type, fmt(w.durationMin, 1), fmt(w.calories, 0), fmt(w.distanceMi, 2),
        w.avgPace ?? "", fmt(w.avgHr, 0), fmt(w.maxHr, 0)]))
    : "No workouts in this window.");

  out.push("", "## Data Coverage", "");
  out.push(status.types.length
    ? mdTable(["Type", "Kind", "Count", "First", "Last"],
      status.types.map(t => [shortType(t.type), t.kind, String(t.count), localStamp(t.first).slice(0, 10), localStamp(t.last).slice(0, 10)]))
    : "No samples stored yet.");

  out.push(
    "",
    "## How to Query More",
    "",
    "Any Claude session on the Mac mini can read the full history through the read-only `apple-health` CLI:",
    "",
    "```sh",
    "apple-health status                                   # totals, last batch, per-type coverage",
    "apple-health daily --from 2026-09-01 --format csv     # daily metrics (default: last 14 days, md)",
    "apple-health weekly-csv --week-of 2026-09-21          # the Weekly Health Log export, Monday to Sunday",
    "apple-health samples --type HeartRate --limit 50      # raw samples for one type (id or suffix)",
    "apple-health sql \"SELECT type, COUNT(*) FROM samples GROUP BY type\"",
    "```",
    "",
    "## Tags",
    "",
    "`#health` `#metrics` `#applehealth`",
    "",
  );
  return out.join("\n");
}

/* Temp file in the same directory, then rename: atomic on APFS, and the
   leading dot keeps Obsidian from indexing the temp file in the meantime. */
export async function writeNoteAtomic(vault: string, content: string): Promise<string> {
  const target = join(vault, NOTE_REL_PATH);
  await fs.mkdir(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.apple-health-feed.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await fs.writeFile(tmp, content, "utf8");
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  return target;
}

export type NoteWriterOptions = {
  vault: string;
  dbPath: string;
  db: () => DatabaseSync;
  log: (msg: string) => void;
  intervalMs?: number;
};

export class HealthNoteWriter {
  private timer: NodeJS.Timeout | null = null;
  private lastRunAt = 0;
  private running: Promise<void> | null = null;

  constructor(private readonly opts: NoteWriterOptions) {}

  /* Called after every successful ingest. Never throws. */
  schedule(): void {
    if (this.timer) return;
    const interval = this.opts.intervalMs ?? NOTE_INTERVAL_MS;
    const delay = Math.max(NOTE_SETTLE_MS, this.lastRunAt + interval - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
    this.timer.unref();
  }

  /* Regenerate now. Errors are logged, never thrown. */
  async flush(): Promise<void> {
    if (this.running) return this.running;
    this.lastRunAt = Date.now();
    this.running = (async () => {
      try {
        const content = renderHealthNote(this.opts.db(), { dbPath: this.opts.dbPath });
        const target = await writeNoteAtomic(this.opts.vault, content);
        this.opts.log(`apple-health note written: ${target}`);
      } catch (err) {
        this.opts.log(`apple-health note failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  dispose(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }
}
