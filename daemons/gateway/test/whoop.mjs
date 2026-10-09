/* Offline test for the WHOOP half of the gateway.

   Touches nothing live: no launchd job, no real ~/.config/whoop, no real
   cache, no network beyond 127.0.0.1. It bundles the gateway sources with
   esbuild into a temp directory (a test entry plus the whoop-auth CLI, built
   the way build.mjs builds dist/), starts a fake WHOOP server on an ephemeral
   port (fixtures in test/fixtures/whoop/; it rotates refresh tokens and
   rejects a reused one, like the real thing), and points everything at it:

     1. buildSummary: the fixture mapping, band edges 67/66/34/33, pending and
        missing recovery fall back to the previous cycle, unscorable does not,
        empty input keeps every object, staleness, the exact key sets; the
        history fields: week (7 of 8 cycles, oldest first, a cycle with no or
        an unscorable recovery is null, noon day rule), workouts_today (this
        cycle only, oldest first), strain_today (series only for this cycle,
        wake from this cycle's sleep), and advanceStrainSeries (append on
        change only, reset on a new cycle id, cap 400)
     2. pollDelayMs: 5 min cadence, morning knob, backoff cap, rate-limit wait
     3. WhoopService against the fake: no credentials -> not_configured; a
        401 -> exactly one refresh, rotation persisted, mode 600; five
        concurrent polls (one instance, and five instances sharing the file)
        -> one refresh; a 429 waits out a tiny X-RateLimit-Reset; a long one
        backs off; invalid_grant -> reauth_required while the cached data is
        served marked stale, no retries, and a fresh login resumes; the cache
        survives a new instance; fallback through the real API calls; five
        requests a poll; the strain series through real polls (append on
        change, survives a new instance via the cache, reset on a new cycle,
        cap 400 from a full cached series)
     4. The real GatewayServer on an ephemeral 127.0.0.1 port: the read-only
        token works on GET /whoop/summary only (401 on /health, /whoop/poll,
        /apple-health/status), the main token works on both WHOOP routes
     5. whoop-auth end to end, the test playing the browser: set-client from
        stdin, login with a wrong-state redirect rejected and the right one
        accepted, the gateway poked, status, a pasted-URL login with the
        gateway down, a refused authorization, logout

   Usage: node daemons/gateway/test/whoop.mjs */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import builtins from "builtin-modules";

process.env.TZ = "America/Los_Angeles";

const here = dirname(fileURLToPath(import.meta.url));
const gatewayDir = resolve(here, "..");
const tmp = mkdtempSync(join(tmpdir(), "whoop-test-"));
const credPath = join(tmp, "whoop", "credentials.json");
const cachePath = join(tmp, "state", "whoop-cache.json");
/* Belt and braces: anything that falls back to an env default lands in tmp. */
process.env.WHOOP_CREDENTIALS_FILE = credPath;
process.env.VAULT_GATEWAY_WHOOP_CACHE = cachePath;
process.env.VAULT_GATEWAY_TOKEN_FILE = join(tmp, "gateway-token");

let failures = 0;
let passes = 0;
function pass(msg) { passes++; console.log(`PASS  ${msg}`); }
function fail(msg) { failures++; console.log(`FAIL  ${msg}`); }
function check(cond, msg, detail) { cond ? pass(msg) : fail(detail === undefined ? msg : `${msg}\n      got: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`); return cond; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const mode = p => statSync(p).mode & 0o777;

/* ---------- bundle ---------- */

const external = [...builtins, ...builtins.map(b => `node:${b}`), "node:sqlite", "obsidian", "electron"];
const common = { bundle: true, platform: "node", target: "node24", format: "cjs", external, logLevel: "warning" };
await build({
  ...common,
  stdin: {
    contents: `
      export * from "./src/whoop/summary";
      export * from "./src/whoop/service";
      export * from "./src/whoop/credentials";
      export * from "./src/whoop/oauth";
      export { loadOrCreateToken } from "./src/token";
      export { GatewayServer } from "./src/server";
    `,
    resolveDir: gatewayDir,
    loader: "ts",
    sourcefile: "whoop-test-entry.ts",
  },
  outfile: join(tmp, "bundle.cjs"),
});
await build({
  ...common,
  entryPoints: [join(gatewayDir, "src/whoop/auth-cli.ts")],
  outfile: join(tmp, "whoop-auth.js"),
  banner: { js: "#!/usr/bin/env node" },
});
const H = createRequire(import.meta.url)(join(tmp, "bundle.cjs"));

/* ---------- fixtures ---------- */

const F = name => JSON.parse(readFileSync(join(here, "fixtures/whoop", name), "utf8"));
const CYCLES = F("cycles.json").records;
const [CUR, PREV] = CYCLES;
const REC = F("recovery-scored.json");
const REC_PENDING = F("recovery-pending.json");
const REC_UNSCORABLE = F("recovery-unscorable.json");
const REC_PREV = F("recovery-previous.json");
const SLEEP = F("sleep-scored.json");
const WORKOUT = F("workout.json").records[0];
const RECS = F("recoveries.json").records;
const WORKOUTS = F("workouts.json").records;

/* ---------- 1. buildSummary ---------- */

const NOW = new Date("2026-10-09T16:00:00.000Z");
const okMeta = (over = {}) => ({ auth: "ok", fetchedAt: NOW.getTime() - 60_000, lastPollOk: true, nextPollAt: null, lastError: null, ...over });
const rawWith = over => ({ cycle: CUR, previousCycle: PREV, recovery: REC, previousRecovery: null, sleep: SLEEP, workout: WORKOUT, ...over });

const s = H.buildSummary(rawWith({}), NOW, okMeta());
check(s.schema === 1 && s.auth === "ok" && s.stale === false && s.last_error === null && s.fetched_at === "2026-10-09T15:59:00.000Z",
  "summary header: schema 1, auth ok, fresh", s);
check(s.updated_at === "2026-10-09T15:40:12.000Z", "updated_at is the newest record update", s.updated_at);
check(JSON.stringify(s.recovery) === JSON.stringify({
  state: "scored", is_current_cycle: true, score: 72, band: "green", hrv_ms: 45.7, rhr_bpm: 54, spo2_pct: 96.3,
  skin_temp_c: 33.46, calibrating: false, updated_at: "2026-10-09T13:56:30.000Z",
}), "recovery maps v2 fields (hrv 1 dp, spo2 1 dp, skin temp 2 dp)", s.recovery);
check(JSON.stringify(s.strain) === JSON.stringify({
  state: "scored", day_strain: 8.4, kilojoule: 8288.5, kcal: 1981, avg_hr_bpm: 68, max_hr_bpm: 151,
  cycle_start: "2026-10-09T06:10:00.000Z", cycle_end: null,
}), "strain: 1 dp, kcal = kJ / 4.184 rounded, open cycle has a null end", s.strain);
check(JSON.stringify(s.sleep) === JSON.stringify({
  state: "scored", performance_pct: 91, hours_slept: 7.25, hours_needed: 8, hours_in_bed: 8, efficiency_pct: 90.6,
  consistency_pct: 84, respiratory_rate: 15.2, stages: { light_h: 4, sws_h: 1.5, rem_h: 1.75, awake_h: 0.75 },
  disturbances: 7, start: "2026-10-09T06:10:00.000Z", end: "2026-10-09T14:10:00.000Z",
}), "sleep: slept = light + SWS + REM, need = sum of sleep_needed (negative nap credit included)", s.sleep);
check(JSON.stringify(s.workout) === JSON.stringify({
  state: "scored", sport: "running", strain: 11.3, kcal: 400, avg_hr_bpm: 151, max_hr_bpm: 178,
  start: "2026-10-09T14:45:00.000Z", end: "2026-10-09T15:30:00.000Z",
}), "workout maps sport_name, strain, kcal, heart rates", s.workout);
check(Object.keys(s).join() === "schema,auth,stale,fetched_at,updated_at,next_poll_at,last_error,recovery,strain,sleep,workout,week,strain_today,workouts_today",
  "top-level keys match the schema in order", Object.keys(s));
check(H.summaryLine(s) === "Recovery 72% (green) | Strain 8.4 | Sleep 7.25 h of 8 h needed (91%)", "summaryLine", H.summaryLine(s));

const bandOf = score => H.buildSummary(rawWith({ recovery: { ...REC, score: { ...REC.score, recovery_score: score } } }), NOW, okMeta()).recovery.band;
check(bandOf(67) === "green" && bandOf(66) === "yellow" && bandOf(34) === "yellow" && bandOf(33) === "red"
  && bandOf(100) === "green" && bandOf(0) === "red", "band edges: 67 green, 66 yellow, 34 yellow, 33 red",
  [67, 66, 34, 33].map(bandOf));

const fb = H.buildSummary(rawWith({ recovery: REC_PENDING, previousRecovery: REC_PREV }), NOW, okMeta());
check(fb.recovery.state === "scored" && fb.recovery.is_current_cycle === false && fb.recovery.score === 42 && fb.recovery.band === "yellow"
  && fb.recovery.rhr_bpm === 58 && fb.recovery.calibrating === true && fb.recovery.updated_at === REC_PREV.updated_at,
  "pending recovery falls back to the previous cycle, is_current_cycle false", fb.recovery);
check(fb.strain.day_strain === 8.4 && fb.sleep.hours_slept === 7.25, "fallback leaves strain and sleep on the newest cycle");
const missingFb = H.buildSummary(rawWith({ recovery: null, previousRecovery: REC_PREV }), NOW, okMeta());
check(missingFb.recovery.is_current_cycle === false && missingFb.recovery.score === 42, "missing recovery also falls back", missingFb.recovery);
const pendingAlone = H.buildSummary(rawWith({ recovery: REC_PENDING }), NOW, okMeta());
check(pendingAlone.recovery.state === "pending" && pendingAlone.recovery.is_current_cycle === true && pendingAlone.recovery.score === null
  && pendingAlone.recovery.band === null, "pending with no previous recovery stays pending", pendingAlone.recovery);
const unscorable = H.buildSummary(rawWith({ recovery: REC_UNSCORABLE, previousRecovery: REC_PREV }), NOW, okMeta());
check(unscorable.recovery.state === "unscorable" && unscorable.recovery.is_current_cycle === true && unscorable.recovery.score === null
  && unscorable.recovery.hrv_ms === null, "unscorable is final: no fallback, nulls", unscorable.recovery);

const empty = H.buildSummary(null, NOW, { auth: "not_configured", fetchedAt: null, lastPollOk: false, nextPollAt: null, lastError: null });
check(empty.recovery && empty.strain && empty.sleep && empty.workout === null && empty.stale === true
  && empty.recovery.state === "missing" && empty.strain.state === "missing" && empty.sleep.state === "missing"
  && empty.sleep.stages === null && empty.recovery.calibrating === false && empty.fetched_at === null,
  "no data: recovery/strain/sleep still present with nulls, workout null, stale", empty);
check(JSON.stringify([empty.week, empty.strain_today, empty.workouts_today]) === JSON.stringify([[], { cycle_start: null, wake: null, points: [] }, []]),
  "no data: week [], strain_today with null start/wake and points [], workouts_today []", [empty.week, empty.strain_today, empty.workouts_today]);
check(Object.keys(empty.recovery).join() === Object.keys(s.recovery).join()
  && Object.keys(empty.strain).join() === Object.keys(s.strain).join()
  && Object.keys(empty.sleep).join() === Object.keys(s.sleep).join(), "empty objects carry the same keys as full ones");
check(H.buildSummary(rawWith({}), NOW, okMeta({ fetchedAt: NOW.getTime() - 46 * 60_000 })).stale === true
  && H.buildSummary(rawWith({}), NOW, okMeta({ fetchedAt: NOW.getTime() - 44 * 60_000 })).stale === false
  && H.buildSummary(rawWith({}), NOW, okMeta({ lastPollOk: false })).stale === true,
  "stale: older than 45 min or the last poll failed");

/* History fields. */
const hist = H.buildSummary(rawWith({ cycles: CYCLES, recoveries: RECS, workouts: WORKOUTS }), NOW, okMeta());
check(JSON.stringify(hist.week) === JSON.stringify([
  { cycle_start: "2026-10-03T06:15:00.000Z", day: "2026-10-03", recovery: 20, band: "red", strain: null },
  { cycle_start: "2026-10-04T05:30:00.000Z", day: "2026-10-04", recovery: null, band: null, strain: 12.3 },
  { cycle_start: "2026-10-05T06:00:00.000Z", day: "2026-10-05", recovery: null, band: null, strain: 17.6 },
  { cycle_start: "2026-10-06T07:40:00.000Z", day: "2026-10-06", recovery: 34, band: "yellow", strain: 6 },
  { cycle_start: "2026-10-07T05:50:00.000Z", day: "2026-10-07", recovery: 66, band: "yellow", strain: 11 },
  { cycle_start: "2026-10-08T06:25:00.000Z", day: "2026-10-08", recovery: 42, band: "yellow", strain: 14 },
  { cycle_start: "2026-10-09T06:10:00.000Z", day: "2026-10-09", recovery: 72, band: "green", strain: 8.4 },
]), "week: 7 of the 8 cycles, oldest first, recovery matched by cycle_id (none or unscorable -> null), unscored cycle strain null",
  hist.week);
check(hist.week.at(-1).strain === hist.strain.day_strain && hist.week.at(-1).recovery === hist.recovery.score,
  "week's last entry is the current cycle and agrees with the headline strain and recovery");
check(hist.week[3].day === "2026-10-06" && hist.week[4].day === "2026-10-07",
  "day: bed at 00:40 and bed at 22:50 the same calendar date land on different days (start + 12 h, gateway TZ)", hist.week.map(d => d.day));
check(H.buildSummary(rawWith({ cycles: [...CYCLES].reverse(), recoveries: RECS }), NOW, okMeta()).week[0].day === "2026-10-08",
  "week trusts WHOOP's newest-first order (takes the first 7)");
check(JSON.stringify(rawWith({}).cycles) === undefined && H.buildSummary(rawWith({}), NOW, okMeta()).week.length === 0
  && H.buildSummary(rawWith({}), NOW, okMeta()).workouts_today.length === 0,
  "a raw without the collections (a cache from before them) gives week [] and workouts_today [] without throwing");
check(JSON.stringify(hist.workouts_today) === JSON.stringify([
  { sport: "running", start: "2026-10-09T14:45:00.000Z", end: "2026-10-09T15:30:00.000Z", strain: 11.3 },
  { sport: "cycling", start: "2026-10-09T19:00:00.000Z", end: "2026-10-09T19:40:00.000Z", strain: null },
]), "workouts_today: only workouts since the current cycle start, oldest first, unscored strain null", hist.workouts_today);
check(hist.workout?.sport === "running" && hist.workout.strain === 11.3, "the latest workout field still comes from raw.workout, unchanged");
check(JSON.stringify(hist.strain_today) === JSON.stringify({ cycle_start: CUR.start, wake: SLEEP.end, points: [] }),
  "strain_today with no series: this cycle's start, wake = its sleep end, no points", hist.strain_today);
const SERIES = { cycle_id: CUR.id, points: [{ t: "2026-10-09T14:20:00.000Z", strain: 0.4 }, { t: "2026-10-09T15:35:00.000Z", strain: 8.4 }] };
check(JSON.stringify(H.buildSummary(rawWith({}), NOW, okMeta(), SERIES).strain_today.points) === JSON.stringify(SERIES.points)
  && H.buildSummary(rawWith({}), NOW, okMeta(), { ...SERIES, cycle_id: PREV.id }).strain_today.points.length === 0,
  "strain_today shows the series only while it belongs to the current cycle");
check(H.buildSummary(rawWith({ sleep: { ...SLEEP, cycle_id: PREV.id } }), NOW, okMeta()).strain_today.wake === null
  && H.buildSummary(rawWith({ sleep: null }), NOW, okMeta()).strain_today.wake === null,
  "wake is null when the sleep belongs to another cycle or there is none");

const T0 = Date.parse("2026-10-09T14:20:00.000Z");
const cyc = (strain, id = CUR.id, state = "SCORED") => ({ ...CUR, id, score_state: state, score: strain === null ? undefined : { ...CUR.score, strain } });
let ser = H.advanceStrainSeries(null, cyc(0.43), T0);
check(JSON.stringify(ser) === JSON.stringify({ cycle_id: CUR.id, points: [{ t: "2026-10-09T14:20:00.000Z", strain: 0.4 }] }),
  "advanceStrainSeries: the first poll starts the series (1 dp)", ser);
const same = H.advanceStrainSeries(ser, cyc(0.4449), T0 + 5 * 60_000);
check(same === ser && same.points.length === 1, "an unchanged strain (at 1 dp) adds no point");
ser = H.advanceStrainSeries(ser, cyc(8.4321), T0 + 10 * 60_000);
check(ser.points.length === 2 && ser.points[1].strain === 8.4 && ser.points[1].t === "2026-10-09T14:30:00.000Z" && same.points.length === 1,
  "a changed strain appends {poll time, strain} and leaves the old series untouched", ser);
check(H.advanceStrainSeries(ser, null, T0) === ser, "no current cycle: the series is kept as is");
const reset = H.advanceStrainSeries(ser, cyc(0.1, 93846), T0 + 20 * 60_000);
check(reset.cycle_id === 93846 && reset.points.length === 1 && reset.points[0].strain === 0.1, "a new cycle id resets the series", reset);
const resetPending = H.advanceStrainSeries(ser, cyc(null, 93846, "PENDING_SCORE"), T0);
check(resetPending.cycle_id === 93846 && resetPending.points.length === 0, "a new unscored cycle resets to no points", resetPending);
let big = null;
for (let i = 0; i < 450; i++) big = H.advanceStrainSeries(big, cyc(i % 2 ? 5 : 6), T0 + i * 60_000);
check(big.points.length === 400 && big.points[0].t === new Date(T0 + 50 * 60_000).toISOString()
  && big.points.at(-1).t === new Date(T0 + 449 * 60_000).toISOString() && H.STRAIN_SERIES_CAP === 400,
  "the series is capped at 400 points, oldest dropped", { n: big.points.length, first: big.points[0] });

/* ---------- 2. pollDelayMs ---------- */

const MIN = 60_000;
const at = hhmm => new Date(`2026-10-09T${hhmm}:00-07:00`);
const delay = over => H.pollDelayMs({ auth: "ok", lastPollOk: true, failures: 0, retryAfterMs: null, recoveryScoredToday: false, now: at("07:00"), ...over });
check(delay({}) === 5 * MIN && delay({ recoveryScoredToday: true }) === 5 * MIN && delay({ now: at("04:59") }) === 5 * MIN
  && delay({ now: at("14:00") }) === 5 * MIN
  && H.pollDelayMs({ auth: "ok", lastPollOk: true, failures: 0, retryAfterMs: null, recoveryScoredToday: true, now: at("14:00") },
    { ...H.DEFAULT_TIMING, pollMs: 15 * MIN }) === 15 * MIN
  && H.pollDelayMs({ auth: "ok", lastPollOk: true, failures: 0, retryAfterMs: null, recoveryScoredToday: false, now: at("07:00") },
    { ...H.DEFAULT_TIMING, pollMs: 15 * MIN }) === 5 * MIN,
  "every 5 min all day; the morning knob still overrides a slower pollMs");
check(delay({ lastPollOk: false, failures: 1 }) === 2 * MIN && delay({ lastPollOk: false, failures: 3 }) === 8 * MIN
  && delay({ lastPollOk: false, failures: 12 }) === 60 * MIN, "failures back off 2, 4, 8 ... capped at 60 min");
check(delay({ lastPollOk: false, failures: 1, retryAfterMs: 30 * MIN }) === 30 * MIN, "a rate-limit reset longer than the backoff wins");
check(delay({ auth: "not_configured" }) === MIN && delay({ auth: "reauth_required" }) === MIN, "unconfigured / re-auth ticks are a 60 s file check");

/* ---------- fake WHOOP ---------- */

const CLIENT_ID = "test-client";
const CLIENT_SECRET = "test-secret";
const fake = {
  n: 0,
  access: new Set(),
  refresh: new Set(),
  refreshCalls: 0,
  refreshScopes: [],
  tokenContentTypes: [],
  exchangeCalls: 0,
  codes: new Set(),
  lastRedirect: null,
  hits: [],
  rateLimit: 0,
  rateReset: "0.2",
  tokenDelayMs: 40,
  recovery: {},
  sleep: {},
  cycles: [],
  recoveries: [],
  workouts: [],
};
function resetData() {
  fake.recovery = { [CUR.id]: REC, [PREV.id]: REC_PREV };
  fake.sleep = { [CUR.id]: SLEEP };
  fake.cycles = CYCLES;
  fake.recoveries = RECS;
  fake.workouts = [WORKOUT];
}
resetData();
function issue() {
  fake.n++;
  const t = { access_token: `acc-${fake.n}`, refresh_token: `ref-${fake.n}`, expires_in: 3600, scope: "offline read:recovery read:cycles", token_type: "bearer" };
  fake.access.add(t.access_token);
  fake.refresh.add(t.refresh_token);
  return t;
}

const fakeServer = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fake");
  const send = (status, body, headers = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(text);
  };
  if (req.method === "POST" && url.pathname === "/oauth/oauth2/token") {
    let body = "";
    for await (const c of req) body += c;
    const type = req.headers["content-type"] ?? "";
    fake.tokenContentTypes.push(type);
    const p = type.includes("json") ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
    if (p.client_id !== CLIENT_ID || p.client_secret !== CLIENT_SECRET) return send(401, { error: "invalid_client" });
    await sleep(fake.tokenDelayMs);
    if (p.grant_type === "authorization_code") {
      fake.exchangeCalls++;
      if (!fake.codes.has(p.code)) return send(400, { error: "invalid_grant" });
      fake.codes.delete(p.code);
      fake.lastRedirect = p.redirect_uri;
      return send(200, issue());
    }
    if (p.grant_type === "refresh_token") {
      fake.refreshCalls++;
      fake.refreshScopes.push(p.scope);
      /* Single use: a reused (or revoked) refresh token is refused. */
      if (!fake.refresh.has(p.refresh_token)) return send(400, { error: "invalid_grant", error_description: "refresh token reused or revoked" });
      fake.refresh.delete(p.refresh_token);
      fake.access.clear();
      return send(200, issue());
    }
    return send(400, { error: "unsupported_grant_type" });
  }
  fake.hits.push(`${url.pathname}${url.search}`);
  if (!fake.access.has((req.headers.authorization ?? "").replace(/^Bearer /, ""))) return send(401, { error: "unauthorized" });
  if (fake.rateLimit > 0) {
    fake.rateLimit--;
    return send(429, { error: "too_many_requests" }, { "X-RateLimit-Reset": fake.rateReset });
  }
  /* Collections honor ?limit= (WHOOP's default page is 10). */
  const limit = Number(url.searchParams.get("limit") ?? 10);
  if (url.pathname === "/developer/v2/cycle") return send(200, { records: fake.cycles.slice(0, limit), next_token: "next" });
  if (url.pathname === "/developer/v2/recovery") return send(200, { records: fake.recoveries.slice(0, limit), next_token: "next" });
  const m = /^\/developer\/v2\/cycle\/(\d+)\/(recovery|sleep)$/.exec(url.pathname);
  if (m) {
    const rec = fake[m[2]][m[1]];
    return rec ? send(200, rec) : send(404, { error: "not_found" });
  }
  if (url.pathname === "/developer/v2/activity/workout") return send(200, { records: fake.workouts.slice(0, limit), next_token: null });
  if (url.pathname === "/developer/v2/user/profile/basic") return send(200, F("profile.json"));
  send(404, { error: "not_found" });
});
await new Promise(r => fakeServer.listen(0, "127.0.0.1", r));
const fakeBase = `http://127.0.0.1:${fakeServer.address().port}`;

async function seedCreds(path = credPath, over = {}) {
  const t = issue();
  await H.saveCredentials(path, {
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: H.DEFAULT_REDIRECT_URI,
    access_token: t.access_token, refresh_token: t.refresh_token,
    expires_at: new Date(Date.now() + 3600_000).toISOString(), scope: t.scope, obtained_at: new Date().toISOString(),
    ...over,
  });
}
const readCreds = (path = credPath) => JSON.parse(readFileSync(path, "utf8"));

const logs = [];
function service(over = {}) {
  return new H.WhoopService({
    credentialsPath: credPath, cachePath, log: m => logs.push(m),
    apiBase: fakeBase, oauthBase: `${fakeBase}/oauth/oauth2`, timing: { maxRateWaitMs: 5_000 },
    ...over,
  });
}

try {
  /* ---------- 3. WhoopService ---------- */

  let svc = service();
  check(svc.summary().auth === "not_configured", "no credentials file: not_configured before any poll");
  let sum = await svc.pollNow();
  check(sum.auth === "not_configured" && fake.hits.length === 0 && sum.recovery.state === "missing" && sum.stale === true,
    "no credentials: poll makes no WHOOP request, every record missing", sum);
  check(sum.week.length === 0 && sum.strain_today.points.length === 0 && sum.strain_today.cycle_start === null && sum.workouts_today.length === 0,
    "no credentials: week [], strain_today points [], workouts_today []", [sum.week, sum.strain_today, sum.workouts_today]);

  await seedCreds();
  sum = await svc.pollNow();
  check(sum.auth === "ok" && sum.stale === false && sum.recovery.score === 72 && sum.strain.kcal === 1981 && sum.workout?.sport === "running",
    "credentials appear: the next poll picks them up and fetches", sum);
  check(fake.hits.includes("/developer/v2/cycle?limit=8") && fake.hits.includes(`/developer/v2/cycle/${CUR.id}/recovery`)
    && fake.hits.includes(`/developer/v2/cycle/${CUR.id}/sleep`) && fake.hits.includes("/developer/v2/activity/workout?limit=10")
    && fake.hits.includes("/developer/v2/recovery?limit=8") && !fake.hits.includes(`/developer/v2/cycle/${PREV.id}/recovery`)
    && fake.hits.length === 5,
    "polls cycles (limit 8), recoveries (limit 8), recovery, sleep, workouts (limit 10): 5 requests, no previous recovery when today is scored", fake.hits);
  check(sum.week.length === 7 && sum.week.at(-1).recovery === 72 && sum.week[1].recovery === null && sum.strain_today.points.length === 1
    && sum.strain_today.wake === SLEEP.end && sum.workouts_today.length === 1 && sum.workouts_today[0].sport === "running",
    "the polled summary carries week, strain_today and workouts_today", [sum.week, sum.strain_today, sum.workouts_today]);
  check(existsSync(cachePath) && mode(cachePath) === 0o600, "cache written, mode 600");

  /* 401 -> exactly one refresh, rotation persisted. */
  const before = readCreds();
  fake.access.clear();
  let r0 = fake.refreshCalls;
  sum = await svc.pollNow();
  const after = readCreds();
  check(sum.auth === "ok" && sum.stale === false && fake.refreshCalls - r0 === 1, "a 401 triggers exactly one refresh and the poll succeeds",
    { calls: fake.refreshCalls - r0, sum });
  check(after.refresh_token !== before.refresh_token && after.refresh_token === `ref-${fake.n}` && after.access_token === `acc-${fake.n}`
    && Date.parse(after.expires_at) > Date.now() + 3500_000 && after.client_secret === CLIENT_SECRET,
    "the rotated pair is persisted (and the client kept)", after);
  check(mode(credPath) === 0o600 && mode(dirname(credPath)) === 0o700, "credentials file mode 600, directory 700",
    [mode(credPath).toString(8), mode(dirname(credPath)).toString(8)]);
  check(fake.refreshScopes.at(-1) === "offline" && fake.tokenContentTypes.at(-1) === "application/x-www-form-urlencoded",
    "refresh is form-encoded and asks for scope=offline", [fake.refreshScopes.at(-1), fake.tokenContentTypes.at(-1)]);
  check(!existsSync(H.lockPathFor(credPath)), "the lock file is released");

  /* Five concurrent polls on one instance. */
  fake.access.clear();
  r0 = fake.refreshCalls;
  const five = await Promise.all(Array.from({ length: 5 }, () => svc.pollNow()));
  check(fake.refreshCalls - r0 === 1 && five.every(x => x.auth === "ok" && !x.stale), "five concurrent polls on one instance: one refresh",
    fake.refreshCalls - r0);

  /* Five instances (stand-ins for separate processes) sharing the file, all
     holding an access token inside the 5-minute margin. The fake refuses a
     reused refresh token, so a second refresh would surface as reauth. */
  await H.saveCredentials(credPath, { ...readCreds(), expires_at: new Date(Date.now() + 60_000).toISOString() });
  const instances = Array.from({ length: 5 }, () => service());
  r0 = fake.refreshCalls;
  const results = await Promise.all(instances.map(i => i.pollNow()));
  check(fake.refreshCalls - r0 === 1 && results.every(x => x.auth === "ok" && !x.stale),
    "five instances refreshing near expiry at once: one refresh, the rest adopt it via the lock",
    { calls: fake.refreshCalls - r0, auth: results.map(x => x.auth) });
  check(logs.some(l => /adopted tokens/.test(l)), "the losers log that they adopted the rotated tokens");

  /* 429: a tiny reset is waited out inline; a long one backs off. */
  fake.rateLimit = 1;
  fake.rateReset = "0.2";
  let t0 = Date.now();
  sum = await svc.pollNow();
  check(sum.auth === "ok" && !sum.stale && sum.last_error === null && Date.now() - t0 >= 200,
    "a 429 waits out X-RateLimit-Reset (0.2 s) and retries", { ms: Date.now() - t0, sum });
  fake.rateLimit = 1;
  fake.rateReset = "3600";
  sum = await svc.pollNow();
  check(sum.auth === "ok" && sum.stale === true && /rate limited/.test(sum.last_error ?? "") && sum.recovery.score === 72,
    "a 429 resetting in an hour is not waited inline: stale, cached data still served", sum);
  fake.rateLimit = 0;

  /* Pending / missing / unscorable through the real calls. */
  fake.recovery[CUR.id] = REC_PENDING;
  fake.hits.length = 0;
  sum = await svc.pollNow();
  check(sum.recovery.is_current_cycle === false && sum.recovery.score === 42 && fake.hits.includes(`/developer/v2/cycle/${PREV.id}/recovery`),
    "pending today: the previous cycle's recovery is fetched and shown", sum.recovery);
  delete fake.recovery[CUR.id];
  delete fake.sleep[CUR.id];
  sum = await svc.pollNow();
  check(sum.recovery.is_current_cycle === false && sum.recovery.score === 42 && sum.sleep.state === "missing" && sum.sleep.hours_slept === null,
    "a 404 recovery is missing (falls back) and a 404 sleep is missing", { r: sum.recovery, s: sum.sleep });
  fake.recovery[CUR.id] = REC_UNSCORABLE;
  fake.hits.length = 0;
  sum = await svc.pollNow();
  check(sum.recovery.state === "unscorable" && sum.recovery.is_current_cycle && !fake.hits.includes(`/developer/v2/cycle/${PREV.id}/recovery`),
    "unscorable today: shown as such, previous not fetched", sum.recovery);
  resetData();
  sum = await svc.pollNow();
  check(sum.recovery.score === 72 && sum.recovery.is_current_cycle, "back to scored");

  /* invalid_grant -> reauth_required, cached data served stale, no retries. */
  fake.access.clear();
  fake.refresh.clear();
  r0 = fake.refreshCalls;
  sum = await svc.pollNow();
  check(sum.auth === "reauth_required" && sum.stale === true && sum.recovery.score === 72 && /invalid_grant/.test(sum.last_error ?? "")
    && fake.refreshCalls - r0 === 1, "invalid_grant: reauth_required, cached recovery still served, marked stale", sum);
  fake.hits.length = 0;
  sum = await svc.pollNow();
  check(sum.auth === "reauth_required" && fake.refreshCalls - r0 === 1 && fake.hits.length === 0,
    "after reauth_required, polls stop hitting WHOOP until the credentials change", { calls: fake.refreshCalls - r0, hits: fake.hits });
  await seedCreds();
  sum = await svc.pollNow();
  check(sum.auth === "ok" && sum.stale === false && sum.last_error === null, "a fresh login (new credentials file) resumes polling without a restart", sum);

  /* Cache survives a new instance. */
  const fetched = sum.fetched_at;
  const svc2 = service();
  const cached = svc2.summary();
  check(cached.fetched_at === fetched && cached.recovery.score === 72 && cached.sleep.hours_slept === 7.25 && cached.auth === "ok" && cached.stale === false,
    "a new instance answers from the disk cache before polling", cached);
  const svc3 = service({ cachePath: join(tmp, "nope", "cache.json") });
  check(svc3.summary().fetched_at === null && svc3.summary().recovery.state === "missing", "no cache file: empty summary, no throw");

  /* The intraday strain series through real polls, on its own cache file. */
  const seriesCache = join(tmp, "series", "whoop-cache.json");
  const sv = service({ cachePath: seriesCache });
  sum = await sv.pollNow();
  check(JSON.stringify(sum.strain_today) === JSON.stringify({ cycle_start: CUR.start, wake: SLEEP.end, points: [{ t: sum.fetched_at, strain: 8.4 }] }),
    "first poll: one point at the poll time with the current strain", sum.strain_today);
  sum = await sv.pollNow();
  check(sum.strain_today.points.length === 1, "a second poll with the same strain adds nothing", sum.strain_today.points);
  fake.cycles = [{ ...CUR, score: { ...CUR.score, strain: 8.44 } }, ...CYCLES.slice(1)];
  sum = await sv.pollNow();
  check(sum.strain_today.points.length === 1, "a change below 0.05 (same at 1 dp) adds nothing", sum.strain_today.points);
  fake.cycles = [{ ...CUR, score: { ...CUR.score, strain: 9.06 } }, ...CYCLES.slice(1)];
  sum = await sv.pollNow();
  check(sum.strain_today.points.length === 2 && sum.strain_today.points[1].strain === 9.1 && sum.strain_today.points[1].t === sum.fetched_at
    && sum.strain.day_strain === 9.1 && sum.week.at(-1).strain === 9.1,
    "a changed strain appends a point stamped with fetched_at", sum.strain_today.points);
  const seriesBefore = JSON.stringify(sum.strain_today);
  const disk = JSON.parse(readFileSync(seriesCache, "utf8"));
  check(disk.strain_series?.cycle_id === CUR.id && disk.strain_series.points.length === 2 && mode(seriesCache) === 0o600,
    "the series is persisted in the cache file (mode 600)", disk.strain_series);
  const svNext = service({ cachePath: seriesCache });
  check(JSON.stringify(svNext.summary().strain_today) === seriesBefore, "a new instance serves the series from the cache before polling",
    svNext.summary().strain_today);
  sum = await svNext.pollNow();
  check(sum.strain_today.points.length === 2, "and keeps appending to it rather than starting over", sum.strain_today.points);
  const NEXT = { ...CUR, id: CUR.id + 1, start: "2026-10-10T06:30:00.000Z", updated_at: "2026-10-10T06:31:00.000Z", score: { ...CUR.score, strain: 0.2 } };
  fake.cycles = [NEXT, { ...CUR, end: NEXT.start }, ...CYCLES.slice(1)];
  sum = await svNext.pollNow();
  check(sum.strain_today.cycle_start === NEXT.start && sum.strain_today.points.length === 1 && sum.strain_today.points[0].strain === 0.2
    && sum.strain_today.wake === null && sum.workouts_today.length === 0 && sum.week.length === 7 && sum.week.at(-1).day === "2026-10-10",
    "a new cycle id resets the series; no sleep yet means wake null; workouts before the new start drop out", sum);
  /* A full cached series plus one change: still 400, the oldest dropped. */
  const full = { cycle_id: NEXT.id, points: Array.from({ length: 400 }, (_, i) => ({ t: new Date(Date.parse(NEXT.start) + i * 60_000).toISOString(), strain: i % 2 ? 1 : 2 })) };
  writeFileSync(seriesCache, JSON.stringify({ ...JSON.parse(readFileSync(seriesCache, "utf8")), strain_series: full }));
  const svFull = service({ cachePath: seriesCache });
  fake.cycles = [{ ...NEXT, score: { ...NEXT.score, strain: 3.3 } }, ...fake.cycles.slice(1)];
  sum = await svFull.pollNow();
  check(sum.strain_today.points.length === 400 && sum.strain_today.points[0].t === full.points[1].t && sum.strain_today.points.at(-1).strain === 3.3,
    "the series is capped at 400 points through the service, oldest dropped", { n: sum.strain_today.points.length, first: sum.strain_today.points[0] });
  fake.workouts = WORKOUTS;
  fake.cycles = CYCLES;
  sum = await sv.pollNow();
  check(sum.workout?.sport === "cycling" && sum.workouts_today.map(w => w.sport).join() === "running,cycling",
    "workouts limit 10: the latest workout is the newest record, workouts_today the current cycle's, oldest first", sum.workouts_today);
  resetData();

  /* Malformed credentials -> auth error. */
  const badPath = join(tmp, "bad", "credentials.json");
  await H.saveCredentials(badPath, H.emptyCredentials());
  writeFileSync(badPath, "{not json");
  const svcBad = service({ credentialsPath: badPath });
  sum = await svcBad.pollNow();
  check(sum.auth === "error" && /not valid JSON/.test(sum.last_error ?? ""), "malformed credentials: auth error with the reason", sum);

  /* start() schedules; stop() clears. */
  svc.start();
  await sleep(150);
  sum = svc.summary();
  const next = Date.parse(sum.next_poll_at ?? "");
  check(Number.isFinite(next) && next > Date.now() && next <= Date.now() + 15 * MIN + 1000, "start() polls and schedules the next poll", sum.next_poll_at);
  svc.stop();
  check(svc.summary().next_poll_at === null, "stop() clears the schedule");

  /* ---------- 4. real GatewayServer ---------- */

  const cliCred = join(tmp, "cli-whoop", "credentials.json");
  const mainTokenPath = join(tmp, "gateway-token");
  const tokenLogs = [];
  const mainToken = H.loadOrCreateToken(mainTokenPath, m => tokenLogs.push(m));
  const readToken = H.loadOrCreateToken(join(tmp, "whoop-read-token"), m => tokenLogs.push(m), "WHOOP READ TOKEN", "enroll this on the watch");
  const MAIN = readFileSync(mainTokenPath, "utf8").trim();
  const READ = readFileSync(join(tmp, "whoop-read-token"), "utf8").trim();
  check(READ.length === 48 && READ !== MAIN && mode(join(tmp, "whoop-read-token")) === 0o600 && tokenLogs.some(l => l === `WHOOP READ TOKEN: ${READ}`),
    "read-only token minted by loadOrCreateToken: 48 hex, mode 600, own label in the log");

  const gwLogs = [];
  const gwWhoop = service({ credentialsPath: cliCred, log: m => gwLogs.push(m) });
  const server = new H.GatewayServer({
    config: {
      vault: join(tmp, "vault"), port: 0, bind: "127.0.0.1", tokenFile: mainTokenPath, maxChildren: 1,
      approvalTimeoutS: 1, claudePath: "/usr/bin/false", stateMirrorPath: join(tmp, "state-mirror"), healthDb: join(tmp, "server", "health.sqlite"),
      whoopCredentials: cliCred, whoopCache: cachePath, whoopReadTokenFile: join(tmp, "whoop-read-token"),
    },
    registry: {},
    token: mainToken,
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
  const gw = `http://127.0.0.1:${gwPort}`;
  const call = async (method, path, token) => {
    const res = await fetch(`${gw}${path}`, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, json: await res.json().catch(() => null) };
  };

  try {
    let res = await call("GET", "/whoop/summary", READ);
    check(res.status === 200 && res.json?.schema === 1 && res.json.auth === "not_configured" && res.json.recovery?.state !== undefined
      && Array.isArray(res.json.week) && Array.isArray(res.json.strain_today?.points) && Array.isArray(res.json.workouts_today),
      "read token: GET /whoop/summary is 200 (status in the body, history fields present)", res);
    res = await call("GET", "/health", READ);
    check(res.status === 401, "read token: GET /health is 401", res);
    res = await call("POST", "/whoop/poll", READ);
    check(res.status === 401, "read token: POST /whoop/poll is 401", res);
    res = await call("POST", "/whoop/summary", READ);
    check(res.status === 401, "read token: POST /whoop/summary is 401 (GET only)", res);
    res = await call("GET", "/apple-health/status", READ);
    check(res.status === 401, "read token: GET /apple-health/status is 401", res);
    res = await call("GET", "/whoop/summary", null);
    check(res.status === 401, "no token: 401", res);
    res = await call("GET", "/whoop/summary", "nope");
    check(res.status === 401, "wrong token: 401", res);
    res = await call("GET", "/whoop/summary", MAIN);
    check(res.status === 200 && res.json?.schema === 1, "main token: GET /whoop/summary is 200", res);
    res = await call("POST", "/whoop/poll", MAIN);
    check(res.status === 200 && res.json?.auth === "not_configured", "main token: POST /whoop/poll is 200 with the summary", res);

    /* ---------- 5. whoop-auth end to end ---------- */

    const cliPath = join(tmp, "whoop-auth.js");
    const freePort = async () => {
      const s = createServer();
      await new Promise(r => s.listen(0, "127.0.0.1", r));
      const p = s.address().port;
      await new Promise(r => s.close(r));
      return p;
    };
    const cbPort = await freePort();
    const deadPort = await freePort();
    const cliEnv = (over = {}) => ({
      ...process.env,
      TZ: "America/Los_Angeles",
      WHOOP_CREDENTIALS_FILE: cliCred,
      WHOOP_API_BASE: fakeBase,
      VAULT_GATEWAY_WHOOP_CACHE: cachePath,
      VAULT_GATEWAY_TOKEN_FILE: mainTokenPath,
      VAULT_GATEWAY_BIND: "127.0.0.1",
      VAULT_GATEWAY_PORT: String(gwPort),
      /* Print the consent URL instead of running `open`: no browser opens. */
      SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 22",
      ...over,
    });
    const runCli = (args, env = cliEnv()) => {
      const child = spawn(process.execPath, [cliPath, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
      const io = { out: "", err: "", child };
      child.stdout.on("data", d => { io.out += d; });
      child.stderr.on("data", d => { io.err += d; });
      io.done = new Promise(r => child.on("close", code => r(code)));
      io.exit = (ms = 20_000) => Promise.race([io.done, sleep(ms).then(() => { child.kill(); return "timeout"; })]);
      io.waitFor = async (re, ms = 10_000) => {
        const end = Date.now() + ms;
        while (!re.test(io.out)) {
          if (Date.now() > end) throw new Error(`timed out waiting for ${re} in:\n${io.out}\n${io.err}`);
          await sleep(20);
        }
        return re.exec(io.out);
      };
      return io;
    };
    /* The test plays the browser. The CLI prints its wait line just before it
       binds, so retry a refused connection briefly. */
    const browse = async url => {
      for (let i = 0; ; i++) {
        try {
          const res = await fetch(url);
          return { status: res.status, text: await res.text() };
        } catch (err) {
          if (i > 50) throw err;
          await sleep(40);
        }
      }
    };

    /* set-client from piped stdin. */
    const setClient = runCli(["set-client"]);
    setClient.child.stdin.end(`${CLIENT_ID}\n${CLIENT_SECRET}\n`);
    let code = await setClient.exit();
    let c = existsSync(cliCred) ? readCreds(cliCred) : {};
    check(code === 0 && c.client_id === CLIENT_ID && c.client_secret === CLIENT_SECRET && c.access_token === null && mode(cliCred) === 0o600,
      "whoop-auth set-client stores the prompted id/secret, mode 600", { code, err: setClient.err, c });
    check(!setClient.out.includes(CLIENT_SECRET), "the secret is never echoed", setClient.out);

    /* login: wrong state rejected, right one accepted. */
    const redirectUri = `http://localhost:${cbPort}/whoop/callback`;
    fake.codes.add("good-code");
    const login = runCli(["login", "--redirect-uri", redirectUri]);
    const [authUrlText] = await login.waitFor(/http:\/\/127\.0\.0\.1:\d+\/oauth\/oauth2\/auth\?\S+/);
    const authUrl = new URL(authUrlText);
    const state = authUrl.searchParams.get("state") ?? "";
    check(login.out.includes(`Redirect URI (register exactly this on the WHOOP app): ${redirectUri}`), "login prints the exact redirect URI to register", login.out);
    check(/^[A-Za-z0-9]{8}$/.test(state) && authUrl.searchParams.get("client_id") === CLIENT_ID && authUrl.searchParams.get("response_type") === "code"
      && authUrl.searchParams.get("redirect_uri") === redirectUri
      && authUrl.searchParams.get("scope") === "read:recovery read:cycles read:sleep read:workout read:profile read:body_measurement offline",
      "authorize URL: client, code flow, redirect, all scopes incl. offline, 8-char alphanumeric state", authUrlText);
    await login.waitFor(/Waiting for the redirect/);
    const wrong = await browse(`http://127.0.0.1:${cbPort}/whoop/callback?code=good-code&state=${state === "AAAAAAAA" ? "BBBBBBBB" : "AAAAAAAA"}`);
    check(wrong.status === 400 && /state does not match/.test(wrong.text) && fake.exchangeCalls === 0, "a redirect with the wrong state is rejected (400), no exchange", wrong);
    const right = await browse(`http://127.0.0.1:${cbPort}/whoop/callback?code=good-code&state=${state}`);
    check(right.status === 200 && /connected/i.test(right.text), "the redirect with the right state is accepted", right);
    code = await login.exit();
    c = readCreds(cliCred);
    check(code === 0 && fake.exchangeCalls === 1 && fake.lastRedirect === redirectUri && c.access_token === `acc-${fake.n}` && c.refresh_token === `ref-${fake.n}`
      && c.redirect_uri === redirectUri && mode(cliCred) === 0o600, "login exchanges the code and saves the tokens (mode 600)", { code, err: login.err, c });
    check(/Ignored a redirect: state does not match/.test(login.out) && /Connected as Test Athlete <athlete@example\.com>\./.test(login.out),
      "login reports the ignored redirect and who is connected", login.out);
    check(/Gateway polled WHOOP: Recovery 72% \(green\) \| Strain 8\.4/.test(login.out) && gwWhoop.summary().auth === "ok",
      "login pokes POST /whoop/poll on the gateway and prints the summary line", login.out);

    const status = runCli(["status"]);
    code = await status.exit();
    check(code === 0 && /Tokens:\s+connected/.test(status.out) && /Client:\s+test-client/.test(status.out) && /Recovery 72%/.test(status.out)
      && !status.out.includes(CLIENT_SECRET) && !status.out.includes(c.access_token), "status: configured, expiry, last summary, no secrets", status.out);

    /* Pasted redirect URL (the SSH path) with the gateway down. */
    fake.codes.add("paste-code");
    const paste = runCli(["login"], cliEnv({ VAULT_GATEWAY_PORT: String(deadPort) }));
    const [pasteUrlText] = await paste.waitFor(/http:\/\/127\.0\.0\.1:\d+\/oauth\/oauth2\/auth\?\S+/);
    const pasteState = new URL(pasteUrlText).searchParams.get("state");
    await paste.waitFor(/Waiting for the redirect/);
    paste.child.stdin.write(`${redirectUri}?code=paste-code&state=ZZZZZZZ9\n`);
    await paste.waitFor(/Ignored that URL: state does not match/);
    paste.child.stdin.write(`${redirectUri}?code=paste-code&state=${pasteState}\n`);
    code = await paste.exit();
    check(code === 0 && readCreds(cliCred).access_token === `acc-${fake.n}` && /did not answer/.test(paste.out),
      "a pasted redirect URL completes the login; an unreachable gateway is reported, not fatal", { code, out: paste.out, err: paste.err });
    sum = await gwWhoop.pollNow();
    check(sum.auth === "ok" && !sum.stale, "the daemon picks up the re-login on its next poll", sum);

    /* A refused authorization ends the login with an error. */
    const refused = runCli(["login"]);
    const [refusedUrl] = await refused.waitFor(/http:\/\/127\.0\.0\.1:\d+\/oauth\/oauth2\/auth\?\S+/);
    await refused.waitFor(/Waiting for the redirect/);
    const denied = await browse(`http://127.0.0.1:${cbPort}/whoop/callback?error=access_denied&state=${new URL(refusedUrl).searchParams.get("state")}`);
    code = await refused.exit();
    check(denied.status === 400 && code === 1 && /refused the authorization: access_denied/.test(refused.err), "error=access_denied ends the login with exit 1",
      { code, err: refused.err });
    check(readCreds(cliCred).access_token === `acc-${fake.n}`, "a refused login leaves the saved tokens alone");

    /* logout */
    const logout = runCli(["logout"]);
    code = await logout.exit();
    c = readCreds(cliCred);
    check(code === 0 && c.access_token === null && c.refresh_token === null && c.client_id === CLIENT_ID && c.client_secret === CLIENT_SECRET,
      "logout removes the tokens and keeps the client", c);
    sum = await gwWhoop.pollNow();
    check(sum.auth === "not_configured", "after logout the daemon reports not_configured", sum.auth);
  } finally {
    gwWhoop.stop();
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
