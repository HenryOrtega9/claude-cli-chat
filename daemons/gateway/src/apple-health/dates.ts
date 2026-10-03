/* Date helpers for the Apple Health store, derive layer and CLI.

   Everything downstream of ingest works on LOCAL wall-clock text
   ("YYYY-MM-DDTHH:MM:SS") and local calendar dates ("YYYY-MM-DD"), because
   every rule in the contract is phrased in local time: a day's totals, the
   night a sleep sample belongs to, the Monday-to-Sunday week. The phone sends
   ISO 8601 with its local offset, so the wall clock is read straight off the
   string; no time zone database is involved and a sample logged while
   travelling keeps the local time it was logged in. */

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type Instant = { ms: number; local: string };

function validYmd(y: number, m: number, d: number): boolean {
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  return !!m && validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

/* Parses an ISO 8601 date-time that carries an offset (or Z). A bare local
   time is rejected: it is ambiguous, and the contract requires the offset.
   For a Z timestamp the wall clock comes from `fallbackZone` (the batch's
   device.timeZone) when it is a zone Intl knows, else it stays UTC. */
export function parseInstant(value: unknown, fallbackZone: string | null): Instant | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const m = ISO_RE.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  if (!validYmd(Number(y), Number(mo), Number(d))) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s ?? "0") > 59) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  if (m[7] === "Z") {
    return { ms, local: fallbackZone ? (wallClock(ms, fallbackZone) ?? wallClock(ms, "UTC")!) : wallClock(ms, "UTC")! };
  }
  return { ms, local: `${y}-${mo}-${d}T${h}:${mi}:${s ?? "00"}` };
}

/* "YYYY-MM-DDTHH:MM:SS" for an instant in `timeZone` (the process's own zone
   when omitted). Null for a zone Intl does not know. */
export function wallClock(ms: number, timeZone?: string): string | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
  } catch {
    return null;
  }
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

/* Today's local calendar date on this Mac. */
export function localToday(now: Date = new Date()): string {
  return (wallClock(now.getTime()) ?? now.toISOString()).slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/* 0 = Sunday ... 6 = Saturday. */
export function weekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/* The Sunday that starts the Sunday-to-Saturday week containing `date`. */
export function sundayOf(date: string): string {
  return addDays(date, -weekday(date));
}

/* Inclusive number of calendar days from `from` to `to` (1 when equal). */
export function daySpan(from: string, to: string): number {
  const ms = (x: string) => { const [y, m, d] = x.split("-").map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((ms(to) - ms(from)) / 86_400_000) + 1;
}

export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 4000; d = addDays(d, 1)) out.push(d);
  return out;
}
