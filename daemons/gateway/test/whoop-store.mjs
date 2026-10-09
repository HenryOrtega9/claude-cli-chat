/* Offline test for the WHOOP history store, backfill and `whoop` CLI.

   Touches nothing live: no launchd job, no real ~/.config/whoop, no real
   ~/Library/Application Support/vault-gateway files, no network beyond
   127.0.0.1. It bundles the gateway sources with esbuild into a temp
   directory (a test entry plus the `whoop` CLI, built the way build.mjs
   builds dist/), generates a deterministic synthetic history (2026-08-16 to
   2026-10-09 in -07:00, three band-off gap days, an unscorable recovery, two
   naps, runs with distance and zones, a walk at 00:20 before a 00:40
   bedtime, a pending workout), and serves it from a fake WHOOP server with
   real pagination (limit, nextToken, next_token):

     1. cycleDay / localDay: bed at 23:10 and at 00:40 land on the same day,
        noon is the boundary, a record's timezone_offset beats the gateway TZ
     2. The store: day stamping (a sleep takes its cycle's day, a nap too, a
        workout the day of the cycle it started in, re-stamped when its cycle
        arrives after it), a rescored record overwrites in place, a stale copy
        never rolls a newer one back, raw JSON kept
     3. Poll writes: every record a poll fetches lands in the store; a write
        that throws (or a store that cannot open) never fails the poll and is
        logged once
     4. Backfill: all four collections paged with limit=25 and the
        next_token chain, a pause between pages, markers complete; a record
        rescored on WHOOP overwrites on a re-run via POST /whoop/backfill;
        resume after a restart mid-backfill continues from the saved token
        with no page fetched twice; a 429 mid-backfill (long: retried after
        the reset, short: waited inline); a resume token WHOOP refuses
        restarts that collection
     5. The gateway route: POST /whoop/backfill with the main token (200),
        the read token (401), and while not connected (409); `whoop backfill`
     6. The CLI: status, daily rows with gaps and exact key order, workouts,
        week Sunday normalization, summary and prior_4wk math (spot checked
        against values computed here from the generator), sql refuses writes,
        the no-database message

   Set WHOOP_FIXTURE_OUT=<dir> to keep the fixture database
   (whoop-fixture.sqlite) and a `whoop week --json` sample there.

   Usage: node daemons/gateway/test/whoop-store.mjs */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import builtins from "builtin-modules";

process.env.TZ = "America/Los_Angeles";

const here = dirname(fileURLToPath(import.meta.url));
const gatewayDir = resolve(here, "..");
const tmp = mkdtempSync(join(tmpdir(), "whoop-store-test-"));
const credPath = join(tmp, "whoop", "credentials.json");
/* Belt and braces: anything that falls back to an env default lands in tmp. */
process.env.WHOOP_CREDENTIALS_FILE = credPath;
process.env.VAULT_GATEWAY_WHOOP_CACHE = join(tmp, "state", "whoop-cache.json");
process.env.VAULT_GATEWAY_WHOOP_DB = join(tmp, "state", "default-whoop.sqlite");
process.env.VAULT_GATEWAY_TOKEN_FILE = join(tmp, "gateway-token");

let failures = 0;
let passes = 0;
function pass(msg) { passes++; console.log(`PASS  ${msg}`); }
function fail(msg) { failures++; console.log(`FAIL  ${msg}`); }
function check(cond, msg, detail) { cond ? pass(msg) : fail(detail === undefined ? msg : `${msg}\n      got: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`); return cond; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(cond, ms = 15_000, what = "condition") {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(15);
  }
}

/* ---------- bundle ---------- */

const external = [...builtins, ...builtins.map(b => `node:${b}`), "node:sqlite", "obsidian", "electron"];
const common = { bundle: true, platform: "node", target: "node24", format: "cjs", external, logLevel: "warning" };
await build({
  ...common,
  stdin: {
    contents: `
      export * from "./src/whoop/summary";
      export * from "./src/whoop/store";
      export * from "./src/whoop/history";
      export * from "./src/whoop/service";
      export * from "./src/whoop/credentials";
      export * from "./src/whoop/oauth";
      export { openDatabase } from "./src/apple-health/sqlite";
      export { loadOrCreateToken } from "./src/token";
      export { GatewayServer } from "./src/server";
    `,
    resolveDir: gatewayDir,
    loader: "ts",
    sourcefile: "whoop-store-test-entry.ts",
  },
  outfile: join(tmp, "bundle.cjs"),
});
await build({
  ...common,
  entryPoints: [join(gatewayDir, "src/whoop/cli.ts")],
  outfile: join(tmp, "whoop.js"),
  banner: { js: "#!/usr/bin/env node" },
});
const H = createRequire(import.meta.url)(join(tmp, "bundle.cjs"));

/* ---------- synthetic history ---------- */

const OFF = "-07:00";
const FIRST_DAY = "2026-08-16";
const LAST_DAY = "2026-10-09";
const GAPS = new Set(["2026-09-10", "2026-09-11", "2026-10-01"]);
/* Local bedtime that opens each day's cycle; 12:00 and later is the
   evening before. Two days pinned for the boundary checks. */
const BEDTIMES = ["22:40", "23:05", "23:30", "23:55", "00:15", "00:35"];
const PINNED_BED = { "2026-10-02": "23:10", "2026-10-03": "00:40" };

const addDays = (d, n) => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const weekday = d => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); };
const at = (date, hhmm) => new Date(`${date}T${hhmm}:00.000${OFF}`).toISOString();
const plusMin = (iso, min) => new Date(Date.parse(iso) + min * 60_000).toISOString();
const MIN = 60_000;

let seed = 20261009;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const r1 = v => Math.round(v * 10) / 10;
const r3 = v => Math.round(v * 1000) / 1000;
const uuid = (kind, n) => `00000000-0000-4000-${kind}-${String(n).padStart(12, "0")}`;

function generate() {
  const cycles = [];
  const recoveries = [];
  const sleeps = [];
  const workouts = [];
  /* The day each record was generated for, the truth the store must match. */
  const truth = new Map();
  let index = 0;
  for (let day = FIRST_DAY; day <= LAST_DAY; day = addDays(day, 1), index++) {
    if (GAPS.has(day)) continue;
    const bed = PINNED_BED[day] ?? BEDTIMES[Math.floor(rnd() * BEDTIMES.length)];
    const start = at(bed >= "12:00" ? addDays(day, -1) : day, bed);
    const id = 95000 + index;
    const inBedMin = 400 + Math.floor(rnd() * 90);
    const awakeMin = 20 + Math.floor(rnd() * 25);
    const asleepMin = inBedMin - awakeMin;
    const swsMin = Math.round(asleepMin * 0.2);
    const remMin = Math.round(asleepMin * 0.24);
    const lightMin = asleepMin - swsMin - remMin;
    const wake = plusMin(start, inBedMin);
    const cycle = {
      id, user_id: 10129, created_at: plusMin(start, 2), updated_at: plusMin(start, 24 * 60), start, end: null, timezone_offset: OFF,
      score_state: "SCORED",
      score: { strain: r3(6 + rnd() * 12), kilojoule: r1(7000 + rnd() * 6000), average_heart_rate: Math.round(60 + rnd() * 15), max_heart_rate: Math.round(130 + rnd() * 55) },
    };
    cycles.push(cycle);
    const sleepId = uuid("8000", index);
    sleeps.push({
      id: sleepId, cycle_id: id, user_id: 10129, created_at: wake, updated_at: plusMin(wake, 5), start, end: wake, timezone_offset: OFF,
      nap: false, score_state: "SCORED",
      score: {
        stage_summary: {
          total_in_bed_time_milli: inBedMin * MIN, total_awake_time_milli: awakeMin * MIN, total_no_data_time_milli: 0,
          total_light_sleep_time_milli: lightMin * MIN, total_slow_wave_sleep_time_milli: swsMin * MIN, total_rem_sleep_time_milli: remMin * MIN,
          sleep_cycle_count: 4, disturbance_count: 3 + Math.floor(rnd() * 10),
        },
        sleep_needed: {
          baseline_milli: 27_000_000, need_from_sleep_debt_milli: Math.floor(rnd() * 45) * MIN,
          need_from_recent_strain_milli: Math.floor(rnd() * 30) * MIN, need_from_recent_nap_milli: 0,
        },
        respiratory_rate: r3(14.5 + rnd() * 2), sleep_performance_percentage: Math.round(70 + rnd() * 30),
        sleep_consistency_percentage: Math.round(60 + rnd() * 35), sleep_efficiency_percentage: r3(85 + rnd() * 12),
      },
    });
    const unscorable = day === "2026-09-20";
    recoveries.push({
      cycle_id: id, sleep_id: sleepId, user_id: 10129, created_at: plusMin(wake, 6), updated_at: plusMin(wake, 7),
      score_state: unscorable ? "UNSCORABLE" : "SCORED",
      ...(unscorable ? {} : {
        score: {
          user_calibrating: false, recovery_score: r1(25 + rnd() * 70), resting_heart_rate: r1(48 + rnd() * 12),
          hrv_rmssd_milli: r3(30 + rnd() * 40), spo2_percentage: r3(94 + rnd() * 3), skin_temp_celsius: r3(33 + rnd() * 1.2),
        },
      }),
    });
    truth.set(id, day);
    const dow = weekday(day);
    if (dow === 1 || dow === 3 || dow === 6) {
      const wStart = at(day, "07:30");
      const dur = 35 + Math.floor(rnd() * 20);
      const z = [1, 3, Math.round(dur * 0.35), Math.round(dur * 0.3)];
      z.push(dur - z.reduce((a, b) => a + b, 0) - 2, 2);
      workouts.push({
        id: uuid("9000", index * 10 + 1), user_id: 10129, created_at: plusMin(wStart, dur + 1), updated_at: plusMin(wStart, dur + 5),
        start: wStart, end: plusMin(wStart, dur), timezone_offset: OFF, sport_name: "running", sport_id: 0, score_state: "SCORED",
        score: {
          strain: r3(10 + rnd() * 5), average_heart_rate: Math.round(145 + rnd() * 15), max_heart_rate: Math.round(170 + rnd() * 15),
          kilojoule: r1(1400 + rnd() * 800), percent_recorded: 100, distance_meter: r1(dur * 160 + rnd() * 300),
          altitude_gain_meter: r3(20 + rnd() * 60),
          zone_durations: Object.fromEntries(["zero", "one", "two", "three", "four", "five"].map((n, i) => [`zone_${n}_milli`, z[i] * MIN])),
        },
      });
    }
    if (dow === 2 || dow === 4) {
      const wStart = at(day, "18:00");
      workouts.push({
        id: uuid("9000", index * 10 + 2), user_id: 10129, created_at: plusMin(wStart, 61), updated_at: plusMin(wStart, 65),
        start: wStart, end: plusMin(wStart, 60), timezone_offset: OFF, sport_name: "weightlifting", sport_id: 45, score_state: "SCORED",
        score: {
          strain: r3(7 + rnd() * 4), average_heart_rate: Math.round(110 + rnd() * 15), max_heart_rate: Math.round(150 + rnd() * 15),
          kilojoule: r1(900 + rnd() * 400), percent_recorded: 100,
          zone_durations: { zone_zero_milli: 6 * MIN, zone_one_milli: 24 * MIN, zone_two_milli: 22 * MIN, zone_three_milli: 8 * MIN, zone_four_milli: 0, zone_five_milli: 0 },
        },
      });
    }
  }
  /* Cycle ends: each closes at the next one's start; the newest is open. */
  for (let i = 0; i < cycles.length - 1; i++) cycles[i].end = cycles[i + 1].start;
  /* Naps, on their cycle's day. */
  const nap = (day, hhmm, inBed, awake, light, sws, rem, n) => {
    const cycle = cycles.find(c => truth.get(c.id) === day);
    const start = at(day, hhmm);
    sleeps.push({
      id: uuid("8100", n), cycle_id: cycle.id, user_id: 10129, created_at: plusMin(start, inBed), updated_at: plusMin(start, inBed + 3),
      start, end: plusMin(start, inBed), timezone_offset: OFF, nap: true, score_state: "SCORED",
      score: {
        stage_summary: {
          total_in_bed_time_milli: inBed * MIN, total_awake_time_milli: awake * MIN, total_light_sleep_time_milli: light * MIN,
          total_slow_wave_sleep_time_milli: sws * MIN, total_rem_sleep_time_milli: rem * MIN, disturbance_count: 1,
        },
        sleep_needed: { baseline_milli: 0, need_from_sleep_debt_milli: 0, need_from_recent_strain_milli: 0, need_from_recent_nap_milli: 0 },
        respiratory_rate: 15, sleep_performance_percentage: 100, sleep_consistency_percentage: 50, sleep_efficiency_percentage: 75,
      },
    });
  };
  nap("2026-09-28", "14:00", 40, 10, 20, 5, 5, 1);
  nap("2026-09-05", "15:00", 30, 5, 15, 5, 5, 2);
  /* A walk at 00:20 before the 00:40 bedtime that opens 10-03: it belongs to
     10-02, the day before its own calendar date. */
  workouts.push({
    id: uuid("9100", 1), user_id: 10129, created_at: at("2026-10-03", "00:36"), updated_at: at("2026-10-03", "00:40"),
    start: at("2026-10-03", "00:20"), end: at("2026-10-03", "00:35"), timezone_offset: OFF, sport_name: "walking", sport_id: 63,
    score_state: "SCORED",
    score: { strain: 2.04, average_heart_rate: 95, max_heart_rate: 108, kilojoule: 210, percent_recorded: 100,
      zone_durations: { zone_zero_milli: 9 * MIN, zone_one_milli: 6 * MIN, zone_two_milli: 0, zone_three_milli: 0, zone_four_milli: 0, zone_five_milli: 0 } },
  });
  /* Today's workout, not scored yet. */
  workouts.push({
    id: uuid("9100", 2), user_id: 10129, created_at: at(LAST_DAY, "12:46"), updated_at: at(LAST_DAY, "12:46"),
    start: at(LAST_DAY, "12:00"), end: at(LAST_DAY, "12:45"), timezone_offset: OFF, sport_name: "cycling", sport_id: 1, score_state: "PENDING_SCORE",
  });
  const newestFirst = (a, b) => Date.parse(b.start ?? "") - Date.parse(a.start ?? "");
  const cycleStart = new Map(cycles.map(c => [c.id, c.start]));
  return {
    cycles: [...cycles].sort(newestFirst),
    recoveries: [...recoveries].sort((a, b) => Date.parse(cycleStart.get(b.cycle_id)) - Date.parse(cycleStart.get(a.cycle_id))),
    sleeps: [...sleeps].sort(newestFirst),
    workouts: [...workouts].sort(newestFirst),
    truth,
  };
}
const DATA = generate();
const N = { cycles: DATA.cycles.length, recoveries: DATA.recoveries.length, sleeps: DATA.sleeps.length, workouts: DATA.workouts.length };
const pagesOf = n => Math.ceil(n / 25);

/* ---------- fake WHOOP ---------- */

const ACCESS = "acc-1";
const fake = {
  data: structuredClone({ cycles: DATA.cycles, recoveries: DATA.recoveries, sleeps: DATA.sleeps, workouts: DATA.workouts }),
  hits: [],
  /* [{ match: RegExp, count, reset }]: answer matching requests 429. */
  rateRules: [],
  rejectTokens: new Set(),
};
const COLLECTIONS = {
  "/developer/v2/cycle": "cycles",
  "/developer/v2/recovery": "recoveries",
  "/developer/v2/activity/sleep": "sleeps",
  "/developer/v2/activity/workout": "workouts",
};
const tokenFor = offset => Buffer.from(`page:${offset}`).toString("base64url");
const offsetOf = token => Number(Buffer.from(token, "base64url").toString("utf8").replace(/^page:/, ""));

const fakeServer = createServer((req, res) => {
  const url = new URL(req.url, "http://fake");
  const path = `${url.pathname}${url.search}`;
  fake.hits.push({ path, t: Date.now() });
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  if (req.headers.authorization !== `Bearer ${ACCESS}`) return send(401, { error: "unauthorized" });
  const rule = fake.rateRules.find(r => r.count > 0 && r.match.test(path));
  if (rule) {
    rule.count--;
    return send(429, { error: "too_many_requests" }, { "X-RateLimit-Reset": rule.reset });
  }
  const key = COLLECTIONS[url.pathname];
  if (key) {
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), 25);
    const token = url.searchParams.get("nextToken");
    if (token && fake.rejectTokens.has(token)) return send(400, { error: "invalid next token" });
    const offset = token ? offsetOf(token) : 0;
    const all = fake.data[key];
    const records = all.slice(offset, offset + limit);
    const more = offset + limit < all.length;
    /* Workouts end with "" rather than null, like some WHOOP answers. */
    return send(200, { records, next_token: more ? tokenFor(offset + limit) : key === "workouts" ? "" : null });
  }
  const m = /^\/developer\/v2\/cycle\/(\d+)\/(recovery|sleep)$/.exec(url.pathname);
  if (m) {
    const id = Number(m[1]);
    const rec = m[2] === "recovery"
      ? fake.data.recoveries.find(r => r.cycle_id === id)
      : fake.data.sleeps.find(s => s.cycle_id === id && !s.nap);
    return rec ? send(200, rec) : send(404, { error: "not_found" });
  }
  send(404, { error: "not_found" });
});
await new Promise(r => fakeServer.listen(0, "127.0.0.1", r));
const fakeBase = `http://127.0.0.1:${fakeServer.address().port}`;

await H.saveCredentials(credPath, {
  client_id: "test-client", client_secret: "test-secret", redirect_uri: H.DEFAULT_REDIRECT_URI,
  access_token: ACCESS, refresh_token: "ref-1", expires_at: new Date(Date.now() + 24 * 3600_000).toISOString(),
  scope: "offline read:recovery read:cycles read:sleep read:workout", obtained_at: new Date().toISOString(),
});

const logs = [];
let serviceN = 0;
function service(historyPath, over = {}) {
  const { timing, ...rest } = over;
  return new H.WhoopService({
    credentialsPath: credPath, cachePath: join(tmp, "cache", `${serviceN++}.json`), historyPath, log: m => logs.push(m),
    apiBase: fakeBase, oauthBase: `${fakeBase}/oauth/oauth2`,
    timing: { maxRateWaitMs: 100, backfillPageMs: 20, backfillRetryMs: 50, maxBackoffMs: 1_000, ...timing },
    ...rest,
  });
}
function statusOf(path) {
  const db = H.openDatabase(path, { readOnly: true });
  try { return H.readStoreStatus(db, path); } finally { db.close(); }
}
function rows(path, sql, ...params) {
  const db = H.openDatabase(path, { readOnly: true });
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}
const backfillHits = (since = 0) => fake.hits.slice(since).filter(h => /[?&]limit=25\b/.test(h.path));

try {
  /* ---------- 1. day rules ---------- */

  const thuBed = at("2026-10-01", "23:10");
  const friBed = at("2026-10-02", "00:40");
  check(H.cycleDay(thuBed, OFF) === "2026-10-02" && H.cycleDay(friBed, OFF) === "2026-10-02",
    "cycleDay: bed at 23:10 Thursday and at 00:40 Friday are both Friday", [H.cycleDay(thuBed, OFF), H.cycleDay(friBed, OFF)]);
  check(H.cycleDay(thuBed) === "2026-10-02" && H.cycleDay(friBed) === "2026-10-02", "cycleDay without an offset uses the gateway TZ (same answer here)");
  check(H.cycleDay(at("2026-10-01", "11:59"), OFF) === "2026-10-01" && H.cycleDay(at("2026-10-01", "12:00"), OFF) === "2026-10-02",
    "cycleDay: noon is the boundary (11:59 is that day, 12:00 the next)");
  /* 2026-10-02T14:10Z is 23:10 in Tokyo but 07:10 in Los Angeles. */
  check(H.cycleDay("2026-10-02T14:10:00.000Z", "+09:00") === "2026-10-03" && H.cycleDay("2026-10-02T14:10:00.000Z") === "2026-10-02"
    && H.cycleDay("2026-10-02T14:10:00.000Z", "+0900") === "2026-10-03",
    "cycleDay uses the record's timezone_offset over the gateway TZ (travel)");
  check(H.localDay(at("2026-10-03", "00:20"), OFF) === "2026-10-03" && H.cycleDay("nope") === null, "localDay is the plain local date; garbage is null");

  /* ---------- 2. store ---------- */

  const unitPath = join(tmp, "unit", "whoop.sqlite");
  const unit = new H.WhoopStore(unitPath);
  /* Bed at 23:10 Thursday 10-01 opens Friday 10-02; bed at 00:40 Saturday
     10-03 opens Saturday. */
  const satBed = at("2026-10-03", "00:40");
  const C1 = { id: 1, start: thuBed, end: satBed, timezone_offset: OFF, updated_at: "2026-10-03T15:00:00.000Z", score_state: "SCORED", score: { strain: 10 } };
  const C2 = { id: 2, start: satBed, end: null, timezone_offset: OFF, updated_at: "2026-10-03T15:00:00.000Z", score_state: "PENDING_SCORE" };
  /* Written before its cycle exists: the walk at 00:20 Saturday falls back to
     its local date, 10-03. */
  const LATE = { id: "w-late", start: at("2026-10-03", "00:20"), end: at("2026-10-03", "00:35"), timezone_offset: OFF, sport_name: "walking" };
  unit.write({ workouts: [LATE] });
  const dayOf = (table, id) => rows(unitPath, `SELECT day FROM ${table} WHERE id = ?`, id)[0]?.day;
  check(dayOf("workouts", "w-late") === "2026-10-03", "a workout with no covering cycle yet takes its local start date");
  unit.write({
    cycles: [C2, C1],
    sleeps: [
      { id: "s-main", cycle_id: 2, start: satBed, end: at("2026-10-03", "08:00"), timezone_offset: OFF, nap: false, score_state: "SCORED" },
      { id: "s-nap", cycle_id: 2, start: at("2026-10-03", "14:00"), end: at("2026-10-03", "14:30"), timezone_offset: OFF, nap: true, score_state: "SCORED" },
      { id: "s-orphan", cycle_id: 999, start: at("2026-10-05", "23:50"), end: at("2026-10-06", "07:10"), timezone_offset: OFF, nap: false },
    ],
  });
  check(dayOf("cycles", 1) === "2026-10-02" && dayOf("cycles", 2) === "2026-10-03",
    "store: cycles from a 23:10 and a 00:40 bedtime are stamped through cycleDay (10-02, 10-03)");
  check(dayOf("workouts", "w-late") === "2026-10-02" && rows(unitPath, "SELECT COUNT(*) AS n FROM workouts")[0].n === 1,
    "the 00:20 walk is re-stamped to 10-02, the day of the cycle it started in, once that cycle arrives");
  const W2 = { id: "w-next", start: at("2026-10-03", "18:00"), end: at("2026-10-03", "19:00"), timezone_offset: OFF, sport_name: "running" };
  unit.write({ workouts: [W2] });
  check(dayOf("workouts", "w-next") === "2026-10-03", "a workout inside the open cycle takes its day");
  check(dayOf("sleeps", "s-main") === "2026-10-03" && dayOf("sleeps", "s-nap") === "2026-10-03" && dayOf("sleeps", "s-orphan") === "2026-10-06",
    "sleeps take their cycle's day (the nap too); with no stored cycle, the local date of the end");
  unit.write({ cycles: [{ id: 999, start: at("2026-10-05", "23:50"), timezone_offset: OFF, end: null, updated_at: "2026-10-06T15:00:00.000Z" }] });
  check(dayOf("sleeps", "s-orphan") === "2026-10-06" && dayOf("cycles", 999) === "2026-10-06", "a late cycle re-stamps its sleeps");

  /* Rescored: same id, newer updated_at, overwrites in place; raw follows. */
  unit.write({ cycles: [{ ...C2, end: null, updated_at: "2026-10-03T18:00:00.000Z", score_state: "SCORED", score: { strain: 12.34, kilojoule: 9000 } }] });
  let c2 = rows(unitPath, "SELECT * FROM cycles WHERE id = 2")[0];
  check(rows(unitPath, "SELECT COUNT(*) AS n FROM cycles WHERE id = 2")[0].n === 1 && c2.score_state === "SCORED" && c2.strain === 12.34
    && JSON.parse(c2.raw).score.kilojoule === 9000, "a rescored cycle overwrites the pending copy (one row, new score, new raw)", c2);
  unit.write({ cycles: [{ ...C2, updated_at: "2026-10-03T16:00:00.000Z", score_state: "PENDING_SCORE" }] });
  c2 = rows(unitPath, "SELECT * FROM cycles WHERE id = 2")[0];
  check(c2.score_state === "SCORED" && c2.strain === 12.34, "an older copy (strictly older updated_at) never rolls a newer one back", c2);
  unit.write({ recoveries: [{ cycle_id: 2, score_state: "PENDING_SCORE", updated_at: "2026-10-03T14:00:00.000Z" }] });
  unit.write({ recoveries: [{ cycle_id: 2, score_state: "SCORED", updated_at: "2026-10-03T14:05:00.000Z", score: { recovery_score: 77, user_calibrating: true } }] });
  const r2 = rows(unitPath, "SELECT * FROM recoveries")[0];
  check(r2.recovery_score === 77 && r2.user_calibrating === 1 && r2.score_state === "SCORED", "a rescored recovery overwrites too", r2);
  const skipped = unit.write({ cycles: [{ id: 5 }, null, { start: thuBed }], workouts: [{ id: "x" }] });
  check(skipped.cycles === 0 && skipped.workouts === 0, "malformed records are skipped and the write goes on", skipped);
  check(rows(unitPath, "SELECT version FROM schema_version")[0].version === H.SCHEMA_VERSION
    && rows(unitPath, "PRAGMA journal_mode")[0].journal_mode === "wal", "schema_version table and WAL");
  unit.close();

  /* ---------- 3. poll writes ---------- */

  const pollPath = join(tmp, "poll", "whoop.sqlite");
  /* Mark the backfill done so only the poll writes here. */
  const pre = new H.WhoopStore(pollPath);
  for (const c of H.BACKFILL_ORDER) pre.writeBackfillPage(c, [], null, true);
  pre.close();
  const noTopUp = { sleepTopUpMs: Number.MAX_SAFE_INTEGER };
  const svcPoll = service(pollPath, { timing: noTopUp });
  let sum = await svcPoll.pollNow();
  let st = statusOf(pollPath);
  check(sum.auth === "ok" && !sum.stale && st.counts.cycles === 8 && st.counts.recoveries === 8 && st.counts.sleeps === 1 && st.counts.workouts === 10
    && st.last_poll_write_at !== null, "a poll writes every record it fetched: 8 cycles, 8 recoveries, the current sleep, 10 workouts", st.counts);
  check(backfillHits().length === 0, "with the history complete, a poll starts no backfill");

  const realWritePoll = H.WhoopStore.prototype.writePoll;
  H.WhoopStore.prototype.writePoll = () => { throw new Error("SQLITE_FULL: database or disk is full"); };
  let logsBefore = logs.length;
  try {
    sum = await svcPoll.pollNow();
    const again = await svcPoll.pollNow();
    const failLogs = logs.slice(logsBefore).filter(l => /history write failed \(polling continues\): SQLITE_FULL/.test(l));
    check(sum.auth === "ok" && !sum.stale && sum.last_error === null && again.last_error === null && sum.recovery.score !== null && failLogs.length === 1,
      "a history write that throws never fails the poll, and a repeated error logs once", { sum: sum.last_error, failLogs });
  } finally {
    H.WhoopStore.prototype.writePoll = realWritePoll;
  }
  logsBefore = logs.length;
  await svcPoll.pollNow();
  check(logs.slice(logsBefore).some(l => /history writes recovered/.test(l)), "the next good write logs the recovery");
  await svcPoll.stop();

  const blocker = join(tmp, "blocker");
  writeFileSync(blocker, "a file, not a directory\n");
  const svcBad = service(join(blocker, "whoop.sqlite"), { timing: noTopUp });
  logsBefore = logs.length;
  sum = await svcBad.pollNow();
  check(sum.auth === "ok" && !sum.stale && sum.last_error === null && logs.slice(logsBefore).some(l => /whoop history write failed/.test(l)),
    "a store that cannot open (its parent is a file) costs only the history: the poll succeeds", sum.last_error);
  await svcBad.stop();

  /* ---------- 4. backfill ---------- */

  const fullPath = join(tmp, "full", "whoop.sqlite");
  let hit0 = fake.hits.length;
  const svcFull = service(fullPath, { timing: { backfillPageMs: 40 } });
  sum = await svcFull.pollNow();
  check(sum.auth === "ok" && !sum.stale, "the first poll succeeds while the backfill starts in the background");
  await waitFor(() => statusOf(fullPath).backfill.state === "complete", 20_000, "backfill complete");
  st = statusOf(fullPath);
  check(st.counts.cycles === N.cycles && st.counts.recoveries === N.recoveries && st.counts.sleeps === N.sleeps && st.counts.workouts === N.workouts,
    `backfill stores the whole history (${N.cycles} cycles, ${N.recoveries} recoveries, ${N.sleeps} sleeps, ${N.workouts} workouts)`, st.counts);
  const bf = backfillHits(hit0);
  const byPath = p => bf.filter(h => h.path.startsWith(`${p}?`));
  const chainOk = Object.keys(COLLECTIONS).every(p => {
    const hs = byPath(p);
    const n = fake.data[COLLECTIONS[p]].length;
    return hs.length === pagesOf(n) && hs.every((h, i) => (i === 0 ? h.path === `${p}?limit=25` : h.path === `${p}?limit=25&nextToken=${tokenFor(i * 25)}`));
  });
  check(chainOk, "each collection is paged with limit=25, first page bare, then each next_token in turn, one request per page",
    bf.map(h => h.path));
  check(bf.map(h => h.path.split("?")[0]).join() === [
    ...Array(pagesOf(N.cycles)).fill("/developer/v2/cycle"), ...Array(pagesOf(N.recoveries)).fill("/developer/v2/recovery"),
    ...Array(pagesOf(N.sleeps)).fill("/developer/v2/activity/sleep"), ...Array(pagesOf(N.workouts)).fill("/developer/v2/activity/workout"),
  ].join(), "collections are walked in order: cycles, recoveries, sleeps, workouts");
  const gaps = bf.slice(1).map((h, i) => h.t - bf[i].t);
  check(gaps.every(g => g >= 35), "a pause of backfillPageMs (40 ms here, 2 s by default) separates every page request", gaps);
  check(H.BACKFILL_ORDER.every(c => st.backfill.collections[c].state === "complete" && st.backfill.collections[c].completed_at
    && !st.backfill.collections[c].has_next_token) && st.backfill.collections.cycle.pages === pagesOf(N.cycles)
    && st.backfill.collections.cycle.records === N.cycles && st.backfill.completed_at !== null,
    "markers: every collection complete with its page and record counts", st.backfill);
  check(logs.some(l => /whoop backfill complete:/.test(l)), "completion is logged");
  /* The day stamps match the generator's truth for every cycle. */
  const stamped = rows(fullPath, "SELECT id, day FROM cycles");
  check(stamped.length === N.cycles && stamped.every(r => DATA.truth.get(Number(r.id)) === r.day), "every backfilled cycle is on its generated day");
  const walk = rows(fullPath, "SELECT day FROM workouts WHERE sport_name = 'walking'")[0];
  check(walk?.day === "2026-10-02", "the 00:20 walk before the 00:40 bedtime is on the previous day", walk);

  /* The next good poll after completion runs the hourly sleep top-up. */
  hit0 = fake.hits.length;
  await svcFull.pollNow();
  await waitFor(() => fake.hits.slice(hit0).some(h => h.path === "/developer/v2/activity/sleep?limit=10"), 5_000, "sleep top-up");
  check(backfillHits(hit0).length === 0, "after completion a poll starts no backfill; the sleep top-up (limit 10) runs instead");

  /* A record WHOOP rescored, picked up by a re-run started over the route. */
  const target = fake.data.recoveries.find(r => r.score_state === "SCORED" && DATA.truth.get(r.cycle_id) === "2026-09-01");
  target.score = { ...target.score, recovery_score: 99.4 };
  target.updated_at = new Date().toISOString();
  const answer = svcFull.requestBackfill();
  check(answer.status === 200 && answer.body.backfill === "restarted" && answer.body.running === true,
    "requestBackfill on an idle, complete history restarts it", answer);
  await waitFor(() => statusOf(fullPath).backfill.state === "complete", 20_000, "re-run complete");
  const rescored = rows(fullPath, "SELECT recovery_score FROM recoveries WHERE cycle_id = ?", target.cycle_id)[0];
  st = statusOf(fullPath);
  check(rescored.recovery_score === 99.4 && st.counts.recoveries === N.recoveries,
    "the re-run overwrites the rescored recovery in place (no duplicate rows)", { rescored, counts: st.counts });
  await svcFull.stop();

  /* Resume after a restart mid-backfill. */
  const resumePath = join(tmp, "resume", "whoop.sqlite");
  hit0 = fake.hits.length;
  const svcA = service(resumePath, { timing: { backfillPageMs: 400 } });
  await svcA.pollNow();
  await waitFor(() => statusOf(resumePath).backfill.collections.cycle.pages >= 2, 10_000, "two cycle pages");
  await svcA.stop();
  const mid = statusOf(resumePath).backfill.collections.cycle;
  const savedToken = rows(resumePath, "SELECT next_token FROM backfill WHERE collection = 'cycle'")[0]?.next_token;
  check(mid.state === "in_progress" && mid.pages === 2 && savedToken === tokenFor(50) && backfillHits(hit0).length === 2,
    "stopped mid-backfill: two cycle pages in, the third page's token saved, nothing else fetched", { mid, savedToken });
  const hitB = fake.hits.length;
  const svcB = service(resumePath, { timing: { backfillPageMs: 20 } });
  await svcB.pollNow();
  await waitFor(() => statusOf(resumePath).backfill.state === "complete", 20_000, "resumed backfill complete");
  const resumed = backfillHits(hitB);
  st = statusOf(resumePath);
  check(resumed[0]?.path === `/developer/v2/cycle?limit=25&nextToken=${savedToken}`,
    "after the restart the backfill resumes with the saved next_token", resumed[0]?.path);
  check(backfillHits(hit0).filter(h => h.path.startsWith("/developer/v2/cycle?")).length === pagesOf(N.cycles)
    && st.backfill.collections.cycle.pages === pagesOf(N.cycles) && st.backfill.collections.cycle.records === N.cycles
    && st.counts.cycles === N.cycles && st.counts.workouts === N.workouts,
    "across the restart every cycle page was fetched exactly once and the counts are whole", { pages: st.backfill.collections.cycle, counts: st.counts });
  await svcB.stop();

  /* 429 during backfill: a long reset is retried after it, a short one is
     waited out inline by api.ts. */
  const rlPath = join(tmp, "ratelimit", "whoop.sqlite");
  fake.rateRules = [
    { match: /^\/developer\/v2\/activity\/sleep\?limit=25&nextToken=/, count: 1, reset: "0.4" },
    { match: /^\/developer\/v2\/activity\/workout\?limit=25$/, count: 1, reset: "0.05" },
  ];
  hit0 = fake.hits.length;
  logsBefore = logs.length;
  const svcRl = service(rlPath, { timing: { backfillPageMs: 10, backfillRetryMs: 50 } });
  await svcRl.pollNow();
  await waitFor(() => statusOf(rlPath).backfill.state === "complete", 20_000, "backfill complete after 429s");
  const sleepHits = fake.hits.slice(hit0).filter(h => h.path === `/developer/v2/activity/sleep?limit=25&nextToken=${tokenFor(25)}`);
  st = statusOf(rlPath);
  check(sleepHits.length === 2 && sleepHits[1].t - sleepHits[0].t >= 380 && st.counts.sleeps === N.sleeps
    && st.backfill.collections.sleep.last_error === null,
    "a 429 resetting in 0.4 s (over the inline cap): the same page is retried after the reset, then the backfill completes",
    { n: sleepHits.length, gap: sleepHits[1] ? sleepHits[1].t - sleepHits[0].t : null, counts: st.counts });
  check(logs.slice(logsBefore).some(l => /backfill: sleep page failed \(1 in a row\): .*rate limited/.test(l))
    && !logs.slice(logsBefore).some(l => /backfill: workout page failed/.test(l)),
    "the long 429 is logged as a retried page; the short one never surfaces");
  check(fake.rateRules.every(r => r.count === 0) && st.counts.workouts === N.workouts, "both 429s were served and the workouts still completed");
  fake.rateRules = [];
  await svcRl.stop();

  /* A resume token WHOOP no longer accepts restarts that collection. */
  const badTokPath = join(tmp, "badtoken", "whoop.sqlite");
  const pre2 = new H.WhoopStore(badTokPath);
  for (const c of ["cycle", "recovery", "sleep"]) pre2.writeBackfillPage(c, [], null, true);
  pre2.writeBackfillPage("workout", [], "expired-token", false);
  pre2.close();
  fake.rejectTokens.add("expired-token");
  hit0 = fake.hits.length;
  const svcTok = service(badTokPath, { timing: noTopUp });
  await svcTok.pollNow();
  await waitFor(() => statusOf(badTokPath).backfill.state === "complete", 10_000, "workout restart complete");
  const wHits = backfillHits(hit0).map(h => h.path);
  check(wHits[0] === "/developer/v2/activity/workout?limit=25&nextToken=expired-token" && wHits[1] === "/developer/v2/activity/workout?limit=25"
    && statusOf(badTokPath).counts.workouts === N.workouts, "a refused resume token (400) restarts that collection from its newest page", wHits);
  await svcTok.stop();

  /* ---------- 5. gateway route ---------- */

  const mainTokenPath = join(tmp, "gateway-token");
  H.loadOrCreateToken(mainTokenPath, () => {});
  const readToken = H.loadOrCreateToken(join(tmp, "whoop-read-token"), () => {}, "WHOOP READ TOKEN", "watch");
  const MAIN = readFileSync(mainTokenPath, "utf8").trim();
  const READ = readFileSync(join(tmp, "whoop-read-token"), "utf8").trim();
  const gwPath = join(tmp, "gw", "whoop.sqlite");
  const gwWhoop = service(gwPath, { timing: { backfillPageMs: 10 } });
  const gwLogs = [];
  const server = new H.GatewayServer({
    config: {
      vault: join(tmp, "vault"), port: 0, bind: "127.0.0.1", tokenFile: mainTokenPath, maxChildren: 1,
      approvalTimeoutS: 1, claudePath: "/usr/bin/false", stateMirrorPath: join(tmp, "state-mirror"), healthDb: join(tmp, "server", "health.sqlite"),
      whoopCredentials: credPath, whoopCache: join(tmp, "gw-cache.json"), whoopDb: gwPath, whoopReadTokenFile: join(tmp, "whoop-read-token"),
    },
    registry: {},
    token: H.loadOrCreateToken(mainTokenPath, () => {}),
    whoopReadToken: readToken,
    whoop: gwWhoop,
    mirror: { set() {}, reflect() {} },
    claudePath: "/usr/bin/false",
    startedAt: Date.now(),
    version: "test",
    isReady: () => true,
    log: m => gwLogs.push(m),
  });
  await server.listen("127.0.0.1", 0);
  const gwPort = server.http.address().port;
  const call = async (method, path, token) => {
    const res = await fetch(`http://127.0.0.1:${gwPort}${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  const cliPath = join(tmp, "whoop.js");
  const cachePathForCli = join(tmp, "cli-cache.json");
  const cliEnv = (over = {}) => ({
    ...process.env, TZ: "America/Los_Angeles", VAULT_GATEWAY_WHOOP_DB: fullPath, VAULT_GATEWAY_WHOOP_CACHE: cachePathForCli,
    VAULT_GATEWAY_TOKEN_FILE: mainTokenPath, VAULT_GATEWAY_BIND: "127.0.0.1", VAULT_GATEWAY_PORT: String(gwPort), ...over,
  });
  /* Async: `whoop backfill` calls back into this process's gateway. */
  const cli = (args, over = {}) => new Promise(resolveRun => {
    const child = spawn(process.execPath, [cliPath, ...args], { env: cliEnv(over) });
    let out = "";
    let err = "";
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("close", code => resolveRun({ code, out, err }));
  });
  const cliJson = async (args, over) => {
    const r = await cli([...args, "--json"], over);
    let parsed = null;
    try { parsed = JSON.parse(r.out); } catch { /* reported by the check */ }
    return { ...r, json: parsed };
  };

  try {
    let res = await call("POST", "/whoop/backfill", READ);
    check(res.status === 401, "read token: POST /whoop/backfill is 401", res);
    res = await call("POST", "/whoop/backfill", null);
    check(res.status === 401, "no token: POST /whoop/backfill is 401", res);
    res = await call("POST", "/whoop/backfill", MAIN);
    check(res.status === 200 && res.json?.backfill === "restarted" && res.json.running === true && res.json.history?.db_path === gwPath,
      "main token: POST /whoop/backfill starts it (200) and answers the store status", res);
    await waitFor(() => existsSync(gwPath) && statusOf(gwPath).backfill.state === "complete", 20_000, "route backfill complete");
    check(statusOf(gwPath).counts.cycles === N.cycles, "the route's backfill completes");

    const viaCli = await cli(["backfill"], { VAULT_GATEWAY_WHOOP_DB: gwPath });
    check(viaCli.code === 0 && /^Backfill restarted in the gateway/.test(viaCli.out) && /Records: \d+ cycles/.test(viaCli.out),
      "`whoop backfill` asks the gateway and prints the progress", viaCli.err || viaCli.out);
    await waitFor(() => statusOf(gwPath).backfill.state === "complete", 20_000, "cli backfill complete");

    const offPath = join(tmp, "offline-creds", "credentials.json");
    const offline = service(join(tmp, "off", "whoop.sqlite"), { credentialsPath: offPath });
    const offAnswer = offline.requestBackfill();
    check(offAnswer.status === 409 && offAnswer.body.error === "whoop_not_connected" && offAnswer.body.auth === "not_configured",
      "not connected: requestBackfill answers 409 with the auth state", offAnswer);
    const noHistory = new H.WhoopService({ credentialsPath: credPath, cachePath: join(tmp, "nohist.json"), log: () => {}, apiBase: fakeBase });
    check(noHistory.requestBackfill().status === 503, "no history path: 503");

    /* ---------- 6. CLI ---------- */

    const status = await cliJson(["status"]);
    check(status.code === 0 && status.err === "" && status.json?.db_path === fullPath && status.json.counts.cycles === N.cycles
      && status.json.oldest_day === FIRST_DAY && status.json.newest_day === LAST_DAY && status.json.backfill.state === "complete"
      && Object.keys(status.json).join() === "db_path,schema_version,counts,oldest_day,newest_day,last_poll_at,last_poll_write_at,backfill",
      "status --json: path, counts, day span, backfill state, no stderr (no ExperimentalWarning)", status.err || status.json);
    const statusText = await cli(["status"]);
    check(statusText.code === 0 && /Backfill: complete/.test(statusText.out) && /cycle\s+complete/.test(statusText.out), "status text", statusText.out);

    const DAILY_KEYS = "day,recovery,band,hrv_ms,rhr_bpm,spo2_pct,skin_temp_c,strain,kcal,avg_hr_bpm,max_hr_bpm,sleep_performance_pct,sleep_hours,"
      + "sleep_need_hours,sleep_debt_hours,sleep_efficiency_pct,sleep_consistency_pct,respiratory_rate,disturbances,nap_hours,workouts";
    const daily = await cliJson(["daily", "--from", "2026-09-08", "--to", "2026-09-13"]);
    const drows = daily.json ?? [];
    check(daily.code === 0 && drows.length === 6 && drows.map(d => d.day).join() === "2026-09-08,2026-09-09,2026-09-10,2026-09-11,2026-09-12,2026-09-13"
      && drows.every(d => Object.keys(d).join() === DAILY_KEYS), "daily --json: one row per day inclusive, keys in contract order", daily.err || drows);
    const gap = drows.find(d => d.day === "2026-09-10");
    check(gap && Object.entries(gap).every(([k, v]) => k === "day" || (k === "workouts" ? v === 0 : v === null)),
      "a gap day appears with every value null and workouts 0", gap);
    /* One full row, recomputed here from the generator's records. */
    const dayRec = d => {
      const cycle = DATA.cycles.find(c => DATA.truth.get(c.id) === d);
      return { cycle, rec: DATA.recoveries.find(r => r.cycle_id === cycle.id), sleep: DATA.sleeps.find(s => s.cycle_id === cycle.id && !s.nap) };
    };
    const { cycle: c12, rec: rec12, sleep: s12 } = dayRec("2026-09-12");
    const row12 = drows.find(d => d.day === "2026-09-12");
    const st12 = s12.score.stage_summary;
    const need12 = s12.score.sleep_needed;
    const h2 = ms => Math.round(ms / 3600_000 * 100) / 100;
    const expect12 = {
      day: "2026-09-12",
      recovery: Math.round(rec12.score.recovery_score),
      band: Math.round(rec12.score.recovery_score) >= 67 ? "green" : Math.round(rec12.score.recovery_score) >= 34 ? "yellow" : "red",
      hrv_ms: r1(rec12.score.hrv_rmssd_milli),
      rhr_bpm: Math.round(rec12.score.resting_heart_rate),
      spo2_pct: r1(rec12.score.spo2_percentage),
      skin_temp_c: Math.round(rec12.score.skin_temp_celsius * 100) / 100,
      strain: r1(c12.score.strain),
      kcal: Math.round(c12.score.kilojoule / 4.184),
      avg_hr_bpm: c12.score.average_heart_rate,
      max_hr_bpm: c12.score.max_heart_rate,
      sleep_performance_pct: s12.score.sleep_performance_percentage,
      sleep_hours: h2(st12.total_light_sleep_time_milli + st12.total_slow_wave_sleep_time_milli + st12.total_rem_sleep_time_milli),
      sleep_need_hours: h2(need12.baseline_milli + need12.need_from_sleep_debt_milli + need12.need_from_recent_strain_milli + need12.need_from_recent_nap_milli),
      sleep_debt_hours: h2(need12.need_from_sleep_debt_milli),
      sleep_efficiency_pct: r1(s12.score.sleep_efficiency_percentage),
      sleep_consistency_pct: r1(s12.score.sleep_consistency_percentage),
      respiratory_rate: r1(s12.score.respiratory_rate),
      disturbances: st12.disturbance_count,
      nap_hours: 0,
      /* Every generated workout on 09-12 is a daytime one, on its local date. */
      workouts: DATA.workouts.filter(x => new Date(x.start).toLocaleDateString("en-CA") === "2026-09-12").length,
    };
    check(JSON.stringify(row12) === JSON.stringify(expect12),
      "a full daily row matches the generator (recovery int, hrv 1 dp, kcal = kJ / 4.184, hours 2 dp, strain 1 dp)", { got: row12, want: expect12 });
    /* 09-12 follows the 09-10/11 gap: its cycle is the next one after the long one. */
    const longCycle = DATA.cycles.find(c => DATA.truth.get(c.id) === "2026-09-09");
    check(Date.parse(longCycle.end) - Date.parse(longCycle.start) > 48 * 3600_000 && drows.find(d => d.day === "2026-09-09").strain !== null,
      "the cycle spanning the gap stays on its own day");
    const napDay = (await cliJson(["daily", "--from", "2026-09-28", "--to", "2026-09-28"])).json?.[0];
    check(napDay?.nap_hours === 0.5 && napDay.sleep_hours !== null && napDay.sleep_hours < 9,
      "a nap counts in nap_hours (30 min asleep -> 0.5) and not in the night's sleep_hours", napDay);
    const unscorableDay = (await cliJson(["daily", "--from", "2026-09-20", "--to", "2026-09-20"])).json?.[0];
    check(unscorableDay?.recovery === null && unscorableDay.band === null && unscorableDay.hrv_ms === null && unscorableDay.strain !== null,
      "an unscorable recovery reads null while the day's strain stays", unscorableDay);
    const dailyText = await cli(["daily", "--from", "2026-09-08", "--to", "2026-09-13"]);
    check(dailyText.code === 0 && dailyText.out.split("\n")[0].startsWith("day") && dailyText.out.includes("2026-09-10"), "daily text table", dailyText.out);

    const WORKOUT_KEYS = "day,start,end,sport,strain,kcal,avg_hr_bpm,max_hr_bpm,distance_km,altitude_gain_m,zones_min,duration_min";
    const wk = await cliJson(["workouts", "--from", "2026-10-02", "--to", "2026-10-09"]);
    const wrows = wk.json ?? [];
    const walkRow = wrows.find(w => w.sport === "walking");
    const pending = wrows.find(w => w.sport === "cycling");
    const run = wrows.find(w => w.sport === "running");
    const runSrc = DATA.workouts.find(w => w.start === run?.start);
    check(wk.code === 0 && wrows.every(w => Object.keys(w).join() === WORKOUT_KEYS) && walkRow?.day === "2026-10-02"
      && JSON.stringify(walkRow.zones_min) === "[9,6,0,0,0,0]" && walkRow.duration_min === 15 && walkRow.kcal === 50,
      "workouts --json: contract keys; the 00:20 walk is on 10-02 with zones in minutes and kcal from kJ", wk.err || wrows);
    check(pending?.strain === null && pending.kcal === null && pending.zones_min === null && pending.duration_min === 45,
      "a pending workout: strain, kcal and zones null, duration still known", pending);
    check(run && runSrc && run.distance_km === Math.round(runSrc.score.distance_meter / 10) / 100 && run.altitude_gain_m === r1(runSrc.score.altitude_gain_meter)
      && run.zones_min.reduce((a, b) => a + b, 0) === run.duration_min, "a run: distance in km (2 dp), altitude 1 dp, zone minutes sum to the duration", run);

    /* week: Sunday normalization. */
    const weekOf = async d => (await cliJson(["week", "--week-of", d])).json;
    const w = await weekOf("2026-10-01");
    check(w?.week_start === "2026-09-27" && w.week_end === "2026-10-03" && w.days.length === 7 && w.days[0].day === "2026-09-27"
      && w.days.at(-1).day === "2026-10-03" && Object.keys(w).join() === "week_start,week_end,days,workouts,summary,prior_4wk",
      "week --week-of a Thursday normalizes to Sunday 09-27 .. Saturday 10-03", w && { s: w.week_start, e: w.week_end });
    const sameWeek = await Promise.all(["2026-09-27", "2026-10-03"].map(weekOf));
    const nextWeek = await weekOf("2026-10-04");
    check(sameWeek.every(x => x?.week_start === "2026-09-27") && nextWeek?.week_start === "2026-10-04",
      "the Sunday itself and the Saturday give the same week; the next Sunday starts the next");
    check(Object.keys(w.summary).join() === "days_with_recovery,recovery_avg,recovery_min,recovery_max,band_counts,hrv_avg_ms,rhr_avg_bpm,"
      + "strain_avg,strain_total,sleep_hours_avg,sleep_need_hours_avg,sleep_performance_avg,zone_minutes,workout_count"
      && Object.keys(w.prior_4wk).join() === "recovery_avg,hrv_avg_ms,rhr_avg_bpm,strain_avg,sleep_hours_avg",
      "week summary and prior_4wk keys in contract order");

    /* Summary math, recomputed from the week's own rows. */
    /* Half-up on the decimal value, as the contract says (6.845 -> 6.85 even
       when the float sum lands at 6.84499...). */
    const dround = (x, d) => Math.round(Number((x * 10 ** d).toPrecision(12))) / 10 ** d;
    const mean = (xs, d) => { const v = xs.filter(x => x !== null); return v.length ? dround(v.reduce((a, b) => a + b, 0) / v.length, d) : null; };
    const recs = w.days.map(d => d.recovery).filter(x => x !== null);
    check(w.summary.sleep_hours_avg === 6.85, "a mean that is exactly half-way in decimal (6.845) rounds up", w.summary.sleep_hours_avg);
    check(w.summary.days_with_recovery === 6 && w.days.find(d => d.day === "2026-10-01").recovery === null
      && w.summary.recovery_avg === mean(recs, 1) && w.summary.recovery_min === Math.min(...recs) && w.summary.recovery_max === Math.max(...recs)
      && w.summary.band_counts.green + w.summary.band_counts.yellow + w.summary.band_counts.red === 6
      && w.summary.strain_total === dround(w.days.reduce((t, d) => t + (d.strain ?? 0), 0), 1)
      && w.summary.sleep_hours_avg === mean(w.days.map(d => d.sleep_hours), 2)
      && w.summary.workout_count === w.workouts.length && w.workouts.some(x => x.sport === "walking"),
      "week summary: averages over non-null days only (10-01 is a gap), bands sum to the days, totals and counts agree", w.summary);
    const zoneTotals = [0, 1, 2, 3, 4, 5].map(i => dround(w.workouts.reduce((t, x) => t + (x.zones_min?.[i] ?? 0), 0), 1));
    check(JSON.stringify(w.summary.zone_minutes) === JSON.stringify(zoneTotals), "zone_minutes are the per-zone totals of the week's workouts", w.summary.zone_minutes);

    /* prior_4wk spot check: recovery over 08-30 .. 09-26, computed here from
       the fake server's records (each recovery's generated day, its score
       rounded, the unscorable 09-20 and the 09-10/11 gap left out; 09-01 is
       the 99.4 rescored in section 4). */
    const priorRec = fake.data.recoveries
      .filter(r => r.score_state === "SCORED")
      .filter(r => { const d = DATA.truth.get(r.cycle_id); return d >= "2026-08-30" && d <= "2026-09-26"; })
      .map(r => Math.round(r.score.recovery_score));
    const expectPrior = Math.round(priorRec.reduce((a, b) => a + b, 0) / priorRec.length * 10) / 10;
    check(priorRec.length === 25 && w.prior_4wk.recovery_avg === expectPrior,
      `prior_4wk.recovery_avg is the mean of the 25 scored days before 09-27 (${expectPrior})`, { got: w.prior_4wk, want: expectPrior, n: priorRec.length });
    const priorHrv = fake.data.recoveries.filter(r => r.score_state === "SCORED" && DATA.truth.get(r.cycle_id) >= "2026-08-30" && DATA.truth.get(r.cycle_id) <= "2026-09-26")
      .map(r => r1(r.score.hrv_rmssd_milli));
    check(w.prior_4wk.hrv_avg_ms === Math.round(priorHrv.reduce((a, b) => a + b, 0) / priorHrv.length * 10) / 10, "prior_4wk.hrv_avg_ms likewise", w.prior_4wk);
    const early = await weekOf("2026-08-20");
    check(early && Object.values(early.prior_4wk).every(v => v === null), "prior_4wk is all null when the 28 days before hold no data", early?.prior_4wk);
    const weekText = await cli(["week", "--week-of", "2026-10-01"]);
    check(weekText.code === 0 && /^WHOOP week 2026-09-27 \(Sun\) to 2026-10-03 \(Sat\)/.test(weekText.out) && /Prior 4 weeks:/.test(weekText.out),
      "week text output", weekText.out.slice(0, 200));

    const sel = await cli(["sql", "SELECT COUNT(*) AS n FROM cycles WHERE day BETWEEN '2026-09-27' AND '2026-10-03'"]);
    check(sel.code === 0 && JSON.stringify(JSON.parse(sel.out)) === JSON.stringify([{ n: 6 }]), "sql SELECT answers JSON rows", sel.err || sel.out);
    const quoted = await cli(["sql", 'SELECT id, "end" FROM cycles ORDER BY start_ms DESC LIMIT 1']);
    check(quoted.code === 0 && JSON.parse(quoted.out)[0].end === null, "sql with a quoted \"end\" works (the open cycle has none)", quoted.err || quoted.out);
    const ins = await cli(["sql", "INSERT INTO cycles (id) VALUES (1)"]);
    check(ins.code === 1 && /only SELECT and WITH/.test(ins.err), "sql refuses INSERT", ins.err);
    const two = await cli(["sql", "SELECT 1; DELETE FROM cycles"]);
    check(two.code === 1 && /one statement/.test(two.err), "sql refuses a second statement", two.err);
    const cte = await cli(["sql", "WITH x AS (SELECT 1) DELETE FROM cycles"]);
    check(cte.code === 1 && /readonly|read-only/i.test(cte.err), "a write hidden behind WITH fails on the read-only connection", cte.err);
    check(statusOf(fullPath).counts.cycles === N.cycles, "the cycles survive every refused write");

    const missingDb = join(tmp, "nope", "whoop.sqlite");
    for (const args of [["status"], ["daily"], ["week", "--json"]]) {
      const r = await cli(args, { VAULT_GATEWAY_WHOOP_DB: missingDb });
      check(r.code === 1 && r.err.startsWith("whoop: no WHOOP history yet: run whoop-auth, then wait for the first poll"),
        `\`whoop ${args.join(" ")}\` with no database exits 1 with the setup hint`, r.err);
    }
    check(!existsSync(missingDb), "the CLI never creates a database");
    const badDate = await cli(["daily", "--from", "2026-09-31"]);
    const badRange = await cli(["daily", "--from", "2026-09-10", "--to", "2026-09-01"]);
    check(badDate.code === 1 && /YYYY-MM-DD/.test(badDate.err) && badRange.code === 1 && /after --to/.test(badRange.err), "date validation");

    /* Keep the fixture for the next consumers when asked. */
    const out = process.env.WHOOP_FIXTURE_OUT;
    if (out) {
      mkdirSync(out, { recursive: true });
      const dest = join(out, "whoop-fixture.sqlite");
      rmSync(dest, { force: true });
      const keep = new H.WhoopStore(fullPath);
      keep.db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
      keep.close();
      const sample = await cli(["week", "--week-of", "2026-10-01", "--json"], { VAULT_GATEWAY_WHOOP_DB: dest });
      writeFileSync(join(out, "whoop-week-sample.json"), sample.out);
      console.log(`NOTE  fixture kept: ${dest} and ${join(out, "whoop-week-sample.json")}`);
    }
  } finally {
    await gwWhoop.stop();
    server.http.closeAllConnections?.();
    await server.close();
  }
} finally {
  fakeServer.closeAllConnections?.();
  fakeServer.close();
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "OK" : "FAILED"}: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
