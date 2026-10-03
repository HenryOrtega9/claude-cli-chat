# Apple Health sync

The iPhone app reads Apple Health through HealthKit and uploads it to the gateway daemon on the Mac mini. The daemon keeps every sample in SQLite outside the vault, writes one generated summary note into the vault, and ships an `apple-health` CLI so any Claude session on the mini can query the full history.

```
iPhone (HealthKit) --POST /apple-health/ingest--> gateway :8788 --> ~/Library/Application Support/vault-gateway/apple-health.sqlite
                                                        |--> <vault>/Health/Metrics/Apple Health Feed.md (regenerated, debounced)
                                                        '--> apple-health CLI (read-only queries, weekly CSV)
```

Raw samples stay out of the vault on purpose: the vault is a git repo inside iCloud, and raw health data must never be committed or synced through it.

## HTTP routes

Both routes use the gateway's normal Bearer auth. The prefix is `/apple-health/`, never `/health...`: `/health` is the liveness route and `NativeBridge.rpc` treats any `/health` prefix specially.

### `POST /apple-health/ingest`

Body (JSON, at most 16 MiB; the app sends batches of at most 2,000 samples or 5,000 daily rows):

```jsonc
{
  "schema": 1,
  "batchId": "UUID",                       // client-generated, logged for idempotency/debugging
  "device": { "name": "Henry's iPhone", "model": "iPhone", "systemVersion": "26.0", "timeZone": "America/Los_Angeles" },
  "samples": [ /* Sample */ ],             // optional
  "deleted": [ { "uuid": "UUID", "type": "HKQuantityTypeIdentifierStepCount" } ],  // optional
  "daily":   [ /* DailyStat */ ],          // optional
  "characteristics": {                     // optional, sent on the first sync and when changed
    "dateOfBirth": "YYYY-MM-DD" | null, "biologicalSex": "male" | "female" | "other" | null,
    "bloodType": "A+" | ... | null, "fitzpatrickSkinType": "I".."VI" | null, "wheelchairUse": true | false | null
  }
}
```

`Sample`:

```jsonc
{
  "uuid": "UUID",                          // HKObject.uuid, primary key (upsert)
  "kind": "quantity" | "category" | "workout",
  "type": "HKQuantityTypeIdentifierHeartRate",   // raw HK identifier; workouts use "HKWorkoutTypeIdentifier"
  "start": "2026-10-01T07:12:03.000-07:00",       // ISO 8601 with the device's local offset
  "end":   "2026-10-01T07:12:03.000-07:00",
  "value": 62.0 | null,                    // quantity samples only
  "unit": "count/min" | null,              // HKUnit.unitString of `value`
  "category": 3 | null,                    // category samples only: raw HKCategoryValue
  "categoryLabel": "asleepCore" | null,    // human label for the raw value when the app knows it
  "source": { "name": "Henry's Apple Watch", "bundleId": "com.apple.health.XXXX", "version": "11.0" | null },
  "deviceName": "Apple Watch" | null,      // HKDevice.name
  "deviceModel": "Watch" | null,           // HKDevice.model
  "metadata": { "HKWasUserEntered": "1" } | null,   // all values stringified
  "workout": null | {
    "activityType": 37, "activityName": "running",
    "durationSec": 1834.2, "energyKcal": 412.5 | null, "distanceMi": 3.21 | null,
    "avgHeartRate": 151.2 | null, "maxHeartRate": 172 | null, "isIndoor": false | null
  }
}
```

Units the app uses (so the server never converts): energy `kcal`, heart rate `count/min`, HRV `ms`, body mass and lean body mass `lb`, distances `mi`, body fat and other percentages `%` as a fraction (0.18 = 18%; the server multiplies by 100 for display), VO2 max `ml/kg*min`, durations `min`, everything else HealthKit's preferred unit for the type.

`DailyStat` (computed on the phone with `HKStatisticsCollectionQuery`, so HealthKit already merged overlapping iPhone and Watch sources; the server must use these for totals and never sum raw cumulative samples):

```jsonc
{ "date": "2026-10-01", "type": "HKQuantityTypeIdentifierStepCount", "unit": "count",
  "sum": 9123 | null, "avg": null, "min": null, "max": null, "mostRecent": null }
```

`date` is the local calendar day on the phone. Cumulative types fill `sum`; discrete types fill `avg`, `min`, `max`, `mostRecent`. Upsert key is `(date, type)`.

Responses: `200 {"ok":true,"samples":<upserted>,"deleted":<n>,"daily":<upserted>,"deletedFrom":"YYYY-MM-DD"|null}` (`deletedFrom` is the earliest local date among the deleted samples that existed, null when none matched; deletions never change `daily_stats`, so the app recomputes and resends daily stats from that date), `400 {"error":"bad_payload","message":...}`, `413 {"error":"body_too_large"}`.

### `GET /apple-health/status`

`200 {"dbPath", "samples": <total>, "daily": <total rows>, "lastIngestAt": ISO|null, "lastBatch": {"batchId","at","samples","deleted","daily"}|null, "types": [{"type","kind","count","first","last"}]}`

## Storage (gateway)

SQLite via the builtin `node:sqlite` (no dependency), WAL mode, at `VAULT_GATEWAY_HEALTH_DB` or `~/Library/Application Support/vault-gateway/apple-health.sqlite`. Tables: `samples` (uuid PK, every Sample field, `workout` and `metadata` as JSON text, `ingested_at`), `daily_stats` (PK date+type), `characteristics` (single row JSON), `ingest_log` (batchId, at, counts, device JSON).

## Derived metrics (shared by the vault note and the CLI)

- Daily energy, steps, exercise minutes, distances: `daily_stats.sum`. Total Energy = Resting (`BasalEnergyBurned`) + Active (`ActiveEnergyBurned`).
- Resting HR, HRV (`HeartRateVariabilitySDNN`): `daily_stats.avg`. Max HR: `daily_stats.max` of `HeartRate`. VO2 max: most recent sample on or before the day.
- Body composition: one row per day that has a `BodyMass`, `BodyFatPercentage` or `LeanBodyMass` sample (latest of each that day).
- Sleep (`HKCategoryTypeIdentifierSleepAnalysis`): group samples into nights; **Night Of = the local date the sleep started on** (a sample starting before 12:00 local belongs to the previous date's night). Within a night, use only the single source with the most staged time (`asleepCore`/`asleepDeep`/`asleepREM`) to avoid double counting the iPhone and the Watch; Total = core + deep + REM + asleepUnspecified, in hours.
- Workouts: from `samples` where `kind = 'workout'`; Avg Pace = duration / distance as `m:ss /mi`.

## Vault note

`<vault>/Health/Metrics/Apple Health Feed.md`, regenerated at most once per 60 s after an ingest. Frontmatter `title`, `type: health-note`, `updated`, `tags: [health, metrics, applehealth]`. Sections: last sync; Daily Metrics (last 30 days, same columns as the weekly CSV plus Steps and Exercise min); Body Composition (last 30 days); Sleep (last 30 nights); Workouts (last 30 days); Data Coverage (type, count, first, last); How to query more (the CLI). The note says it is generated and will be overwritten.

## CLI

`apple-health` (bundled to `daemons/gateway/dist/apple-health.js`, symlinked into `~/.local/bin`) opens the DB read-only:

- `apple-health status`
- `apple-health daily [--from D] [--to D] [--format md|csv|json]` (default: last 14 days, md)
- `apple-health weekly-csv [--week-of YYYY-MM-DD]`: the exact five-section CSV defined in the vault's Weekly Health Log export prompt, for the Monday-to-Sunday week containing the date (default: the most recent completed week; on a Sunday, the week ending today)
- `apple-health samples --type <id or suffix> [--from D] [--to D] [--limit N] [--format json|csv]`
- `apple-health sql "<SELECT ...>"` (read-only connection)

## iOS app

- Entitlements `com.apple.developer.healthkit` and `com.apple.developer.healthkit.background-delivery`; `NSHealthShareUsageDescription` (read only, the app never writes to Health).
- Reads every quantity and category type the SDK exposes on iOS 18, workouts, and characteristics. Out of scope for now: clinical records, ECG voltage, audiograms, workout routes, State of Mind.
- Per type: `HKAnchoredObjectQuery` in batches of 2,000; the anchor is persisted only after the server answers 200, so a failed upload resends. First run backfills full history, resumable.
- Daily stats: `HKStatisticsCollectionQuery` per quantity type from the last stats date minus 2 days (full history on first run).
- Background: `HKObserverQuery` + `enableBackgroundDelivery(.hourly)` per type, registered in `didFinishLaunching`; the handler syncs that type inside a `beginBackgroundTask` window. Foreground: sync on `.active` when enabled and the last sync is over 15 minutes old, plus a Sync now button. HealthKit data is unreadable while the phone is locked, so background syncs that hit a locked device just retry later.
- State (enabled flag, anchors, last sync) lives in the App Group UserDefaults, never web localStorage.

### JS <-> native bridge

| Method | Params | Reply |
|---|---|---|
| `healthStatus` | none | `HealthStatus` |
| `healthSetEnabled` | `{enabled: bool}` | `HealthStatus` (enabling requests HealthKit authorization first) |
| `healthSyncNow` | none | `HealthStatus` (starts a sync, does not wait for it) |

Native pushes `dispatch("healthSync", HealthStatus)` whenever sync progress or state changes.

`HealthStatus`: `{available: bool, enabled: bool, syncing: bool, lastSyncAt: ISO|null, lastError: string|null, progress: {typesDone, typesTotal, samplesSent}|null, totals: {samplesSent, dailySent}}`
