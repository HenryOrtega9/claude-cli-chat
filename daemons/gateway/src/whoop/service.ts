/* The daemon-side WHOOP poller behind GET /whoop/summary and POST /whoop/poll.

   Polls every 5 min, so day strain reaches the watch about as fast as the
   band syncs it to WHOOP. The separate morning cadence (05:00 to 11:00 while
   today's recovery is unscored) is kept as a knob and currently matches. Failures back off from 2 min up to 60 min. The last good pull is
   cached to disk and loaded at construction, so a restart answers with data
   (marked stale once it is 45 min old) before its first poll.

   A poll is 5 requests (cycles, recoveries, this cycle's recovery and sleep,
   workouts), 6 while today's recovery is pending or absent and the previous
   cycle's is fetched too: about 1,440 a day at 5 min against WHOOP's 10,000.
   Each successful poll also steps the intraday strain series for the current
   cycle (advanceStrainSeries); it is cached with the raw records, so a
   restart keeps the day's curve.

   Token rules (see credentials.ts and oauth.ts for the why):
   - only this service refreshes; whoop-auth only does the first exchange;
   - one refresh in flight per process, and across processes the credentials
     lock plus a re-read that adopts tokens someone else already rotated;
   - new tokens are written to disk before they are used;
   - refresh 5 min before expiry, and once on a 401;
   - a refused grant (invalid_grant, 400/401) is auth "reauth_required" and
     polling stops until the credentials file changes; network errors and
     5xx are transient and back off.
   Every tick compares the credentials file's identity (one stat), so
   re-running whoop-auth takes effect without a restart. */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

import { WhoopApi, WhoopApiError } from "./api";
import {
  CredentialsError, credentialsSignature, hasTokens, loadCredentials, loadCredentialsSync, saveCredentials,
  withCredentialsLock, type WhoopCredentials,
} from "./credentials";
import { applyTokens, refreshTokens, TokenError, whoopApiBase, whoopOAuthBase } from "./oauth";
import {
  advanceStrainSeries, buildSummary, needsFallback, summaryLine, type AuthState, type StrainSeries, type WhoopRaw, type WhoopSummary,
} from "./summary";

export type WhoopTiming = {
  pollMs: number;
  morningPollMs: number;
  /* Tick while not configured or awaiting re-auth: just a stat of the file. */
  checkMs: number;
  minBackoffMs: number;
  maxBackoffMs: number;
  refreshMarginMs: number;
  maxRateWaitMs: number;
};

export const DEFAULT_TIMING: WhoopTiming = {
  pollMs: 5 * 60_000,
  morningPollMs: 5 * 60_000,
  checkMs: 60_000,
  minBackoffMs: 2 * 60_000,
  maxBackoffMs: 60 * 60_000,
  refreshMarginMs: 5 * 60_000,
  maxRateWaitMs: 60_000,
};

const MORNING_START_HOUR = 5;
const MORNING_END_HOUR = 11;

export type WhoopServiceOptions = {
  credentialsPath: string;
  cachePath: string;
  log: (msg: string) => void;
  apiBase?: string;
  oauthBase?: string;
  timing?: Partial<WhoopTiming>;
};

type CacheFile = { schema: 1; fetched_at: string; raw: WhoopRaw; strain_series?: StrainSeries | null };

function validSeries(v: unknown): StrainSeries | null {
  const s = v as Partial<StrainSeries> | null | undefined;
  if (!s || typeof s.cycle_id !== "number" || !Array.isArray(s.points)) return null;
  const points = s.points.filter(p => p && typeof p.t === "string" && typeof p.strain === "number");
  return { cycle_id: s.cycle_id, points };
}

export function readWhoopCache(path: string): { raw: WhoopRaw; fetchedAt: number; series: StrainSeries | null } | null {
  let parsed: Partial<CacheFile>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CacheFile>;
  } catch {
    return null;
  }
  const fetchedAt = Date.parse(parsed.fetched_at ?? "");
  if (parsed.schema !== 1 || !parsed.raw || typeof parsed.raw !== "object" || !Number.isFinite(fetchedAt)) return null;
  return { raw: parsed.raw, fetchedAt, series: validSeries(parsed.strain_series) };
}

export type PollDelayInput = {
  auth: AuthState;
  lastPollOk: boolean;
  failures: number;
  retryAfterMs: number | null;
  recoveryScoredToday: boolean;
  now: Date;
};

export function pollDelayMs(input: PollDelayInput, timing: WhoopTiming = DEFAULT_TIMING): number {
  if (input.auth !== "ok") return timing.checkMs;
  if (!input.lastPollOk) {
    const backoff = Math.min(timing.maxBackoffMs, timing.minBackoffMs * 2 ** Math.max(0, input.failures - 1));
    return Math.max(backoff, input.retryAfterMs ?? 0);
  }
  const hour = input.now.getHours();
  const morning = hour >= MORNING_START_HOUR && hour < MORNING_END_HOUR;
  return morning && !input.recoveryScoredToday ? timing.morningPollMs : timing.pollMs;
}

export class WhoopService {
  private readonly timing: WhoopTiming;
  private readonly apiBase: string;
  private readonly oauthBase: string;
  private creds: WhoopCredentials | null = null;
  /* Identity of the credentials file as last read; see credentialsSignature. */
  private credsSig: string | null = null;
  private auth: AuthState = "not_configured";
  private raw: WhoopRaw | null = null;
  private series: StrainSeries | null = null;
  private fetchedAt: number | null = null;
  private lastPollOk = true;
  private lastError: string | null = null;
  private failures = 0;
  private retryAfterMs: number | null = null;
  private nextPollAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  private refreshing: Promise<string> | null = null;
  private loggedOk = false;
  private started = false;
  private stopped = false;

  constructor(private readonly opts: WhoopServiceOptions) {
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.apiBase = opts.apiBase ?? whoopApiBase();
    this.oauthBase = opts.oauthBase ?? whoopOAuthBase();
    const cached = readWhoopCache(opts.cachePath);
    if (cached) {
      this.raw = cached.raw;
      this.fetchedAt = cached.fetchedAt;
      this.series = cached.series;
    }
    /* Synchronously, so a summary asked for before the first poll already
       reports the right auth state. */
    this.credsSig = credentialsSignature(opts.credentialsPath);
    try {
      this.adoptCredentials(loadCredentialsSync(opts.credentialsPath));
    } catch (err) {
      this.setCredentialsError(err);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.opts.log(`whoop: ${this.auth}${this.fetchedAt ? `, cache from ${new Date(this.fetchedAt).toISOString()}` : ""}`);
    void this.pollNow();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.nextPollAt = null;
  }

  summary(): WhoopSummary {
    return buildSummary(this.raw, new Date(), {
      auth: this.auth,
      fetchedAt: this.fetchedAt,
      lastPollOk: this.lastPollOk,
      nextPollAt: this.nextPollAt,
      lastError: this.lastError,
    }, this.series);
  }

  /* Poll now, joining one already in flight, then reschedule. Never rejects;
     failures land in the summary. */
  async pollNow(): Promise<WhoopSummary> {
    if (!this.polling) {
      const run = this.poll()
        .catch(err => { this.opts.log(`whoop poll crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`); })
        .finally(() => {
          if (this.polling === run) this.polling = null;
          this.schedule();
        });
      this.polling = run;
    }
    await this.polling;
    return this.summary();
  }

  private schedule(): void {
    if (!this.started || this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    const s = this.summary();
    const delay = pollDelayMs({
      auth: this.auth,
      lastPollOk: this.lastPollOk,
      failures: this.failures,
      retryAfterMs: this.retryAfterMs,
      recoveryScoredToday: s.recovery.state === "scored" && s.recovery.is_current_cycle,
      now: new Date(),
    }, this.timing);
    this.nextPollAt = Date.now() + delay;
    this.timer = setTimeout(() => { this.timer = null; void this.pollNow(); }, delay);
    /* Never the thing keeping the daemon alive. */
    this.timer.unref();
  }

  /* ---------- credentials ---------- */

  private adoptCredentials(creds: WhoopCredentials | null): void {
    this.creds = creds;
    if (!hasTokens(creds)) {
      this.auth = "not_configured";
      this.lastPollOk = false;
      return;
    }
    if (this.auth !== "ok") {
      this.auth = "ok";
      this.failures = 0;
      this.retryAfterMs = null;
    }
  }

  private setCredentialsError(err: unknown): void {
    this.creds = null;
    this.auth = "error";
    this.lastPollOk = false;
    this.lastError = err instanceof Error ? err.message : String(err);
  }

  /* The cheap per-tick check: one stat, and a re-read only when the file is
     not the one last read (whoop-auth ran, logout, a hand edit). A changed
     file also clears reauth_required, so a fresh login resumes polling. */
  private async syncCredentials(): Promise<void> {
    const sig = credentialsSignature(this.opts.credentialsPath);
    if (sig === this.credsSig) return;
    this.credsSig = sig;
    const before = this.auth;
    try {
      this.adoptCredentials(await loadCredentials(this.opts.credentialsPath));
    } catch (err) {
      this.setCredentialsError(err);
    }
    if (this.auth !== before) this.opts.log(`whoop: credentials file changed, auth ${before} -> ${this.auth}`);
  }

  private async accessToken(): Promise<string> {
    const c = this.creds;
    if (!hasTokens(c)) throw new TokenError("no WHOOP tokens on file", "reauth", 0);
    const expiry = Date.parse(c.expires_at ?? "");
    /* Unknown expiry: use the token and let a 401 decide. */
    if (!Number.isFinite(expiry) || expiry - Date.now() > this.timing.refreshMarginMs) return c.access_token;
    return this.refresh(c.access_token);
  }

  /* A 401 for a token this process has already replaced (parallel requests
     racing one refresh) just retries with the replacement. */
  private refreshAfter401(rejected: string): Promise<string> {
    if (this.creds?.access_token && this.creds.access_token !== rejected) return Promise.resolve(this.creds.access_token);
    return this.refresh(rejected);
  }

  private refresh(stale: string): Promise<string> {
    if (!this.refreshing) {
      const run = this.doRefresh(stale).finally(() => { if (this.refreshing === run) this.refreshing = null; });
      this.refreshing = run;
    }
    return this.refreshing;
  }

  private doRefresh(stale: string): Promise<string> {
    const path = this.opts.credentialsPath;
    return withCredentialsLock(path, async () => {
      const disk = await loadCredentials(path);
      if (!hasTokens(disk)) throw new TokenError("credentials file has no refresh token", "reauth", 0);
      /* Someone else (another process, or a fresh whoop-auth login) rotated
         the pair since this process last read it. Spending our copy of the
         refresh token now would be a reuse WHOOP answers with invalid_grant. */
      if (disk.refresh_token !== this.creds?.refresh_token || disk.access_token !== stale) {
        this.creds = disk;
        this.credsSig = credentialsSignature(path);
        this.opts.log("whoop: adopted tokens refreshed by another writer");
        return disk.access_token;
      }
      const tokens = await refreshTokens({
        clientId: disk.client_id,
        clientSecret: disk.client_secret,
        refreshToken: disk.refresh_token,
        base: this.oauthBase,
      });
      const next = applyTokens(disk, tokens);
      /* Persist before use: the old refresh token is already dead. */
      await saveCredentials(path, next);
      this.creds = next;
      this.credsSig = credentialsSignature(path);
      this.opts.log(`whoop: token refreshed, expires ${next.expires_at}`);
      return tokens.access_token;
    });
  }

  /* ---------- polling ---------- */

  private async poll(): Promise<void> {
    await this.syncCredentials();
    if (this.auth !== "ok") {
      this.lastPollOk = false;
      return;
    }
    try {
      const raw = await this.fetchRaw();
      const recovered = !this.lastPollOk;
      this.raw = raw;
      this.fetchedAt = Date.now();
      this.series = advanceStrainSeries(this.series, raw.cycle, this.fetchedAt);
      this.lastPollOk = true;
      this.lastError = null;
      this.failures = 0;
      this.retryAfterMs = null;
      this.saveCache();
      if (!this.loggedOk || recovered) {
        this.loggedOk = true;
        this.opts.log(`whoop poll ok: ${summaryLine(this.summary())}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastPollOk = false;
      this.lastError = message;
      if (err instanceof TokenError && err.kind === "reauth") {
        this.auth = "reauth_required";
        this.opts.log(`whoop: re-auth required (${message}); run whoop-auth`);
        return;
      }
      if (err instanceof CredentialsError) {
        this.auth = "error";
        this.opts.log(`whoop: credentials error: ${message}`);
        return;
      }
      this.failures++;
      this.retryAfterMs = err instanceof WhoopApiError ? err.retryAfterMs : null;
      this.opts.log(`whoop poll failed (${this.failures} in a row): ${message}`);
    }
  }

  private async fetchRaw(): Promise<WhoopRaw> {
    const api = new WhoopApi({
      base: this.apiBase,
      token: () => this.accessToken(),
      refresh: rejected => this.refreshAfter401(rejected),
      maxRateWaitMs: this.timing.maxRateWaitMs,
    });
    const cycles = await api.latestCycles(8);
    const [cycle = null, previousCycle = null] = cycles;
    const [recovery, sleep, workouts, recoveries] = await Promise.all([
      cycle ? api.cycleRecovery(cycle.id) : Promise.resolve(null),
      cycle ? api.cycleSleep(cycle.id) : Promise.resolve(null),
      api.latestWorkouts(10),
      api.latestRecoveries(8),
    ]);
    const previousRecovery = previousCycle && needsFallback(recovery) ? await api.cycleRecovery(previousCycle.id) : null;
    return { cycle, previousCycle, recovery, previousRecovery, sleep, workout: workouts[0] ?? null, cycles, recoveries, workouts };
  }

  /* Synchronous and small (tens of KB with a full strain series): temp file
     plus rename, mode 600 since it is health data. A failed write costs only
     the restart warm start. */
  private saveCache(): void {
    if (!this.raw || this.fetchedAt === null) return;
    const path = this.opts.cachePath;
    const body: CacheFile = { schema: 1, fetched_at: new Date(this.fetchedAt).toISOString(), raw: this.raw, strain_series: this.series };
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, path);
    } catch (err) {
      rmSync(tmp, { force: true });
      this.opts.log(`whoop cache write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
