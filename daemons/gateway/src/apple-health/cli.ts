/* `apple-health`: read-only access to the Apple Health store for any Claude
   session on the Mac mini. Contract: docs/ios-gateway/APPLE-HEALTH.md § CLI.

   Bundled by daemons/gateway/build.mjs to dist/apple-health.js and symlinked
   into ~/.local/bin. Every command opens the database with readOnly, so
   nothing here can modify it, `sql` included; `sql` additionally refuses
   anything that is not a SELECT or WITH query, to fail with a clear message
   instead of a SQLite error. */

import { existsSync } from "node:fs";

import { healthDbPath } from "../config";
import { addDays, daySpan, isIsoDate, localToday } from "./dates";
import {
  dailyCells, DAILY_COLUMNS, dailyMetrics, lastCompletedWeek, mdTable, plainCsv, weekBounds, weeklyCsv,
} from "./derive";
import { openDatabase, type DatabaseSync, type Row, type SqlValue } from "./sqlite";
import { readStatus } from "./store";

const USAGE = `apple-health: read-only queries over the Apple Health store

Usage:
  apple-health status
  apple-health daily [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--format md|csv|json]
      default: the last 14 days, md
  apple-health weekly-csv [--week-of YYYY-MM-DD | --from YYYY-MM-DD --to YYYY-MM-DD]
      the Weekly Health Log export for the Sunday-to-Saturday week containing the
      date (default: the most recent completed week, the one ending on the last
      Saturday before today; run on a Sunday, that is the week ending yesterday).
      --from/--to export any inclusive range of up to 31 days instead
  apple-health samples --type <identifier or suffix> [--from D] [--to D] [--limit N] [--format json|csv]
      newest first; --limit defaults to 100 (max 100000)
  apple-health sql "<SELECT ...>" [--format csv|json|md]
      read-only connection; SELECT and WITH only

Tables: samples, daily_stats, characteristics, ingest_log.
Database: $VAULT_GATEWAY_HEALTH_DB or ~/Library/Application Support/vault-gateway/apple-health.sqlite`;

class CliError extends Error {}

type Args = { command: string; positional: string[]; flags: Map<string, string> };

const VALUE_FLAGS = new Set(["from", "to", "format", "week-of", "type", "limit"]);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") { flags.set("help", "1"); continue; }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
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

function formatFlag<T extends string>(args: Args, allowed: readonly T[], fallback: T): T {
  const v = args.flags.get("format") ?? fallback;
  if (!(allowed as readonly string[]).includes(v)) throw new CliError(`--format must be one of ${allowed.join(", ")}`);
  return v as T;
}

function openReadOnly(path: string): DatabaseSync {
  if (!existsSync(path)) {
    throw new CliError(
      `no Apple Health database at ${path} yet.\n`
      + "The gateway daemon creates it on the first /apple-health/ request (turn on Apple Health sync in the iPhone app).\n"
      + "Set VAULT_GATEWAY_HEALTH_DB to read a database somewhere else.",
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

function cell(v: SqlValue | undefined): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  return String(v);
}

function jsonable(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === "bigint" ? Number(v) : v instanceof Uint8Array ? `<${v.length} bytes>` : v;
  return out;
}

function printRows(columns: string[], rows: Row[], format: "csv" | "json" | "md"): string {
  if (format === "json") return `${JSON.stringify(rows.map(jsonable), null, 2)}\n`;
  const cells = rows.map(r => columns.map(c => cell(r[c])));
  return format === "md" ? `${mdTable(columns, cells)}\n` : plainCsv(columns, cells);
}

/* Exact identifier first, then the part after "...TypeIdentifier" (so
   "HeartRate" means HKQuantityTypeIdentifierHeartRate, not RestingHeartRate),
   then a unique substring. Ambiguity is an error that lists the candidates. */
function resolveType(db: DatabaseSync, wanted: string): string {
  const types = db.prepare("SELECT DISTINCT type FROM samples").all().map(r => cell(r.type));
  if (types.includes(wanted)) return wanted;
  const lower = wanted.toLowerCase();
  const bySuffix = types.filter(t => t.replace(/^.*TypeIdentifier/, "").toLowerCase() === lower);
  if (bySuffix.length === 1) return bySuffix[0];
  const partial = types.filter(t => t.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length === 0 && bySuffix.length === 0) {
    throw new CliError(`no samples of a type matching "${wanted}". Run \`apple-health status\` for the stored types.`);
  }
  throw new CliError(`"${wanted}" is ambiguous: ${(bySuffix.length ? bySuffix : partial).join(", ")}`);
}

/* Strip leading comments and whitespace, then demand SELECT or WITH, and a
   single statement (prepare() would silently ignore anything after the first). */
function checkReadQuery(sql: string): void {
  const body = sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, "");
  if (!/^(select|with)\b/i.test(body)) throw new CliError("sql: only SELECT and WITH queries are allowed");
  const unquoted = body.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''");
  if (/;\s*\S/.test(unquoted.replace(/--[^\n]*/g, ""))) throw new CliError("sql: one statement at a time");
}

function run(argv: string[]): string {
  const args = parseArgs(argv);
  if (args.flags.has("help") || !args.command || args.command === "help") return `${USAGE}\n`;
  const dbPath = healthDbPath();

  switch (args.command) {
    case "status": {
      const db = openReadOnly(dbPath);
      return `${JSON.stringify(readStatus(db, dbPath), null, 2)}\n`;
    }
    case "daily": {
      const today = localToday();
      const to = dateFlag(args, "to", today);
      const from = dateFlag(args, "from", addDays(to, -13));
      if (from > to) throw new CliError("--from is after --to");
      const format = formatFlag(args, ["md", "csv", "json"] as const, "md");
      const db = openReadOnly(dbPath);
      const rows = dailyMetrics(db, from, to);
      if (format === "json") return `${JSON.stringify(rows, null, 2)}\n`;
      const cells = rows.map(dailyCells);
      return format === "csv" ? plainCsv(DAILY_COLUMNS, cells) : `${mdTable(DAILY_COLUMNS, cells)}\n`;
    }
    case "weekly-csv": {
      const hasFrom = args.flags.has("from");
      const hasTo = args.flags.has("to");
      let range: { start: string; end: string };
      if (hasFrom || hasTo) {
        if (args.flags.has("week-of")) throw new CliError("weekly-csv: use --week-of or --from/--to, not both");
        if (!hasFrom || !hasTo) throw new CliError("weekly-csv: --from and --to go together");
        const start = dateFlag(args, "from", "");
        const end = dateFlag(args, "to", "");
        if (start > end) throw new CliError("--from is after --to");
        if (daySpan(start, end) > 31) throw new CliError("weekly-csv: --from/--to may span at most 31 days");
        range = { start, end };
      } else {
        const weekOf = args.flags.get("week-of");
        range = weekOf === undefined ? lastCompletedWeek(localToday()) : weekBounds(dateFlag(args, "week-of", ""));
      }
      const db = openReadOnly(dbPath);
      return weeklyCsv(db, range.start, range.end);
    }
    case "samples": {
      const wanted = args.flags.get("type");
      if (!wanted) throw new CliError("samples: --type is required");
      const format = formatFlag(args, ["json", "csv"] as const, "json");
      const limitRaw = args.flags.get("limit") ?? "100";
      const limit = Number(limitRaw);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new CliError("--limit must be an integer from 1 to 100000");
      const from = dateFlag(args, "from", "0000-01-01");
      const to = dateFlag(args, "to", "9999-12-31");
      const db = openReadOnly(dbPath);
      const type = resolveType(db, wanted);
      const stmt = db.prepare(
        `SELECT uuid, kind, type, start_at, end_at, local_date, value, unit, category, category_label,
                source_name, source_bundle_id, device_name, device_model, metadata, workout
           FROM samples WHERE type = ? AND local_date BETWEEN ? AND ? ORDER BY start_ms DESC LIMIT ?`,
      );
      const rows = stmt.all(type, from, to, limit);
      if (format === "json") {
        return `${JSON.stringify(rows.map(r => {
          const o = jsonable(r);
          for (const k of ["metadata", "workout"]) {
            if (typeof o[k] === "string") { try { o[k] = JSON.parse(o[k] as string); } catch { /* keep text */ } }
          }
          return o;
        }), null, 2)}\n`;
      }
      return printRows(stmt.columns().map(c => c.name), rows, "csv");
    }
    case "sql": {
      const query = args.positional.join(" ").trim();
      if (!query) throw new CliError("sql: pass the query as one argument, e.g. apple-health sql \"SELECT COUNT(*) FROM samples\"");
      checkReadQuery(query);
      const format = formatFlag(args, ["csv", "json", "md"] as const, "csv");
      const db = openReadOnly(dbPath);
      let stmt;
      try {
        stmt = db.prepare(query);
        const rows = stmt.all();
        return printRows(stmt.columns().map(c => c.name), rows, format);
      } catch (err) {
        throw new CliError(`sql: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    default:
      throw new CliError(`unknown command "${args.command}"\n\n${USAGE}`);
  }
}

try {
  process.stdout.write(run(process.argv.slice(2)));
} catch (err) {
  const message = err instanceof CliError ? err.message : (err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.stderr.write(`apple-health: ${message}\n`);
  process.exitCode = 1;
}
