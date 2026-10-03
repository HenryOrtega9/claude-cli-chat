/* Offline test for the Apple Health half of the gateway.
   Contract: docs/ios-gateway/APPLE-HEALTH.md.

   Touches nothing live: no launchd job, no real database, no real vault. It
   bundles the gateway sources with esbuild into a temp directory (a test
   entry plus the CLI, built the same way build.mjs builds dist/), then runs
   everything against a temp SQLite file and a temp vault:

     1. Ingest upsert idempotency, deletion, daily stats upsert
     2. Two-source sleep night (Watch + iPhone overlapping) counts one source
     3. Night Of attribution across midnight (and a noon nap)
     4. Total Energy = Resting + Active; body fat fraction shown as percent
     5. Payload validation (bad uuid / date / oversize batch)
     6. The note renders and is written atomically into the temp vault
     7. The CLI: weekly-csv headers match the vault's export prompt exactly,
        Sunday-to-Saturday weeks (default = last completed week on a Sunday,
        a Saturday and a weekday), --from/--to ranges and their validation,
        daily/samples/status work, sql refuses writes, missing DB message
     8. The real GatewayServer class on an ephemeral 127.0.0.1 port: 401
        without the token, 400 on a malformed payload, 200 on a good one,
        GET status, 413 on an oversize body (declared and chunked)

   Usage: node daemons/gateway/test/apple-health.mjs */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import builtins from "builtin-modules";

process.env.TZ = "America/Los_Angeles";

const here = dirname(fileURLToPath(import.meta.url));
const gatewayDir = resolve(here, "..");
const tmp = mkdtempSync(join(tmpdir(), "apple-health-test-"));
const dbPath = join(tmp, "db", "apple-health.sqlite");
const vault = join(tmp, "vault");
const REAL_VAULT = "/Users/henryortega/Library/Mobile Documents/iCloud~md~obsidian/Documents/Henry Ortega's Second Brain";

let failures = 0;
let passes = 0;
function pass(msg) { passes++; console.log(`PASS  ${msg}`); }
function fail(msg) { failures++; console.log(`FAIL  ${msg}`); }
function check(cond, msg, detail) { cond ? pass(msg) : fail(detail === undefined ? msg : `${msg}\n      got: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`); return cond; }

/* ---------- bundle ---------- */

const external = [...builtins, ...builtins.map(b => `node:${b}`), "node:sqlite", "obsidian", "electron"];
const common = { bundle: true, platform: "node", target: "node24", format: "cjs", external, logLevel: "warning" };
await build({
  ...common,
  stdin: {
    contents: `
      export * from "./src/apple-health/store";
      export * from "./src/apple-health/derive";
      export * from "./src/apple-health/note";
      export { AppleHealthService } from "./src/apple-health/service";
      export { GatewayServer } from "./src/server";
    `,
    resolveDir: gatewayDir,
    loader: "ts",
    sourcefile: "apple-health-test-entry.ts",
  },
  outfile: join(tmp, "bundle.cjs"),
});
await build({
  ...common,
  entryPoints: [join(gatewayDir, "src/apple-health/cli.ts")],
  outfile: join(tmp, "apple-health.js"),
  banner: { js: "#!/usr/bin/env node" },
});
const H = createRequire(import.meta.url)(join(tmp, "bundle.cjs"));

/* ---------- fixtures ---------- */

const SRC_WATCH = { name: "Henry's Apple Watch", bundleId: "com.apple.health.WATCH-1", version: "11.0" };
const SRC_PHONE = { name: "Henry's iPhone", bundleId: "com.apple.health.PHONE-1", version: "26.0" };

function sample(over) {
  return {
    uuid: randomUUID().toUpperCase(),
    kind: "quantity",
    type: "HKQuantityTypeIdentifierHeartRate",
    start: "2026-09-23T07:12:03.000-07:00",
    end: "2026-09-23T07:12:03.000-07:00",
    value: 62,
    unit: "count/min",
    category: null,
    categoryLabel: null,
    source: SRC_WATCH,
    deviceName: "Apple Watch",
    deviceModel: "Watch",
    metadata: null,
    workout: null,
    ...over,
  };
}

function sleepSample(start, end, category, label, source) {
  return sample({
    kind: "category", type: "HKCategoryTypeIdentifierSleepAnalysis", start, end,
    value: null, unit: null, category, categoryLabel: label, source,
  });
}

function payload(over) {
  return {
    schema: 1,
    batchId: randomUUID(),
    device: { name: "Henry's iPhone", model: "iPhone", systemVersion: "26.0", timeZone: "America/Los_Angeles" },
    ...over,
  };
}

function daily(date, type, fields) {
  return { date, type, unit: null, sum: null, avg: null, min: null, max: null, mostRecent: null, ...fields };
}

/* ---------- 1. store: upsert, delete, daily ---------- */

const store = new H.HealthStore(dbPath);
const db = store.db;
const count = (sql, ...p) => Number(Object.values(db.prepare(sql).get(...p))[0]);

const hr = sample({ value: 62 });
const hr2 = sample({ value: 70, start: "2026-09-23T08:00:00.000-07:00", end: "2026-09-23T08:00:00.000-07:00" });
let r = store.ingest(H.validatePayload(payload({ samples: [hr, hr2] })));
check(r.samples === 2 && r.deleted === 0 && r.daily === 0, "ingest reports upserted counts", r);
store.ingest(H.validatePayload(payload({ samples: [hr, hr2] })));
check(count("SELECT COUNT(*) FROM samples") === 2, "re-ingesting the same batch is idempotent (2 rows, not 4)");
store.ingest(H.validatePayload(payload({ samples: [{ ...hr, value: 65, uuid: hr.uuid.toLowerCase() }] })));
check(count("SELECT COUNT(*) FROM samples") === 2 && count("SELECT value FROM samples WHERE uuid = ?", hr.uuid) === 65,
  "upsert by uuid updates in place (uuid case-insensitive)");
check(count("SELECT COUNT(*) FROM ingest_log") === 3, "every batch lands in ingest_log");

r = store.ingest(H.validatePayload(payload({ deleted: [{ uuid: hr2.uuid, type: hr2.type }] })));
check(r.deleted === 1 && count("SELECT COUNT(*) FROM samples WHERE uuid = ?", hr2.uuid) === 0, "deleted[] removes the sample row", r);
check(r.deletedFrom === "2026-09-23", "deletedFrom is the deleted sample's local date", r);
r = store.ingest(H.validatePayload(payload({ deleted: [{ uuid: hr2.uuid, type: hr2.type }] })));
check(r.deleted === 0 && r.deletedFrom === null, "deleting an absent uuid is a no-op with deletedFrom null", r);
const early = sample({ start: "2026-09-20T23:30:00.000-07:00", end: "2026-09-20T23:30:00.000-07:00" });
const late = sample({ start: "2026-09-22T08:00:00.000-07:00", end: "2026-09-22T08:00:00.000-07:00" });
store.ingest(H.validatePayload(payload({ samples: [early, late] })));
r = store.ingest(H.validatePayload(payload({ deleted: [{ uuid: late.uuid }, { uuid: randomUUID() }, { uuid: early.uuid }] })));
check(r.deleted === 2 && r.deletedFrom === "2026-09-20", "deletedFrom is the MIN local date across matched deletions (local, not UTC)", r);

store.ingest(H.validatePayload(payload({ daily: [daily("2026-09-22", "HKQuantityTypeIdentifierStepCount", { unit: "count", sum: 100 })] })));
r = store.ingest(H.validatePayload(payload({ daily: [daily("2026-09-22", "HKQuantityTypeIdentifierStepCount", { unit: "count", sum: 9123 })] })));
check(r.daily === 1 && count("SELECT COUNT(*) FROM daily_stats") === 1 && count("SELECT sum FROM daily_stats") === 9123,
  "daily stats upsert on (date, type)");

/* A sample added and deleted in the same batch ends up deleted. */
const transient = sample({});
store.ingest(H.validatePayload(payload({ samples: [transient], deleted: [{ uuid: transient.uuid }] })));
check(count("SELECT COUNT(*) FROM samples WHERE uuid = ?", transient.uuid) === 0, "upserts run before deletions within a batch");

/* ---------- 2/3. sleep ---------- */

const sleep = [
  /* Night of Tue 2026-09-22: the Watch stages it, the iPhone logs one 8 h
     asleepUnspecified block over the same span. */
  sleepSample("2026-09-22T22:50:00.000-07:00", "2026-09-22T23:00:00.000-07:00", 0, "inBed", SRC_WATCH),
  sleepSample("2026-09-22T23:00:00.000-07:00", "2026-09-23T01:00:00.000-07:00", 3, "asleepCore", SRC_WATCH),
  sleepSample("2026-09-23T01:00:00.000-07:00", "2026-09-23T02:00:00.000-07:00", 4, "asleepDeep", SRC_WATCH),
  sleepSample("2026-09-23T02:00:00.000-07:00", "2026-09-23T03:00:00.000-07:00", 2, "awake", SRC_WATCH),
  sleepSample("2026-09-23T03:00:00.000-07:00", "2026-09-23T04:00:00.000-07:00", 5, "asleepREM", SRC_WATCH),
  sleepSample("2026-09-23T04:00:00.000-07:00", "2026-09-23T06:30:00.000-07:00", 3, "asleepCore", SRC_WATCH),
  sleepSample("2026-09-22T22:30:00.000-07:00", "2026-09-23T06:30:00.000-07:00", 1, "asleepUnspecified", SRC_PHONE),
  /* Night of Wed 2026-09-23 begins after midnight: 00:30 Thursday. */
  sleepSample("2026-09-24T00:30:00.000-07:00", "2026-09-24T06:30:00.000-07:00", 3, "asleepCore", SRC_WATCH),
  /* An afternoon nap on Thursday belongs to Thursday's night. */
  sleepSample("2026-09-24T13:00:00.000-07:00", "2026-09-24T13:30:00.000-07:00", 3, "asleepCore", SRC_WATCH),
];
store.ingest(H.validatePayload(payload({ samples: sleep })));
const nights = H.sleepNights(db, "2026-09-21", "2026-09-27");
const n22 = nights.find(n => n.night === "2026-09-22");
check(n22 && Math.abs(n22.totalHrs - 6.5) < 1e-9 && n22.source === SRC_WATCH.name,
  "two-source night counts only the Watch: 6.5 h, not 6.5 + 8", n22);
check(n22 && Math.abs(n22.coreHrs - 4.5) < 1e-9 && Math.abs(n22.deepHrs - 1) < 1e-9 && Math.abs(n22.remHrs - 1) < 1e-9,
  "stage split core 4.5 / deep 1 / REM 1 (inBed and awake excluded)", n22);
check(H.nightOf("2026-09-24T00:30:00") === "2026-09-23" && H.nightOf("2026-09-23T11:59:59") === "2026-09-22"
  && H.nightOf("2026-09-23T12:00:00") === "2026-09-23", "nightOf: before 12:00 belongs to the previous date");
const n23 = nights.find(n => n.night === "2026-09-23");
const n24 = nights.find(n => n.night === "2026-09-24");
check(n23 && Math.abs(n23.totalHrs - 6) < 1e-9, "a sleep starting 00:30 Thursday is Night Of Wednesday", n23);
check(n24 && Math.abs(n24.totalHrs - 0.5) < 1e-9, "a 13:00 nap is Night Of its own date", n24);
check(!H.sleepNights(db, "2026-09-23", "2026-09-23").some(n => n.night === "2026-09-22"),
  "night window excludes the previous night even though its samples end on the first day");

/* iPhone-only night: no staged time anywhere, falls back to the most total. */
store.ingest(H.validatePayload(payload({ samples: [
  sleepSample("2026-09-25T23:00:00.000-07:00", "2026-09-26T06:00:00.000-07:00", 1, "asleepUnspecified", SRC_PHONE),
] })));
const n25 = H.sleepNights(db, "2026-09-25", "2026-09-25")[0];
check(n25 && Math.abs(n25.totalHrs - 7) < 1e-9, "an unstaged (iPhone-only) night still totals asleepUnspecified", n25);

/* ---------- 4. daily metrics, body comp, workouts ---------- */

const D = "2026-09-23";
store.ingest(H.validatePayload(payload({
  daily: [
    daily(D, "HKQuantityTypeIdentifierBasalEnergyBurned", { unit: "kcal", sum: 2400.4 }),
    daily(D, "HKQuantityTypeIdentifierActiveEnergyBurned", { unit: "kcal", sum: 650.2 }),
    daily(D, "HKQuantityTypeIdentifierRestingHeartRate", { unit: "count/min", avg: 61, min: 61, max: 61, mostRecent: 61 }),
    daily(D, "HKQuantityTypeIdentifierHeartRateVariabilitySDNN", { unit: "ms", avg: 44.26 }),
    daily(D, "HKQuantityTypeIdentifierHeartRate", { unit: "count/min", avg: 80, min: 52, max: 171 }),
    daily(D, "HKQuantityTypeIdentifierStepCount", { unit: "count", sum: 10234 }),
    daily(D, "HKQuantityTypeIdentifierAppleExerciseTime", { unit: "min", sum: 42 }),
    daily("2026-09-24", "HKQuantityTypeIdentifierActiveEnergyBurned", { unit: "kcal", sum: 300 }),
  ],
  samples: [
    sample({ type: "HKQuantityTypeIdentifierVO2Max", value: 38.4, unit: "ml/kg*min", start: "2026-09-20T09:00:00.000-07:00", end: "2026-09-20T09:00:00.000-07:00" }),
    sample({ type: "HKQuantityTypeIdentifierBodyMass", value: 229.0, unit: "lb", start: "2026-09-23T06:00:00.000-07:00", end: "2026-09-23T06:00:00.000-07:00", source: SRC_PHONE }),
    sample({ type: "HKQuantityTypeIdentifierBodyMass", value: 228.2, unit: "lb", start: "2026-09-23T13:07:00.000-07:00", end: "2026-09-23T13:07:00.000-07:00", source: SRC_PHONE }),
    sample({ type: "HKQuantityTypeIdentifierBodyFatPercentage", value: 0.183, unit: "%", start: "2026-09-23T13:07:00.000-07:00", end: "2026-09-23T13:07:00.000-07:00", source: SRC_PHONE }),
    sample({ type: "HKQuantityTypeIdentifierLeanBodyMass", value: 186.4, unit: "lb", start: "2026-09-23T13:07:00.000-07:00", end: "2026-09-23T13:07:00.000-07:00", source: SRC_PHONE }),
    sample({ type: "HKQuantityTypeIdentifierRestingHeartRate", value: 61, unit: "count/min" }),
    sample({
      kind: "workout", type: "HKWorkoutTypeIdentifier", value: null, unit: null,
      start: "2026-09-23T17:00:00.000-07:00", end: "2026-09-23T17:30:34.000-07:00",
      workout: { activityType: 37, activityName: "running", durationSec: 1834.2, energyKcal: 412.5, distanceMi: 3.21, avgHeartRate: 151.2, maxHeartRate: 172, isIndoor: false },
    }),
    sample({
      kind: "workout", type: "HKWorkoutTypeIdentifier", value: null, unit: null,
      start: "2026-09-25T07:00:00.000-07:00", end: "2026-09-25T08:00:00.000-07:00",
      workout: { activityType: 50, activityName: "traditionalStrengthTraining", durationSec: 3600, energyKcal: 300, distanceMi: null, avgHeartRate: 110, maxHeartRate: 140, isIndoor: true },
    }),
    sample({
      kind: "workout", type: "HKWorkoutTypeIdentifier", value: null, unit: null,
      start: "2026-09-26T07:00:00.000-07:00", end: "2026-09-26T07:40:00.000-07:00",
      workout: { activityType: 52, activityName: "walking", durationSec: 2400, energyKcal: 150, distanceMi: 1.9, avgHeartRate: 100, maxHeartRate: 120, isIndoor: false },
    }),
  ],
})));

const days = H.dailyMetrics(db, "2026-09-21", "2026-09-27");
const d23 = days.find(d => d.date === D);
check(days.length === 7, "dailyMetrics returns one row per day in range", days.length);
check(d23 && Math.abs(d23.totalEnergy - 3050.6) < 1e-9, "Total Energy = basal + active (2400.4 + 650.2)", d23);
check(d23 && d23.maxHr === 171 && d23.restingHr === 61 && d23.steps === 10234 && d23.exerciseMin === 42, "max HR, resting HR, steps, exercise from daily_stats", d23);
check(days.find(d => d.date === "2026-09-24").totalEnergy === null, "Total Energy blank when Resting is missing");
const vo2Days = H.dailyMetrics(db, "2026-09-19", "2026-09-21").map(d => d.vo2Max);
check(vo2Days[0] === null && vo2Days[1] === 38.4 && vo2Days[2] === 38.4,
  "VO2 max is the most recent reading on or before the day", vo2Days);

const body = H.bodyComposition(db, "2026-09-21", "2026-09-27");
check(body.length === 1 && body[0].weightLb === 228.2 && Math.abs(body[0].bodyFatPct - 18.3) < 1e-9 && body[0].leanMassLb === 186.4,
  "body composition: one row per day, latest weight, fat fraction 0.183 shown as 18.3%", body);
check(H.bodyFatPercent(18.3) === 18.3, "a body fat value already in percent is not multiplied again");

const ws = H.workouts(db, "2026-09-21", "2026-09-27");
check(ws.length === 3 && ws[0].avgPace === "9:31 /mi" && ws[0].type === "Running" && ws[1].type === "Traditional Strength Training" && ws[1].avgPace === null,
  "workouts: pace m:ss /mi, readable type names, no pace without distance", ws.map(w => [w.type, w.avgPace]));

/* ---------- 5. validation ---------- */

function rejects(raw, label, pattern) {
  try {
    H.validatePayload(raw);
    fail(`${label}: accepted`);
  } catch (err) {
    check(err instanceof H.PayloadError && (!pattern || pattern.test(err.message)), label, err.message);
  }
}
rejects(null, "rejects a non-object body");
rejects(payload({ schema: 2 }), "rejects schema != 1", /schema/);
rejects(payload({ batchId: "not-a-uuid" }), "rejects a non-UUID batchId", /batchId/);
rejects(payload({ samples: [sample({ uuid: "123" })] }), "rejects a non-UUID sample uuid", /samples\[0\]\.uuid/);
rejects(payload({ samples: [sample({ start: "2026-09-23 07:12" })] }), "rejects a non-ISO start", /samples\[0\]\.start/);
rejects(payload({ samples: [sample({ start: "2026-09-23T07:12:03" })] }), "rejects an ISO time with no offset", /start/);
rejects(payload({ samples: [sample({ start: "2026-02-30T07:12:03Z" })] }), "rejects an impossible calendar date", /start/);
rejects(payload({ samples: [sample({ value: "62" })] }), "rejects a string value", /value/);
rejects(payload({ samples: [sample({ kind: "workout", workout: null })] }), "rejects a workout sample without workout details", /workout/);
rejects(payload({ samples: "nope" }), "rejects a non-array samples", /samples/);
rejects(payload({ samples: Array.from({ length: 2001 }, () => sample({})) }), "rejects more than 2,000 samples per batch", /2000/);
rejects(payload({ daily: [daily("2026-13-01", "X", {})] }), "rejects a bad daily date", /daily\[0\]\.date/);
rejects(payload({ characteristics: { wheelchairUse: "no" } }), "rejects a non-boolean wheelchairUse", /wheelchairUse/);
const noDuration = H.validatePayload(payload({ samples: [sample({ kind: "workout", start: "2026-09-23T07:00:00.000-07:00", end: "2026-09-23T07:45:00.000-07:00",
  workout: { activityType: 37, activityName: "running", durationSec: null, energyKcal: null, distanceMi: null, avgHeartRate: null, maxHeartRate: null, isIndoor: null } })] }));
check(noDuration.samples[0].workout.durationSec === 2700, "a workout with null durationSec falls back to end - start");
const bigMeta = H.validatePayload(payload({ samples: [sample({ metadata: { blob: "x".repeat(20_000) } })] }));
check(bigMeta.samples[0].metadata._dropped !== undefined, "oversized metadata is dropped, not rejected");
const zulu = H.validatePayload(payload({ samples: [sample({ start: "2026-09-24T05:30:00Z", end: "2026-09-24T05:30:00Z" })] }));
check(zulu.samples[0].startLocal === "2026-09-23T22:30:00", "a Z timestamp gets its wall clock from device.timeZone", zulu.samples[0].startLocal);

/* ---------- 6. note ---------- */

const note = H.renderHealthNote(db, { dbPath, now: new Date("2026-09-27T20:00:00-07:00") });
check(note.startsWith('---\ntitle: "Apple Health Feed"\ntype: health-note\nupdated: 2026-09-27\ntags: [health, metrics, applehealth]\n---\n'),
  "note frontmatter: title, type, updated, inline tags", note.slice(0, 160));
for (const heading of ["## Last Sync", "## Daily Metrics (last 30 days)", "## Body Composition (last 30 days)", "## Sleep (last 30 nights)",
  "## Workouts (last 30 days)", "## Data Coverage", "## How to Query More", "## Tags"]) {
  check(note.includes(`\n${heading}\n`), `note has section "${heading}"`);
}
check(note.includes("| 2026-09-23 | 228.2 | 18.3 | 186.4 |"), "note body composition row shows 18.3%");
check(note.includes("| 2026-09-23 | 2400 | 650 | 3051 | 61 | 44.3 | 171 | 38.4 | 10234 | 42 |"), "note daily row: CSV columns plus Steps and Exercise min");
check(note.includes("| 2026-09-22 | 6.50 | 1.00 | 1.00 | 4.50 | Henry's Apple Watch |"), "note sleep row uses the single source");
check(!/[—]/.test(note), "note prose has no em dashes");
check(/overwrites it/.test(note), "note says it is generated and will be overwritten");
check(!note.includes(hr.uuid), "note carries no raw sample ids");

const written = await H.writeNoteAtomic(vault, note);
check(written === join(vault, "Health/Metrics/Apple Health Feed.md") && readFileSync(written, "utf8") === note, "note written at Health/Metrics/Apple Health Feed.md");
check(readdirSync(dirname(written)).length === 1, "atomic write leaves no temp file behind", readdirSync(dirname(written)));

const logs = [];
const writer = new H.HealthNoteWriter({ vault: join(tmp, "vault2"), dbPath, db: () => db, log: m => logs.push(m), intervalMs: 60_000 });
writer.schedule();
writer.schedule();
await new Promise(res => setTimeout(res, 2300));
check(existsSync(join(tmp, "vault2", "Health/Metrics/Apple Health Feed.md")), "scheduled regeneration fires once after the settle delay", logs);
writer.dispose();
const broken = new H.HealthNoteWriter({ vault: "/dev/null/nope", dbPath, db: () => db, log: m => logs.push(m) });
await broken.flush();
check(logs.some(l => /note failed/.test(l)), "a failing note write is logged, not thrown");

/* ---------- 7. CLI ---------- */

const cliPath = join(tmp, "apple-health.js");
function cli(args, env = {}) {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, TZ: "America/Los_Angeles", VAULT_GATEWAY_HEALTH_DB: dbPath, ...env },
  });
  return { code: res.status, out: res.stdout, err: res.stderr };
}

const weekly = cli(["weekly-csv", "--week-of", "2026-09-24"]); // Thu: week Sun 09-20 .. Sat 09-26
check(weekly.code === 0 && weekly.err === "", "weekly-csv runs with no stderr (no ExperimentalWarning)", weekly.err);
const lines = weekly.out.split("\n");
const EXPECTED = [
  "=== DAILY METRICS (2026-09-20 to 2026-09-26) ===",
  "Date, Resting Energy (kcal), Active Energy (kcal), Total Energy (kcal), Resting HR (bpm), HRV (ms), Max HR (bpm), VO2 Max (mL/min/kg)",
  "=== BODY COMPOSITION ===",
  "Date, Weight (lbs), Body Fat (%), Lean Mass (lbs)",
  "=== SLEEP (Night Of) ===",
  "Night Of, Total Sleep (hrs), Deep (hrs), REM (hrs), Core (hrs)",
  "=== WORKOUTS ===",
  "Date, Type, Duration (min), Calories, Distance (mi), Avg Pace, Avg HR (bpm), Max HR (bpm)",
  "=== WEEKLY SUMMARY ===",
  "Metric, Value",
];
const WEEKLY_SUMMARY_LABELS_OK = (ls) => H.WEEKLY_SUMMARY_ROWS.length === 13 && H.WEEKLY_SUMMARY_ROWS.every(label => ls.some(l => l.startsWith(`${label}, `)));
let cursor = -1;
const inOrder = EXPECTED.every(line => (cursor = lines.indexOf(line, cursor + 1)) >= 0);
check(inOrder, "weekly-csv section titles and headers appear exactly and in order", weekly.out);

/* Cross-check against the vault's own export prompt when the vault is on
   this machine (read only). */
const logNote = join(REAL_VAULT, "Health/Metrics/Weekly Health Log.md");
if (existsSync(logNote)) {
  const prompt = readFileSync(logNote, "utf8").split("## Weekly Export Prompt")[1]?.split("```")[1] ?? "";
  const headerLines = prompt.split("\n").filter(l => /^(Date|Night Of|Metric), /.test(l));
  check(headerLines.length === 5 && headerLines.every(h => lines.includes(h)),
    "every column header line in the vault's Weekly Export Prompt is reproduced character for character", headerLines);
  const summaryRows = prompt.split("Include these exact rows:")[1]?.split("Export this as")[0].split("\n").map(l => l.trim()).filter(Boolean) ?? [];
  check(summaryRows.length === 13 && summaryRows.every(label => lines.some(l => l.startsWith(`${label}, `))),
    "every WEEKLY SUMMARY row label from the vault prompt is present", summaryRows);
} else {
  console.log("SKIP  vault Weekly Health Log not on this machine; headers checked against the embedded copy only");
}
check(lines.includes("2026-09-23, 2400, 650, 3051, 61, 44.3, 171, 38.4"), "weekly-csv daily row with Total Energy");
check(lines.includes("2026-09-21, , , , , , , 38.4"), "weekly-csv keeps empty days with blank cells");
check(lines.includes("2026-09-23, 228.2, 18.3, 186.4"), "weekly-csv body fat in percent");
check(lines.includes("2026-09-22, 6.50, 1.00, 1.00, 4.50"), "weekly-csv sleep row (single source)");
check(lines.includes("2026-09-23, Running, 30.6, 413, 3.21, 9:31 /mi, 151, 172"), "weekly-csv workout row with pace");
check(lines.includes("Total Runs, 1") && lines.includes("Total Running Distance (mi), 3.21") && lines.includes("Total Lifting Sessions, 1")
  && lines.includes("Other Workouts [list type and count], Walking x1") && lines.includes("Body Fat (%) [most recent], 18.3"),
  "weekly-csv summary counts runs, lifts and other workouts");

check(lines.filter(l => /^2026-09-\d\d, /.test(l)).length > 0 && lines.includes("2026-09-20, , , , , , , 38.4")
  && !lines.some(l => l.startsWith("2026-09-27, ") || l.startsWith("2026-09-19, ")),
  "weekly-csv --week-of covers Sunday 09-20 through Saturday 09-26 only", weekly.out);

/* Week arithmetic: Sunday-to-Saturday weeks, default = last completed week. */
const wk = (b) => `${b.start}..${b.end}`;
check(wk(H.weekBounds("2026-09-30")) === "2026-09-27..2026-10-03" && wk(H.weekBounds("2026-09-27")) === "2026-09-27..2026-10-03"
  && wk(H.weekBounds("2026-10-03")) === "2026-09-27..2026-10-03" && wk(H.weekBounds("2026-10-04")) === "2026-10-04..2026-10-10",
  "weekBounds: the Sunday-to-Saturday week containing the date");
check(wk(H.lastCompletedWeek("2026-10-04")) === "2026-09-27..2026-10-03",
  "default week on a Sunday (review day) is the week that ended yesterday", wk(H.lastCompletedWeek("2026-10-04")));
check(wk(H.lastCompletedWeek("2026-10-03")) === "2026-09-20..2026-09-26",
  "default week on a Saturday skips the incomplete current week", wk(H.lastCompletedWeek("2026-10-03")));
check(wk(H.lastCompletedWeek("2026-10-02")) === "2026-09-20..2026-09-26" && wk(H.lastCompletedWeek("2026-09-28")) === "2026-09-20..2026-09-26",
  "default week on a weekday is the last full Sunday-to-Saturday week", wk(H.lastCompletedWeek("2026-10-02")));
const defaultWeek = cli(["weekly-csv"]);
const expectDefault = H.lastCompletedWeek(new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }));
check(defaultWeek.code === 0 && defaultWeek.out.startsWith(`=== DAILY METRICS (${expectDefault.start} to ${expectDefault.end}) ===`),
  "weekly-csv with no flags exports the last completed week", defaultWeek.err || defaultWeek.out.split("\n")[0]);

/* --from/--to: any inclusive range up to 31 days, same sections and rows. */
const ranged = cli(["weekly-csv", "--from", "2026-09-22", "--to", "2026-09-23"]);
const rLines = ranged.out.split("\n");
cursor = -1;
check(ranged.code === 0 && rLines[0] === "=== DAILY METRICS (2026-09-22 to 2026-09-23) ==="
  && EXPECTED.slice(1).every(line => (cursor = rLines.indexOf(line, cursor + 1)) >= 0),
  "weekly-csv --from/--to titles the actual range and keeps every header", ranged.err || ranged.out);
check(rLines.filter(l => /^2026-09-2[23], \d/.test(l) || /^2026-09-2[23], , /.test(l)).length >= 2
  && !rLines.some(l => l.startsWith("2026-09-21, ") || l.startsWith("2026-09-24, "))
  && rLines.includes("Total Runs, 1") && rLines.includes("Total Lifting Sessions, 0"),
  "weekly-csv --from/--to includes only the range's days and workouts", ranged.out);
check(WEEKLY_SUMMARY_LABELS_OK(rLines), "weekly-csv --from/--to keeps all 13 WEEKLY SUMMARY rows");
const bad = [
  [["weekly-csv", "--from", "2026-09-22"], /go together/, "--from without --to"],
  [["weekly-csv", "--to", "2026-09-22"], /go together/, "--to without --from"],
  [["weekly-csv", "--from", "2026-09-23", "--to", "2026-09-22"], /after --to/, "--from after --to"],
  [["weekly-csv", "--from", "2026-09-01", "--to", "2026-10-02"], /at most 31 days/, "a 32-day range"],
  [["weekly-csv", "--week-of", "2026-09-22", "--from", "2026-09-20", "--to", "2026-09-26"], /not both/, "--week-of with --from/--to"],
  [["weekly-csv", "--from", "2026-09-31", "--to", "2026-10-02"], /YYYY-MM-DD/, "an invalid --from date"],
];
for (const [argv, re, what] of bad) {
  const r = cli(argv);
  check(r.code === 1 && re.test(r.err), `weekly-csv rejects ${what}`, r.err);
}
const month = cli(["weekly-csv", "--from", "2026-09-01", "--to", "2026-10-01"]);
check(month.code === 0 && month.out.startsWith("=== DAILY METRICS (2026-09-01 to 2026-10-01) ==="), "weekly-csv accepts exactly 31 days", month.err);

const dailyJson = cli(["daily", "--from", "2026-09-22", "--to", "2026-09-23", "--format", "json"]);
const parsed = dailyJson.code === 0 ? JSON.parse(dailyJson.out) : [];
check(parsed.length === 2 && Math.abs(parsed[1].totalEnergy - 3050.6) < 1e-9, "daily --format json", dailyJson.err || parsed);
const dailyMd = cli(["daily", "--from", "2026-09-23", "--to", "2026-09-23"]);
check(dailyMd.code === 0 && dailyMd.out.includes("| Steps | Exercise (min) |"), "daily defaults to a markdown table", dailyMd.out);

const hrSamples = cli(["samples", "--type", "HeartRate", "--format", "json"]);
const hrRows = hrSamples.code === 0 ? JSON.parse(hrSamples.out) : [];
check(hrRows.length >= 1 && hrRows.every(s => s.type === "HKQuantityTypeIdentifierHeartRate"),
  "samples --type HeartRate resolves to HeartRate, not RestingHeartRate", hrSamples.err || hrRows.map(s => s.type));
const sleepCsv = cli(["samples", "--type", "SleepAnalysis", "--from", "2026-09-22", "--to", "2026-09-22", "--format", "csv", "--limit", "3"]);
check(sleepCsv.code === 0 && sleepCsv.out.split("\n").filter(Boolean).length === 4 && sleepCsv.out.startsWith("uuid,kind,type,"),
  "samples --format csv honours --from/--to/--limit", sleepCsv.err || sleepCsv.out);

const status = cli(["status"]);
const st = status.code === 0 ? JSON.parse(status.out) : {};
check(st.dbPath === dbPath && st.samples === count("SELECT COUNT(*) FROM samples") && st.lastBatch && Array.isArray(st.types),
  "status prints the same shape as GET /apple-health/status", status.err || st);

const select = cli(["sql", "SELECT COUNT(*) AS n FROM samples WHERE kind = 'workout'"]);
check(select.code === 0 && select.out === "n\n3\n", "sql SELECT works (csv)", select.err || select.out);
const del = cli(["sql", "DELETE FROM samples"]);
check(del.code === 1 && /only SELECT and WITH/.test(del.err), "sql refuses DELETE", del.err);
const sneaky = cli(["sql", "SELECT 1; DELETE FROM samples"]);
check(sneaky.code === 1 && /one statement/.test(sneaky.err), "sql refuses a second statement", sneaky.err);
const cte = cli(["sql", "WITH x AS (SELECT 1) DELETE FROM samples"]);
check(cte.code === 1 && /readonly|read-only/i.test(cte.err), "a write hidden behind WITH still fails on the read-only connection", cte.err);
check(count("SELECT COUNT(*) FROM samples") > 0, "samples survive every refused write");
const missing = cli(["status"], { VAULT_GATEWAY_HEALTH_DB: join(tmp, "nope.sqlite") });
check(missing.code === 1 && /no Apple Health database at/.test(missing.err), "missing DB gives a helpful error", missing.err);
check(!existsSync(join(tmp, "nope.sqlite")), "the CLI never creates a database");

store.close();

/* ---------- 8. real GatewayServer on an ephemeral port ---------- */

const TOKEN = "test-token-0123456789";
const logLines = [];
const server = new H.GatewayServer({
  config: {
    vault: join(tmp, "vault3"), port: 0, bind: "127.0.0.1", tokenFile: join(tmp, "token"), maxChildren: 1,
    approvalTimeoutS: 1, claudePath: "/usr/bin/false", stateMirrorPath: join(tmp, "state"), healthDb: join(tmp, "server", "health.sqlite"),
  },
  registry: {},
  token: { matches: t => t === TOKEN },
  mirror: { set() {}, reflect() {} },
  claudePath: "/usr/bin/false",
  startedAt: Date.now(),
  version: "test",
  isReady: () => true,
  log: m => logLines.push(m),
});
await server.listen("127.0.0.1", 0);
const base = `http://127.0.0.1:${server.http.address().port}`;

async function post(path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...headers },
    body,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

try {
  let res = await post("/apple-health/ingest", "{}", { Authorization: "Bearer wrong" });
  check(res.status === 401, "ingest without the token is 401", res);
  res = await post("/apple-health/ingest", "{not json");
  check(res.status === 400 && res.json?.error === "bad_payload", "invalid JSON is 400 bad_payload", res);
  res = await post("/apple-health/ingest", JSON.stringify(payload({ samples: [sample({ start: "yesterday" })] })));
  check(res.status === 400 && res.json?.error === "bad_payload" && /samples\[0\]\.start/.test(res.json?.message), "malformed payload is 400 bad_payload with a path", res);
  check(!existsSync(join(tmp, "vault3", "Health")), "a rejected batch schedules no note");
  const good = payload({ samples: [hr, sample({})], deleted: [{ uuid: randomUUID(), type: "HKQuantityTypeIdentifierHeartRate" }], daily: [daily(D, "HKQuantityTypeIdentifierStepCount", { sum: 5 })] });
  res = await post("/apple-health/ingest", JSON.stringify(good));
  check(res.status === 200 && res.json?.ok === true && res.json.samples === 2 && res.json.deleted === 0 && res.json.daily === 1 && res.json.deletedFrom === null,
    "valid batch is 200 {ok, samples, deleted, daily}", res);
  const sres = await fetch(`${base}/apple-health/status`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const sjson = await sres.json();
  check(sres.status === 200 && sjson.samples === 2 && sjson.daily === 1 && sjson.lastBatch?.batchId === good.batchId
    && sjson.types.some(t => t.type === "HKQuantityTypeIdentifierHeartRate" && t.count === 2), "GET /apple-health/status", sjson);

  const big = Buffer.alloc(16 * 1024 * 1024 + 1, 0x20);
  res = await post("/apple-health/ingest", big);
  check(res.status === 413 && res.json?.error === "body_too_large", "oversize body (Content-Length) is 413 body_too_large", res);

  /* Chunked upload with no Content-Length that grows past the cap. */
  const chunked = await new Promise((resolveReq, reject) => {
    const req = request(`${base}/apple-health/ingest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "Transfer-Encoding": "chunked" },
    }, resp => {
      let text = "";
      resp.on("data", c => { text += c; });
      resp.on("end", () => resolveReq({ status: resp.statusCode, text }));
    });
    req.on("error", reject);
    const piece = Buffer.alloc(1024 * 1024, 0x20);
    for (let i = 0; i < 17; i++) req.write(piece);
    req.end();
  });
  check(chunked.status === 413 && JSON.parse(chunked.text).error === "body_too_large", "oversize chunked body is 413 body_too_large", chunked);

  res = await post("/apple-health/ingest", JSON.stringify(payload({ samples: [sample({})] })));
  check(res.status === 200, "the server still ingests after a 413", res);
  check(logLines.some(l => /apple-health ingest [0-9a-fA-F-]{36}: 2 samples/.test(l)), "ingest is logged with its batchId", logLines);
} finally {
  server.http.closeAllConnections?.();
  await server.close();
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "OK" : "FAILED"}: ${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
