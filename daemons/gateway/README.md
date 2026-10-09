# Vault Gateway daemon

The Mac-side backend for the Vault Gateway iOS app. It holds the `claude` child
processes, owns the tab store, and exposes them over an authenticated HTTP +
WebSocket API on the tailnet. The phone renders; this decides.

Authoritative contract: [`docs/ios-gateway/CONTRACTS.md`](../../docs/ios-gateway/CONTRACTS.md).

## What it is

- **One process, many tabs.** Each tab owns a `claude --print --output-format
  stream-json` child, spawned through the same `SubprocessManager` /
  `TabSession` the Obsidian plugin and the desktop shell use, so wire-format
  behavior cannot drift between the three clients.
- **Session identity up front.** A tab's session UUID is generated at creation
  and passed as `--session-id` on the first spawn; every later spawn resumes it
  with `--resume`. There is no transcript discovery.
- **Bounded child budget.** At most `VAULT_GATEWAY_MAX_CHILDREN` (4) live
  children. When the budget is full, the least-recently-active tab that is
  neither busy nor holding an approval loses its child; the conversation
  survives because the next turn resumes by session id.
- **Replay, not hope.** Every frame gets a per-tab monotonic `seq`, is kept in
  an in-memory ring, and is appended to
  `<vault>/.claude-cli-chat/ios/events/<tabId>.ndjson`. A phone that reconnects
  with `since` gets exactly the frames it missed.
- **Deadlines on approvals.** An approval nobody answers within
  `VAULT_GATEWAY_APPROVAL_TIMEOUT_S` (600) is denied with
  `Client unreachable; denied by gateway timeout`, so a phone that went into a
  tunnel can't wedge a turn forever.

## Build

```sh
node daemons/gateway/build.mjs              # -> daemons/gateway/dist/gateway.js
node daemons/gateway/build.mjs --watch      # rebuild on change
node daemons/gateway/build.mjs --production # minified, no sourcemap
```

Single esbuild bundle, CJS, node builtins external. It deliberately does not go
through the repo's `esbuild.config.mjs` (that file belongs to the plugin and app
builds). The same run also writes the `apple-health`, `whoop-auth` and `whoop`
CLIs (`dist/apple-health.js`, `dist/whoop-auth.js`, `dist/whoop.js`, all
executable with a node shebang) and the Apple Health worker.

## Run it by hand

```sh
VAULT_GATEWAY_VAULT="$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents/Henry Ortega's Second Brain" \
VAULT_GATEWAY_BIND=127.0.0.1 \
VAULT_GATEWAY_PORT=8788 \
node daemons/gateway/dist/gateway.js
```

Without `VAULT_GATEWAY_BIND` it resolves the Tailscale IPv4 (CLI first,
`ifconfig` fallback for launchd sessions, 60 s of retries) and binds only that.
It never binds `0.0.0.0`.

## Enrollment: the bearer token

On first run the daemon generates 48 hex characters at
`~/.config/vault-gateway/token` (mode 600) and prints **once**:

```
VAULT GATEWAY TOKEN: <48 hex chars>
```

Under launchd that line lands in `/tmp/vault-gateway.log`. Copy it into the iOS
app's settings (it goes to the Keychain); the daemon never prints it again.

```sh
cat ~/.config/vault-gateway/token          # read it back any time
```

To rotate: `rm ~/.config/vault-gateway/token`, restart the daemon, re-enroll the
phone. Every HTTP request needs `Authorization: Bearer <token>`, `/health`
included. WebSockets can't carry a header, so the client POSTs `/ws-ticket` and
connects to `/ws/<ticket>` — single use, 60 s, in the path rather than the query
string.

## Install as a launchd agent

```sh
node daemons/gateway/build.mjs
cp daemons/gateway/dev.claude-cli-chat.vault-gateway.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.claude-cli-chat.vault-gateway.plist
```

Verify:

```sh
launchctl print gui/$(id -u)/dev.claude-cli-chat.vault-gateway | head -20
curl -s -H "Authorization: Bearer $(cat ~/.config/vault-gateway/token)" \
     "http://$(/Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4):8788/health"
tail -f /tmp/vault-gateway.log /tmp/vault-gateway.err
```

Reload after a rebuild, and stop:

```sh
launchctl kickstart -k gui/$(id -u)/dev.claude-cli-chat.vault-gateway
launchctl bootout gui/$(id -u)/dev.claude-cli-chat.vault-gateway
```

The plist pins `/usr/local/bin/node` — this machine has no
`/opt/homebrew/bin/node`. Check `which node` before editing it, and keep it
absolute: launchd agents get no login-shell PATH.

The daemon runs on port 8788 and leaves the Apple Watch bridge on 8787 alone.

## Smoke test

```sh
node daemons/gateway/test/smoke.mjs                       # against 127.0.0.1:8788
node daemons/gateway/test/smoke.mjs http://host:8790       # through tailscale serve
```

It drives a real `claude` child: creates a tab, opens a WebSocket, runs a plain
turn, runs a tool turn that requires approval and approves it, disconnects and
reconnects with `since` asserting the replay has no gaps or duplicates, then
checks the persisted tab. `daemons/gateway/test/ws-client.mjs` is a small
hand-rolled WebSocket client — Node 24's built-in one fails every plaintext
`ws://` handshake on this machine, including against a byte-identical copy of a
public server's response it accepts over `wss://`.

## WHOOP

The daemon polls the WHOOP v2 API and serves a compact summary for the watch.

| Route | Auth | Answer |
|---|---|---|
| `GET /whoop/summary` | main token **or** the WHOOP read-only token | Always 200 once authorized; `auth`, `stale` and `last_error` travel in the body |
| `POST /whoop/poll` | main token only | Polls WHOOP now (joining a poll already running) and returns the summary |
| `POST /whoop/backfill` | main token only | Forgets the backfill markers and pages through the whole history again; `200 {backfill, running, history}`, `409` while not connected, `503` without a history store |

The read-only token lives at `~/.config/vault-gateway/whoop-read-token` (48 hex,
mode 600). The daemon generates it on first start and prints
`WHOOP READ TOKEN: ...` to the log once, like the main token. It is accepted on
`GET /whoop/summary` and nowhere else, so a device holding it can read WHOOP
numbers and cannot reach a Claude session. Rotate it by deleting the file and
restarting.

Summary shape (`schema: 1`): `auth` is `ok`, `not_configured`,
`reauth_required` or `error`; `stale` is true when the last poll failed or the
data is older than 45 minutes; `recovery`, `strain` and `sleep` are always
objects (fields null when there is nothing to show) and `workout` is the latest
workout or null. Every `state` is `scored`, `pending`, `unscorable` or
`missing`. Today is the newest cycle; while its recovery is pending or absent,
the previous cycle's recovery is shown with `is_current_cycle: false`. Bands
follow WHOOP: green 67 and up, yellow 34 to 66, red 33 and below.

History for the watch complications, always present:

- `week`: up to 7 entries `{cycle_start, day, recovery, band, strain}`,
  oldest first, the last one the current cycle. `day` is the `YYYY-MM-DD` the
  cycle belongs to: the local date of its start plus 12 hours, in the cycle's
  own `timezone_offset` (the gateway's timezone when it has none), so a start
  from noon on counts as the next day (bed at 23:10 Thursday and at 00:40
  Friday are both Friday). This is `cycleDay()` in `summary.ts`, the one day
  rule the history store and the `whoop` CLI use too. `recovery` is that
  cycle's scored recovery (else null), `strain` its scored day strain at 1
  decimal (else null). `[]` with no data.
- `strain_today`: `{cycle_start, wake, points}`. The daemon records the
  current cycle's strain itself: each successful poll adds `{t, strain}` (the
  poll time) when the strain changed at 1 decimal or there is no point yet,
  and a new cycle starts a new series. At most 400 points, oldest dropped,
  kept in the cache file across restarts. `wake` is the end of the cycle's
  sleep, else null. Extend the last step to `fetched_at`, the last successful
  poll.
- `workouts_today`: `{sport, start, end, strain}` for the workouts that
  started in the current cycle, oldest first. `workout` stays the latest one.

Polling: every 5 minutes, 5 requests a poll (cycles, recoveries, the current
cycle's recovery and sleep, workouts; a 6th for the previous cycle's recovery
while today's is pending), so about 1,440 WHOOP requests a day against the
10,000 limit, backing off from 2 minutes up to 60 after errors.
Without credentials, or after a refused refresh (`reauth_required`), the daemon
only stats the credentials file once a minute. Re-running `whoop-auth` takes
effect without a restart.

Tokens: only the daemon refreshes. WHOOP refresh tokens rotate and are single
use, so every refresh happens under a lock file next to the credentials
(`credentials.lock`, stale after 30 s without a touch), re-reads the file first and adopts a
pair another writer already rotated, and writes the new pair to disk before
using it. Refreshes happen 5 minutes before expiry and once on a 401. A refused
grant (`invalid_grant`, or a 400/401 from the token endpoint) stops retries
until the credentials change; network errors and 5xx back off.

### History store

Every successful poll also upserts what it fetched (the 8 newest cycles and
recoveries, the current cycle's recovery and sleep, the 10 newest workouts)
into a SQLite file outside the vault,
`~/Library/Application Support/vault-gateway/whoop.sqlite` (WAL, a
`schema_version` table; `VAULT_GATEWAY_WHOOP_DB` overrides). A write that fails
is logged once per distinct error and never fails the poll; the store opens on
first use, so a bad path costs only the history. The per-cycle
sleep endpoint only answers the main sleep, so once an hour the newest sleep
page (limit 10) is fetched too, which is how naps and rescored nights arrive.

Tables, keyed by WHOOP's ids and written with `INSERT ... ON CONFLICT DO
UPDATE`, so a record WHOOP rescored overwrites the old copy (a copy with a
strictly older `updated_at` never overwrites a newer one):

| Table | Key | Columns |
|---|---|---|
| `cycles` | `id` | `day, start, "end", start_ms, end_ms, timezone_offset, score_state, strain, kilojoule, avg_hr, max_hr, updated_at, fetched_at, raw` |
| `recoveries` | `cycle_id` | `sleep_id, score_state, recovery_score, hrv_rmssd_ms, resting_hr, spo2_pct, skin_temp_c, user_calibrating, updated_at, fetched_at, raw` |
| `sleeps` | `id` (UUID) | `cycle_id, day, start, "end", start_ms, end_ms, timezone_offset, nap, score_state, performance_pct, efficiency_pct, consistency_pct, respiratory_rate, in_bed_ms, awake_ms, light_ms, sws_ms, rem_ms, disturbances, need_baseline_ms, need_debt_ms, need_strain_ms, need_nap_ms, updated_at, fetched_at, raw` |
| `workouts` | `id` (UUID) | `day, start, "end", start_ms, end_ms, timezone_offset, sport_name, score_state, strain, kilojoule, avg_hr, max_hr, distance_m, altitude_gain_m, zone0_ms .. zone5_ms, updated_at, fetched_at, raw` |
| `backfill` | `collection` | `next_token, pages, records, started_at, updated_at, completed_at, last_error` |
| `meta` | `key` | `value` (`last_poll_write_at`) |

`raw` is the record's JSON exactly as WHOOP sent it, so a field without a
column can be backfilled from it without refetching. `end` is an SQL keyword;
quote it (`"end"`) in queries.

`day` is stamped at write time, always through `cycleDay()`: a cycle's own
day; a sleep (naps included) takes its cycle's day, which for the main sleep
is the day it ends in; a workout takes the day of the cycle it started in (a
walk at 00:20 before a 00:40 bedtime belongs to the day before). A sleep or
workout written before its cycle falls back to its local end or start date and
is re-stamped when the cycle arrives, so arrival order never matters.

### Backfill

When WHOOP is connected and the store's history is not complete, the daemon
starts a backfill in the background after a good poll; `whoop backfill`
(`POST /whoop/backfill`) restarts it from scratch. It walks `/v2/cycle`,
`/v2/recovery`, `/v2/activity/sleep` and `/v2/activity/workout` in that order,
newest page first, `limit=25`, passing each `next_token` back as `nextToken`
until WHOOP stops sending one (an empty page or a repeated token also ends a
collection). It never delays the regular poll: it runs on its own promise
chain and shares only the token refresh.

Request budget: one page at a time, then a 2 s pause, so at most 30 requests a
minute on top of the poll's roughly one (5 or 6 every 5 minutes), against
WHOOP's 100 a minute and 10,000 a day. Three years of history is roughly 180
pages, about 6 minutes and under 2% of the daily allowance. A 429 with a short
`X-RateLimit-Reset` is waited out inline (as for polls); a longer one retries
the same page after the reset. Other errors retry the same page after 5
minutes, doubling up to 60. A refused refresh stops the backfill until the
next good poll.

Resume: each page's records and its collection's marker (the `next_token` for
the next page, page and record counts) commit in one transaction, so a
restart picks up at the next page and never counts a page whose records did
not land. A resume token WHOOP refuses (HTTP 400) restarts that collection
from its newest page; the upserts make the re-read harmless. Completion is
recorded per collection (`completed_at`); after that only polls and the
hourly sleep top-up write.

### `whoop` CLI

Read-only (the database is opened with `readOnly`; no daemon needed except for
`backfill`). Link it once:
`ln -s ~/Developer/claude-cli-chat/daemons/gateway/dist/whoop.js ~/.local/bin/whoop`.
With no database yet every command exits 1 with
`whoop: no WHOOP history yet: run whoop-auth, then wait for the first poll`.

```sh
whoop status [--json]                              # counts, days covered, backfill progress, last poll
whoop daily [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]     # default: the last 14 days
whoop workouts [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]  # default: the last 14 days
whoop week [--week-of YYYY-MM-DD] [--json]         # default: the last completed week
whoop sql "SELECT ..."                             # SELECT/WITH only, JSON rows
whoop backfill [--json]                            # POST /whoop/backfill, then print status
```

JSON contract (keys in this order; the weekly health review and the WHOOP MCP
server depend on it). Only SCORED records give numbers; anything else is null.
Rounding is half-up on the decimal value.

- `daily`: an array, one row per day from `--from` to `--to` inclusive, days
  with no data included (every value null, `workouts` 0):
  `{day, recovery (int), band (green >= 67, yellow 34-66, red <= 33),
  hrv_ms (1 dp), rhr_bpm (int), spo2_pct (1 dp), skin_temp_c (2 dp),
  strain (1 dp), kcal (int, kJ / 4.184), avg_hr_bpm, max_hr_bpm (int),
  sleep_performance_pct (int), sleep_hours (light + SWS + REM, 2 dp),
  sleep_need_hours (baseline + debt + strain + nap need, 2 dp),
  sleep_debt_hours (2 dp), sleep_efficiency_pct, sleep_consistency_pct,
  respiratory_rate (1 dp), disturbances (int), nap_hours (2 dp; 0 on a day
  with data and no nap, null on a day with none), workouts (int)}`. The
  night's sleep is the non-nap sleep tied to the day's cycle (else the longest
  in bed); naps never count toward `sleep_hours`. When two cycles share a day
  the later-starting one is that day's cycle.
- `workouts`: an array, oldest first:
  `{day, start, end, sport, strain (1 dp), kcal (int), avg_hr_bpm, max_hr_bpm,
  distance_km (2 dp), altitude_gain_m (1 dp), zones_min ([z0..z5] minutes,
  1 dp; null when WHOOP sent no zone data), duration_min (1 dp)}`.
- `week`: Sunday to Saturday, `--week-of` normalized to the Sunday on or
  before it: `{week_start, week_end, days (7 daily rows), workouts,
  summary: {days_with_recovery, recovery_avg, recovery_min, recovery_max,
  band_counts: {green, yellow, red}, hrv_avg_ms, rhr_avg_bpm, strain_avg,
  strain_total, sleep_hours_avg, sleep_need_hours_avg, sleep_performance_avg,
  zone_minutes ([z0..z5] totals), workout_count},
  prior_4wk: {recovery_avg, hrv_avg_ms, rhr_avg_bpm, strain_avg,
  sleep_hours_avg}}`. Averages are over the daily rows' own values, non-null
  days only (1 dp, hours 2 dp), null when there are none; `prior_4wk` covers
  the 28 days before `week_start`.
- `status`: `{db_path, schema_version, counts: {cycles, recoveries, sleeps,
  workouts}, oldest_day, newest_day, last_poll_at (from the cache file),
  last_poll_write_at, backfill: {state (not_started | in_progress |
  complete), completed_at, collections: {cycle, recovery, sleep, workout:
  {state, pages, records, has_next_token, started_at, updated_at,
  completed_at, last_error}}}}`.
- `backfill --json`: `{backfill (started | restarted | running | complete),
  running, status}`.

### Connecting an account: `whoop-auth`

1. Create an app at https://developer-dashboard.whoop.com with every read scope
   and the redirect URI `http://localhost:8799/whoop/callback`.
2. Link the CLI once (optional): `ln -s ~/Developer/claude-cli-chat/daemons/gateway/dist/whoop-auth.js ~/.local/bin/whoop-auth`
3. Run `whoop-auth`. It asks for the Client ID and Client Secret (the secret is
   not echoed), opens the consent page, waits up to 5 minutes for the redirect
   on 127.0.0.1 and ::1 port 8799, saves the tokens, prints who is connected,
   and asks the running gateway to poll (`POST /whoop/poll`, using the main
   token and the gateway's bind and port). If the gateway is not reachable the
   tokens are still saved and the daemon picks them up on its next check.

Over SSH (`$SSH_CONNECTION` set) it prints the consent URL instead of opening
it. Your browser then fails to load the `localhost` redirect; copy the full URL
from its address bar and paste it into the terminal.

```sh
whoop-auth                       # login (the default)
whoop-auth --redirect-uri https://henrys-mac-mini.tail92466c.ts.net/whoop/callback
whoop-auth status                # configured?, token expiry, last cached summary
whoop-auth set-client            # enter a new Client ID / Secret
whoop-auth logout                # forget the tokens, keep the client
```

`--redirect-uri` is for when WHOOP will not accept a `localhost` redirect: front
`127.0.0.1:8799` with `tailscale serve` under an https name, register that URI
on the WHOOP app, and pass it here. It must match the app exactly; it is stored
and reused by later logins.

Offline tests (fake WHOOP server, temp files only, nothing live touched):

```sh
node daemons/gateway/test/whoop.mjs        # poller, tokens, summary, routes, whoop-auth
node daemons/gateway/test/whoop-store.mjs  # history store, backfill, whoop CLI
```

`WHOOP_FIXTURE_OUT=<dir> node daemons/gateway/test/whoop-store.mjs` also keeps
the synthetic fixture database (`whoop-fixture.sqlite`, 2026-08-16 to
2026-10-09) and a `whoop week --json` sample there, for building on the CLI
without a WHOOP account.

## Through `tailscale serve`

WebSocket upgrade passes through cleanly (verified end to end):

```sh
tailscale serve --bg --http=8790 http://127.0.0.1:8788
node daemons/gateway/test/smoke.mjs http://henrys-mac-mini.tail92466c.ts.net:8790
tailscale serve --http=8790 off
```

Note that serve routes on the `Host` header: the MagicDNS name works, the raw
`100.x` IP returns 404. Run the daemon with `VAULT_GATEWAY_BIND=127.0.0.1` when
fronting it this way.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `VAULT_GATEWAY_VAULT` | — (**required**) | Working directory for every child; the vault root |
| `VAULT_GATEWAY_PORT` | `8788` | Listen port |
| `VAULT_GATEWAY_BIND` | auto (Tailscale IPv4) | Bind address; `127.0.0.1` for `tailscale serve` |
| `VAULT_GATEWAY_TOKEN_FILE` | `~/.config/vault-gateway/token` | Bearer token path, mode 600 |
| `VAULT_GATEWAY_MAX_CHILDREN` | `4` | Live `claude` children before LRU eviction |
| `VAULT_GATEWAY_APPROVAL_TIMEOUT_S` | `600` | Unanswered approval deadline |
| `VAULT_GATEWAY_CLAUDE` | autodetected | Path to the `claude` binary |
| `VAULT_GATEWAY_STATE_FILE` | `/tmp/claude_state.ios` | TC001 state mirror |
| `VAULT_GATEWAY_PARTIAL` | on | `0` drops `--include-partial-messages` |
| `VAULT_GATEWAY_HEALTH_DB` | `~/Library/Application Support/vault-gateway/apple-health.sqlite` | Apple Health SQLite store (outside the vault; parent dir created on first open). The `apple-health` CLI reads the same variable |
| `VAULT_GATEWAY_WHOOP_READ_TOKEN_FILE` | `~/.config/vault-gateway/whoop-read-token` | Read-only token for `GET /whoop/summary`, mode 600 |
| `VAULT_GATEWAY_WHOOP_DB` | `~/Library/Application Support/vault-gateway/whoop.sqlite` | WHOOP history store (outside the vault; parent dir created on first open). The `whoop` CLI reads the same variable |
| `VAULT_GATEWAY_WHOOP_CACHE` | `~/Library/Application Support/vault-gateway/whoop-cache.json` | Last good WHOOP pull, loaded at start. `whoop-auth status` reads it too |
| `WHOOP_CREDENTIALS_FILE` | `~/.config/whoop/credentials.json` | WHOOP client and tokens; shared by the daemon and `whoop-auth` |
| `WHOOP_API_BASE` | `https://api.prod.whoop.com` | WHOOP API origin (tests point it at a fake server) |
| `WHOOP_OAUTH_BASE` | `$WHOOP_API_BASE/oauth/oauth2` | OAuth endpoints (`/auth`, `/token`) |

## On-disk footprint

| Path | Contents |
|---|---|
| `<vault>/.claude-cli-chat/ios/tabs.json` | Tab index |
| `<vault>/.claude-cli-chat/ios/conversations/<id>.json` | Persisted tabs (plus `.meta.json` sidecars) |
| `<vault>/.claude-cli-chat/ios/events/<id>.ndjson` | Replay spill, rotated past 64 MB |
| `~/.config/vault-gateway/token` | Bearer token, mode 600 |
| `/tmp/claude_state.ios` | TC001 state mirror, `"<epoch> <state>\n"` |
| `/tmp/vault-gateway.log`, `.err` | launchd logs |
| `~/Library/Application Support/vault-gateway/apple-health.sqlite` (+ `-wal`, `-shm`) | Apple Health samples, daily stats, characteristics, ingest log (WAL). Raw health data; never in the vault |
| `<vault>/Health/Metrics/Apple Health Feed.md` | Generated Apple Health summary note, rewritten atomically at most once per 60 s after an ingest |
| `daemons/gateway/dist/apple-health.js` | Read-only `apple-health` CLI, symlinked as `~/.local/bin/apple-health` |
| `~/.config/vault-gateway/whoop-read-token` | WHOOP read-only token, mode 600 |
| `~/.config/whoop/credentials.json` | WHOOP client id/secret, redirect URI, access and refresh tokens, expiry (mode 600, directory 700). Written by temp file plus rename |
| `~/.config/whoop/credentials.lock` | Present only while a writer holds the credentials lock (the holder touches it every 10 s); treated as stale after 30 s without a touch |
| `~/Library/Application Support/vault-gateway/whoop-cache.json` | Last good WHOOP pull (raw records plus `fetched_at`) and the current cycle's strain series, mode 600 |
| `~/Library/Application Support/vault-gateway/whoop.sqlite` (+ `-wal`, `-shm`) | WHOOP history: cycles, recoveries, sleeps, workouts (raw JSON kept), backfill markers (WAL). Raw health data; never in the vault |
| `daemons/gateway/dist/whoop-auth.js` | `whoop-auth` CLI (optionally symlinked as `~/.local/bin/whoop-auth`) |
| `daemons/gateway/dist/whoop.js` | Read-only `whoop` history CLI, symlinked as `~/.local/bin/whoop` |

The store is namespaced under `apps/ios/`, disjoint from the plugin's
`.claude-cli-chat/` and the desktop app's `.claude-cli-chat/desktop/`, so all
three run at once without contending. The daemon never writes
`/tmp/claude_state` or `~/.claude/settings.json`.

## Layout

| File | Role |
|---|---|
| `src/main.ts` | Boot order, shutdown, signal handling |
| `src/config.ts` | Env parsing; Tailscale bind resolution |
| `src/token.ts` | Token generation and constant-time compare |
| `src/server.ts` | HTTP routes, ticket flow, WebSocket multiplexing |
| `src/ws.ts` | Minimal RFC 6455 server (no dependencies) |
| `src/engine.ts` | `TabEngine`: one tab's child, seq, approvals, projection |
| `src/registry.ts` | Tab store, child budget, LRU |
| `src/replay.ts` | Per-tab ring plus ndjson spill |
| `src/catalog.ts` | `/catalog` assembly |
| `src/files.ts` | Vault search and bounded reads |
| `src/usage.ts` | OAuth usage proxy (port of `bridge.py`'s `UsageFetcher`) |
| `src/state-mirror.ts` | `/tmp/claude_state.ios` writer |
| `src/platform-node.ts` | Node `Platform` so the shared stores have file I/O |
| `src/whoop/credentials.ts` | WHOOP credentials file: load, atomic save, lock |
| `src/whoop/oauth.ts` | Authorize URL, code exchange, refresh grant |
| `src/whoop/api.ts` | WHOOP v2 reads (cycles, recoveries, a cycle's recovery and sleep, sleeps, workouts, profile, paginated collection pages); 401 and 429 handling |
| `src/whoop/summary.ts` | Pure `buildSummary`: raw records to the `/whoop/summary` body; `advanceStrainSeries`; `cycleDay`, the day rule |
| `src/whoop/service.ts` | `WhoopService`: polling, refresh, cache, history writes, backfill start |
| `src/whoop/store.ts` | WHOOP history SQLite: schema, upserts, day stamping, backfill markers, status |
| `src/whoop/backfill.ts` | `WhoopBackfill`: background paging of the full history, rate pacing, resume |
| `src/whoop/history.ts` | Daily, workout and week views (the `whoop` CLI's JSON contract) |
| `src/whoop/cli.ts` | `whoop` |
| `src/whoop/auth-cli.ts` | `whoop-auth` |
