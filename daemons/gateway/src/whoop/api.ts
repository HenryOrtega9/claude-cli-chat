/* The slice of the WHOOP v2 REST API the gateway reads.

   Collections answer `{ records, next_token }`; only the newest page is ever
   needed here. A cycle with no recovery or sleep yet answers 404, which
   becomes null ("missing"), not an error. A 401 asks the caller for a fresh
   token exactly once per request; a 429 waits out X-RateLimit-Reset (seconds
   until the window resets) when that is short, and otherwise surfaces as a
   WhoopApiError carrying the wait so the poller can back off for it. */

import { whoopApiBase } from "./oauth";

export type ScoreState = "SCORED" | "PENDING_SCORE" | "UNSCORABLE";

export type WhoopCycle = {
  id: number;
  start: string;
  end?: string | null;
  updated_at?: string;
  score_state?: ScoreState;
  score?: { strain?: number; kilojoule?: number; average_heart_rate?: number; max_heart_rate?: number };
};

export type WhoopRecovery = {
  cycle_id: number;
  sleep_id?: string;
  updated_at?: string;
  score_state?: ScoreState;
  score?: {
    user_calibrating?: boolean;
    recovery_score?: number;
    resting_heart_rate?: number;
    hrv_rmssd_milli?: number;
    spo2_percentage?: number;
    skin_temp_celsius?: number;
  };
};

export type WhoopSleep = {
  id: string;
  cycle_id?: number;
  start: string;
  end: string;
  nap?: boolean;
  updated_at?: string;
  score_state?: ScoreState;
  score?: {
    stage_summary?: {
      total_in_bed_time_milli?: number;
      total_awake_time_milli?: number;
      total_light_sleep_time_milli?: number;
      total_slow_wave_sleep_time_milli?: number;
      total_rem_sleep_time_milli?: number;
      disturbance_count?: number;
    };
    sleep_needed?: {
      baseline_milli?: number;
      need_from_sleep_debt_milli?: number;
      need_from_recent_strain_milli?: number;
      need_from_recent_nap_milli?: number;
    };
    respiratory_rate?: number;
    sleep_performance_percentage?: number;
    sleep_consistency_percentage?: number;
    sleep_efficiency_percentage?: number;
  };
};

export type WhoopWorkout = {
  id: string;
  start: string;
  end: string;
  sport_name?: string;
  updated_at?: string;
  score_state?: ScoreState;
  score?: { strain?: number; kilojoule?: number; average_heart_rate?: number; max_heart_rate?: number };
};

export type WhoopProfile = { user_id?: number; email?: string; first_name?: string; last_name?: string };

type Page<T> = { records?: T[]; next_token?: string | null };

export class WhoopApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterMs: number | null = null) {
    super(message);
    this.name = "WhoopApiError";
  }
}

export type WhoopApiOptions = {
  base?: string;
  /* The access token to send. */
  token: () => Promise<string>;
  /* Called with the token that just drew a 401; resolves to a fresh one.
     Absent (the CLI's one-shot profile lookup), a 401 throws. */
  refresh?: (rejected: string) => Promise<string>;
  /* Longest 429 wait taken inline before giving up to the poller. */
  maxRateWaitMs?: number;
};

const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RATE_WAIT_MS = 60_000;
/* With no usable X-RateLimit-Reset, assume the per-minute window. */
const DEFAULT_RATE_WAIT_MS = 60_000;

export class WhoopApi {
  private readonly base: string;

  constructor(private readonly opts: WhoopApiOptions) {
    this.base = (opts.base ?? whoopApiBase()).replace(/\/+$/, "");
  }

  /* Newest first; the first record is the current (possibly open) cycle. */
  async latestCycles(limit = 8): Promise<WhoopCycle[]> {
    const page = await this.get<Page<WhoopCycle>>(`/developer/v2/cycle?limit=${limit}`, false);
    return page?.records ?? [];
  }

  /* Newest first; each record names its cycle_id. A cycle WHOOP has no
     recovery for is simply absent from the page. */
  async latestRecoveries(limit = 8): Promise<WhoopRecovery[]> {
    const page = await this.get<Page<WhoopRecovery>>(`/developer/v2/recovery?limit=${limit}`, false);
    return page?.records ?? [];
  }

  cycleRecovery(cycleId: number): Promise<WhoopRecovery | null> {
    return this.get<WhoopRecovery>(`/developer/v2/cycle/${encodeURIComponent(String(cycleId))}/recovery`, true);
  }

  cycleSleep(cycleId: number): Promise<WhoopSleep | null> {
    return this.get<WhoopSleep>(`/developer/v2/cycle/${encodeURIComponent(String(cycleId))}/sleep`, true);
  }

  /* Newest first. */
  async latestWorkouts(limit = 10): Promise<WhoopWorkout[]> {
    const page = await this.get<Page<WhoopWorkout>>(`/developer/v2/activity/workout?limit=${limit}`, false);
    return page?.records ?? [];
  }

  async profile(): Promise<WhoopProfile> {
    return (await this.get<WhoopProfile>("/developer/v2/user/profile/basic", false)) ?? {};
  }

  private async get<T>(path: string, notFoundIsNull: boolean): Promise<T | null> {
    let token = await this.opts.token();
    let refreshed = false;
    let rateWaits = 0;
    const maxWait = this.opts.maxRateWaitMs ?? DEFAULT_MAX_RATE_WAIT_MS;
    for (;;) {
      let res: Response;
      try {
        res = await fetch(`${this.base}${path}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        throw new WhoopApiError(`GET ${path} failed: ${err instanceof Error ? err.message : String(err)}`, 0);
      }
      if (res.status === 200) return await res.json() as T;
      /* Drain the body so the keep-alive socket is reusable. */
      await res.text().catch(() => "");
      if (res.status === 401 && !refreshed && this.opts.refresh) {
        refreshed = true;
        token = await this.opts.refresh(token);
        continue;
      }
      if (res.status === 429) {
        /* Number(null) and Number("") are 0, which would read a missing
           header as "resets now" and retry at once. */
        const header = res.headers.get("x-ratelimit-reset");
        const reset = header !== null && header.trim() !== "" ? Number(header) : NaN;
        const waitMs = Number.isFinite(reset) && reset >= 0 ? Math.ceil(reset * 1000) : DEFAULT_RATE_WAIT_MS;
        if (rateWaits < 2 && waitMs <= maxWait) {
          rateWaits++;
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        throw new WhoopApiError(`GET ${path}: rate limited for ${Math.round(waitMs / 1000)} s`, 429, waitMs);
      }
      if (res.status === 404 && notFoundIsNull) return null;
      throw new WhoopApiError(`GET ${path}: HTTP ${res.status}`, res.status);
    }
  }
}
