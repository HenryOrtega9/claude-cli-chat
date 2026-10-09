/* The WHOOP history backfill: pages through the full history of cycles,
   recoveries, sleeps and workouts into the store, in the background inside
   the daemon.

   - Started by the service after a successful poll whenever the store's
     markers say some collection is not complete, and restarted from scratch
     by POST /whoop/backfill (`whoop backfill`). It never delays a poll: it
     runs as its own promise chain and shares only the token plumbing.
   - Request budget: one page (limit=25) at a time, then `pageDelayMs`
     (2 s by default), so at most 30 requests a minute on top of the poll's
     one or so, against WHOOP's 100 a minute and 10,000 a day. A full history
     of three years is roughly 180 pages: about 6 minutes.
   - 429: api.ts already waits out a short X-RateLimit-Reset inline (twice at
     most); a longer one surfaces here as a WhoopApiError carrying the wait,
     and the same page is retried after it (never sooner than `retryMs`).
     Other errors back off from `retryMs` doubling up to `maxBackoffMs`. An
     auth failure (refused refresh, credentials error) stops the run; the
     next good poll starts it again.
   - Resume-safe: each page and its collection's marker (the next_token to
     fetch next, page and record counts) are written in one transaction, so
     a restart continues from the last page that landed, and a page is never
     counted without its records. A resume token WHOOP refuses (400) restarts
     that collection from its newest page; the upserts make the re-read
     harmless. A collection is complete when WHOOP sends no next_token, an
     empty page, or the token it was just given (a loop guard). */

import type { WhoopApi } from "./api";
import { WhoopApiError } from "./api";
import { CredentialsError } from "./credentials";
import { TokenError } from "./oauth";
import type { WhoopStore } from "./store";

export type BackfillTiming = {
  pageDelayMs: number;
  retryMs: number;
  maxBackoffMs: number;
};

export type BackfillOptions = {
  /* Opens (lazily) the store; may throw, which ends the run. */
  store: () => WhoopStore;
  api: () => WhoopApi;
  /* False while auth is not ok or the service is stopping. */
  canRun: () => boolean;
  /* An auth failure the service should act on (reauth_required, error). */
  onAuthFailure: (err: unknown) => void;
  log: (msg: string) => void;
  timing: BackfillTiming;
};

export type BackfillRequest = "started" | "restarted" | "complete" | "running";

export class WhoopBackfill {
  private running: Promise<void> | null = null;
  private resetRequested = false;
  private stopped = false;
  /* Cuts a pause short on stop(). */
  private wake: (() => void) | null = null;

  constructor(private readonly opts: BackfillOptions) {}

  get active(): boolean {
    return this.running !== null;
  }

  /* Start unless running or already complete. `reset` forgets every marker
     first (a running pass picks that up before its next page). */
  start(reset = false): BackfillRequest {
    if (this.stopped) return "running";
    if (reset) this.resetRequested = true;
    if (this.running) return reset ? "restarted" : "running";
    if (!reset && this.opts.store().backfillComplete()) return "complete";
    const run = this.run()
      .catch(err => this.opts.log(`whoop backfill crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`))
      .finally(() => { if (this.running === run) this.running = null; });
    this.running = run;
    return reset ? "restarted" : "started";
  }

  /* Resolves once the page in flight (if any) has been written. */
  stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    return Promise.allSettled([this.running]).then(() => undefined);
  }

  private pause(ms: number): Promise<void> {
    if (this.stopped || ms <= 0) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.wake = null; resolve(); }, ms);
      timer.unref();
      this.wake = () => { clearTimeout(timer); this.wake = null; resolve(); };
    });
  }

  private async run(): Promise<void> {
    const { log, timing } = this.opts;
    let failures = 0;
    let announced = false;
    for (;;) {
      if (this.stopped) return;
      const store = this.opts.store();
      if (this.resetRequested) {
        this.resetRequested = false;
        store.resetBackfill();
        log("whoop backfill: restarting from the newest page of every collection");
      }
      const marker = store.nextBackfill();
      if (!marker) {
        const s = store.status();
        log(`whoop backfill complete: ${s.counts.cycles} cycles, ${s.counts.recoveries} recoveries, `
          + `${s.counts.sleeps} sleeps, ${s.counts.workouts} workouts (${s.oldest_day ?? "?"} to ${s.newest_day ?? "?"})`);
        return;
      }
      if (!this.opts.canRun()) {
        log("whoop backfill paused: not connected; it resumes after the next good poll");
        return;
      }
      if (!announced) {
        announced = true;
        log(`whoop backfill: ${marker.pages > 0 || marker.next_token ? "resuming" : "starting"} at ${marker.collection} `
          + `(${marker.pages} page(s) already in)`);
      }
      const { collection, next_token: token } = marker;
      try {
        const page = await this.opts.api().collectionPage(collection, token);
        if (this.resetRequested) continue;
        const done = page.next_token === null || page.records.length === 0 || page.next_token === token;
        store.writeBackfillPage(collection, page.records, page.next_token, done);
        failures = 0;
        if (done) {
          log(`whoop backfill: ${collection} complete`);
          /* The last page of the last collection: finish straight away; a
             pause here would only keep the run looking active. */
          if (store.nextBackfill() === null) continue;
        }
      } catch (err) {
        if (err instanceof TokenError && err.kind === "reauth" || err instanceof CredentialsError) {
          this.opts.onAuthFailure(err);
          log(`whoop backfill stopped: ${err.message}`);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof WhoopApiError && err.status === 400 && token !== null) {
          log(`whoop backfill: WHOOP refused the ${collection} resume token (${message}); restarting ${collection} from its newest page`);
          store.resetBackfill(collection);
          continue;
        }
        failures++;
        const backoff = Math.min(timing.maxBackoffMs, timing.retryMs * 2 ** (failures - 1));
        const wait = Math.max(backoff, err instanceof WhoopApiError ? (err.retryAfterMs ?? 0) : 0);
        try { store.noteBackfillError(collection, message); } catch { /* the log line below still says it */ }
        log(`whoop backfill: ${collection} page failed (${failures} in a row): ${message}; retrying in ${Math.round(wait / 1000)} s`);
        await this.pause(wait);
        continue;
      }
      await this.pause(timing.pageDelayMs);
    }
  }
}
