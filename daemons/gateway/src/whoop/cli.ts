/* `whoop`: read-only access to the WHOOP history store for any Claude session
   on the Mac mini, and the data source of the weekly health review and the
   WHOOP MCP server. The JSON shapes are a contract; see history.ts and the
   README's WHOOP section.

   Bundled by daemons/gateway/build.mjs to dist/whoop.js and symlinked into
   ~/.local/bin. Every read opens the database with readOnly, so nothing here
   can modify it, `sql` included; `sql` additionally refuses anything that is
   not a SELECT or WITH query, to fail with a clear message instead of a
   SQLite error. The one command that changes anything, `backfill`, does it
   by asking the running daemon (POST /whoop/backfill with the main token),
   which owns the WHOOP tokens and the request budget. */

import { existsSync, readFileSync } from "node:fs";

import { gatewayTokenPath, localGatewayUrl, whoopCachePath, whoopDbPath } from "../config";
import { addDays, daySpan, isIsoDate, localToday, sundayOf, wallClock } from "../apple-health/dates";
import { jsonableRow, openDatabase, readQueryProblem, type DatabaseSync } from "../apple-health/sqlite";
import { dailyRows, weekView, workoutRows, type DailyRow, type WeekView, type WorkoutRow } from "./history";
import { readWhoopCache } from "./service";
import { BACKFILL_ORDER, readStoreStatus, type WhoopStoreStatus } from "./store";

const USAGE = `whoop: read-only queries over the WHOOP history store

Usage:
  whoop status [--json]
      record counts, the days covered, backfill progress, the last poll
  whoop daily [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]
      one row per day, inclusive, days with no data included (default: the
      last 14 days)
  whoop workouts [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]
      every workout whose day is in the range (default: the last 14 days)
  whoop week [--week-of YYYY-MM-DD] [--json]
      the Sunday-to-Saturday week containing the date, its summary, and the
      28 days before it as a baseline (default: the last completed week)
  whoop sql "<SELECT ...>"
      read-only connection, SELECT and WITH only; JSON rows
  whoop backfill [--json]
      ask the running gateway to page through the whole WHOOP history again

A cycle's day is the local date of its start plus 12 hours (bed at 23:10
Thursday and at 00:40 Friday are both Friday); sleeps and workouts take the
day of their cycle.
Tables: cycles, recoveries, sleeps, workouts, backfill, meta, schema_version
("end" is a keyword: quote it).
Database: $VAULT_GATEWAY_WHOOP_DB or ~/Library/Application Support/vault-gateway/whoop.sqlite`;

class CliError extends Error {}

type Args = { command: string; positional: string[]; flags: Map<string, string> };

const VALUE_FLAGS = new Set(["from", "to", "week-of"]);
const BOOL_FLAGS = new Set(["json"]);
const MAX_RANGE_DAYS = 3660;
const GATEWAY_TIMEOUT_MS = 10_000;

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") { flags.set("help", "1"); continue; }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      if (BOOL_FLAGS.has(name) && eq < 0) { flags.set(name, "1"); continue; }
      if (!VALUE_FLAGS.has(name)) throw new CliError(`unknown option --${name}`);
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new CliError(`--${name} needs a value`);
      flags.set(name, value);
      continue;
    }
    positional.push(arg);
  }
  return { command: positional.shift() ?? "", positional, flags };
}

function dateFlag(args: Args, name: string, fallback: string): string {
  const v = args.flags.get(name);
  if (v === undefined) return fallback;
  if (!isIsoDate(v)) throw new CliError(`--${name} must be a YYYY-MM-DD date (got "${v}")`);
  return v;
}

function rangeFlags(args: Args): { from: string; to: string } {
  const to = dateFlag(args, "to", localToday());
  const from = dateFlag(args, "from", addDays(to, -13));
  if (from > to) throw new CliError("--from is after --to");
  if (daySpan(from, to) > MAX_RANGE_DAYS) throw new CliError(`--from/--to may span at most ${MAX_RANGE_DAYS} days`);
  return { from, to };
}

function openReadOnly(path: string): DatabaseSync {
  if (!existsSync(path)) {
    throw new CliError(
      `no WHOOP history yet: run whoop-auth, then wait for the first poll.\n`
      + `(looked for ${path}; set VAULT_GATEWAY_WHOOP_DB to read a database somewhere else)`,
    );
  }
  try {
    const db = openDatabase(path, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    return db;
  } catch (err) {
    throw new CliError(`could not open ${path} read-only: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/* ---------- text rendering ---------- */

function cell(v: unknown): string {
  if (v === null || v === undefined) return "-";
  return String(v);
}

/* A plain fixed-width table: numbers right-aligned, text left. */
function table(headers: string[], rows: unknown[][]): string {
  const cells = rows.map(r => r.map(cell));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map(r => r[i].length)));
  const numeric = headers.map((_, i) => rows.length > 0 && rows.every(r => r[i] === null || typeof r[i] === "number"));
  const line = (r: string[]) => r.map((c, i) => (numeric[i] ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join("  ").trimEnd();
  return [line(headers), line(widths.map(w => "-".repeat(w))), ...cells.map(line)].join("\n");
}

function dailyTable(rows: DailyRow[]): string {
  return table(
    ["day", "rec", "band", "hrv", "rhr", "strain", "kcal", "sleep h", "need h", "perf", "eff", "naps h", "wo"],
    rows.map(d => [d.day, d.recovery, d.band, d.hrv_ms, d.rhr_bpm, d.strain, d.kcal, d.sleep_hours, d.sleep_need_hours,
      d.sleep_performance_pct, d.sleep_efficiency_pct, d.nap_hours, d.workouts]),
  );
}

function workoutTable(rows: WorkoutRow[]): string {
  if (rows.length === 0) return "(no workouts)";
  return table(
    ["day", "start", "sport", "min", "strain", "kcal", "avg hr", "max hr", "km", "z0-z5 min"],
    /* Local start time on this Mac; the JSON keeps WHOOP's own timestamps. */
    rows.map(w => [w.day, wallClock(Date.parse(w.start))?.slice(11, 16) ?? w.start, w.sport, w.duration_min, w.strain, w.kcal, w.avg_hr_bpm, w.max_hr_bpm,
      w.distance_km, w.zones_min ? w.zones_min.join("/") : null]),
  );
}

function weekText(w: WeekView): string {
  const s = w.summary;
  const p = w.prior_4wk;
  const v = (x: number | null, unit = "") => (x === null ? "-" : `${x}${unit}`);
  return [
    `WHOOP week ${w.week_start} (Sun) to ${w.week_end} (Sat)`,
    "",
    dailyTable(w.days),
    "",
    `Recovery: avg ${v(s.recovery_avg)} (min ${v(s.recovery_min)}, max ${v(s.recovery_max)}) over ${s.days_with_recovery} day(s); `
      + `${s.band_counts.green} green, ${s.band_counts.yellow} yellow, ${s.band_counts.red} red`,
    `HRV avg ${v(s.hrv_avg_ms, " ms")} | RHR avg ${v(s.rhr_avg_bpm, " bpm")} | Strain avg ${v(s.strain_avg)}, total ${v(s.strain_total)}`,
    `Sleep avg ${v(s.sleep_hours_avg, " h")} of ${v(s.sleep_need_hours_avg, " h")} needed, performance ${v(s.sleep_performance_avg, "%")}`,
    `Workouts: ${s.workout_count}; zone minutes z0..z5: ${s.zone_minutes.join(" / ")}`,
    `Prior 4 weeks: recovery ${v(p.recovery_avg)}, HRV ${v(p.hrv_avg_ms, " ms")}, RHR ${v(p.rhr_avg_bpm, " bpm")}, `
      + `strain ${v(p.strain_avg)}, sleep ${v(p.sleep_hours_avg, " h")}`,
    "",
    workoutTable(w.workouts),
    "",
  ].join("\n");
}

/* ---------- status ---------- */

type StatusOut = {
  db_path: string;
  schema_version: number;
  counts: WhoopStoreStatus["counts"];
  oldest_day: string | null;
  newest_day: string | null;
  last_poll_at: string | null;
  last_poll_write_at: string | null;
  backfill: WhoopStoreStatus["backfill"];
};

function readStatusOut(dbPath: string): StatusOut {
  const db = openReadOnly(dbPath);
  try {
    const s = readStoreStatus(db, dbPath);
    const cache = readWhoopCache(whoopCachePath());
    return {
      db_path: s.db_path,
      schema_version: s.schema_version,
      counts: s.counts,
      oldest_day: s.oldest_day,
      newest_day: s.newest_day,
      last_poll_at: cache ? new Date(cache.fetchedAt).toISOString() : null,
      last_poll_write_at: s.last_poll_write_at,
      backfill: s.backfill,
    };
  } finally {
    db.close();
  }
}

function statusText(s: StatusOut): string {
  const c = s.counts;
  const lines = [
    `WHOOP history: ${s.db_path} (schema ${s.schema_version})`,
    `Records: ${c.cycles} cycles, ${c.recoveries} recoveries, ${c.sleeps} sleeps, ${c.workouts} workouts`,
    `Days: ${s.oldest_day ?? "-"} to ${s.newest_day ?? "-"}`,
    `Last poll: ${s.last_poll_at ?? "-"} (history written ${s.last_poll_write_at ?? "-"})`,
    `Backfill: ${s.backfill.state.replace("_", " ")}${s.backfill.completed_at ? `, ${s.backfill.completed_at}` : ""}`,
  ];
  for (const name of BACKFILL_ORDER) {
    const b = s.backfill.collections[name];
    lines.push(`  ${name.padEnd(8)} ${b.state.replace("_", " ").padEnd(11)} ${String(b.pages).padStart(4)} page(s) ${String(b.records).padStart(6)} record(s)`
      + `${b.last_error ? `  last error: ${b.last_error}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

/* ---------- backfill ---------- */

async function requestBackfill(): Promise<{ backfill: string; running: boolean }> {
  let token: string;
  try {
    token = readFileSync(gatewayTokenPath(), "utf8").trim();
  } catch {
    throw new CliError(`no gateway token at ${gatewayTokenPath()}; is the vault gateway installed on this machine?`);
  }
  const base = localGatewayUrl();
  let res: Response;
  try {
    res = await fetch(`${base}/whoop/backfill`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CliError(`the gateway at ${base} did not answer (${err instanceof Error ? err.message : String(err)})`);
  }
  const body = await res.json().catch(() => null) as { backfill?: string; running?: boolean; error?: string; auth?: string; message?: string } | null;
  if (res.status === 200 && body?.backfill) return { backfill: body.backfill, running: body.running === true };
  if (res.status === 404) throw new CliError(`the gateway at ${base} has no /whoop/backfill route yet; rebuild and restart it`);
  if (res.status === 409) throw new CliError(`WHOOP is not connected (auth ${body?.auth ?? "?"}): run whoop-auth first`);
  throw new CliError(`the gateway answered HTTP ${res.status}${body?.error ? ` (${body.error}${body.message ? `: ${body.message}` : ""})` : ""}`);
}

/* ---------- commands ---------- */

async function run(argv: string[]): Promise<string> {
  const args = parseArgs(argv);
  if (args.flags.has("help") || !args.command || args.command === "help") return `${USAGE}\n`;
  const asJson = args.flags.has("json");
  const dbPath = whoopDbPath();

  switch (args.command) {
    case "status": {
      const s = readStatusOut(dbPath);
      return asJson ? json(s) : statusText(s);
    }
    case "daily": {
      const { from, to } = rangeFlags(args);
      const db = openReadOnly(dbPath);
      const rows = dailyRows(db, from, to);
      return asJson ? json(rows) : `${dailyTable(rows)}\n`;
    }
    case "workouts": {
      const { from, to } = rangeFlags(args);
      const db = openReadOnly(dbPath);
      const rows = workoutRows(db, from, to);
      return asJson ? json(rows) : `${workoutTable(rows)}\n`;
    }
    case "week": {
      /* Default: the last completed week, the one ending on the last
         Saturday before today (run on a Sunday, the week ending yesterday). */
      const weekOf = dateFlag(args, "week-of", addDays(sundayOf(localToday()), -7));
      const db = openReadOnly(dbPath);
      const view = weekView(db, weekOf);
      return asJson ? json(view) : weekText(view);
    }
    case "sql": {
      const query = args.positional.join(" ").trim();
      if (!query) throw new CliError("sql: pass the query as one argument, e.g. whoop sql \"SELECT COUNT(*) FROM cycles\"");
      const problem = readQueryProblem(query);
      if (problem) throw new CliError(`sql: ${problem}`);
      const db = openReadOnly(dbPath);
      try {
        return json(db.prepare(query).all().map(jsonableRow));
      } catch (err) {
        throw new CliError(`sql: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    case "backfill": {
      const answer = await requestBackfill();
      const status = readStatusOut(dbPath);
      if (asJson) return json({ ...answer, status });
      return `Backfill ${answer.backfill} in the gateway; progress so far (re-run \`whoop status\` to follow):\n\n${statusText(status)}`;
    }
    default:
      throw new CliError(`unknown command "${args.command}"\n\n${USAGE}`);
  }
}

run(process.argv.slice(2)).then(out => { process.stdout.write(out); }, (err: unknown) => {
  const message = err instanceof CliError ? err.message : (err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.stderr.write(`whoop: ${message}\n`);
  process.exitCode = 1;
});
