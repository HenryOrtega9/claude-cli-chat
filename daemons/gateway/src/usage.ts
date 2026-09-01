/* Anthropic OAuth usage proxy — a port of daemons/watch-bridge/bridge.py's
   UsageFetcher, deliberately payload-compatible so the phone and the watch
   parse the same JSON.

   It reuses the ClaudeUsageBar credentials file rather than owning its own
   OAuth flow, and writes refreshed tokens BACK to that file (mode 600) so the
   menu-bar app, the watch bridge, and this daemon all stay logged in together
   instead of racing each other into re-auth. 60 s cache: the buckets move on
   the order of minutes and the phone's usage sheet can poll freely.

   The one thing this port drops is the certifi dance — Python on this machine
   has no CA bundle wired in, Node ships its own trust store. */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";

const CRED_PATH = `${homedir()}/.config/claude-usage-bar/credentials.json`;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CACHE_MS = 60_000;

type Creds = {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  scopes?: string[];
};

export class UsageFetcher {
  private cachedAt = 0;
  private cached: unknown = null;
  /* One in-flight fetch at a time: a burst of pulls on app foreground must
     not fan out into N token refreshes racing to rewrite the creds file. */
  private inflight: Promise<{ status: number; body: unknown }> | null = null;

  constructor(private log: (msg: string) => void) {}

  async fetch(): Promise<{ status: number; body: unknown }> {
    if (this.cached !== null && Date.now() - this.cachedAt < CACHE_MS) {
      return { status: 200, body: this.cached };
    }
    if (this.inflight) return this.inflight;
    const job = this.doFetch().finally(() => { this.inflight = null; });
    this.inflight = job;
    return job;
  }

  private async doFetch(): Promise<{ status: number; body: unknown }> {
    let creds = await this.loadCreds();
    if (!creds?.accessToken) return { status: 503, body: { error: "usage_credentials_missing" } };
    if (this.needsRefresh(creds)) creds = (await this.refresh(creds)) ?? creds;

    let res = await this.getUsage(creds.accessToken!);
    if (res.status === 401) {
      const refreshed = await this.refresh(creds);
      if (!refreshed) return { status: 503, body: { error: "usage_auth_expired" } };
      res = await this.getUsage(refreshed.accessToken!);
    }
    if (res.status === 200) {
      this.cachedAt = Date.now();
      this.cached = res.body;
    }
    return res;
  }

  private async loadCreds(): Promise<Creds | null> {
    try {
      return JSON.parse(await fs.readFile(CRED_PATH, "utf8")) as Creds;
    } catch {
      return null;
    }
  }

  private needsRefresh(creds: Creds): boolean {
    const expiry = Date.parse(creds.expiresAt ?? "");
    if (!Number.isFinite(expiry)) return false;
    return expiry <= Date.now() + 60_000;
  }

  private async getUsage(token: string): Promise<{ status: number; body: unknown }> {
    try {
      const res = await fetch(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      if (res.status !== 200) return { status: res.status, body: { error: `usage_http_${res.status}` } };
      return { status: 200, body: JSON.parse(text) };
    } catch (err) {
      return { status: 502, body: { error: `usage_fetch_failed: ${String(err)}` } };
    }
  }

  private async refresh(creds: Creds): Promise<Creds | null> {
    if (!creds.refreshToken) return null;
    const scopes = creds.scopes ?? [];
    const body: Record<string, unknown> = {
      grant_type: "refresh_token",
      refresh_token: creds.refreshToken,
      client_id: CLIENT_ID,
    };
    if (scopes.length > 0) body.scope = scopes.join(" ");
    let data: { access_token?: string; refresh_token?: string; expires_in?: number };
    try {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      data = JSON.parse(await res.text());
    } catch (err) {
      this.log(`usage token refresh failed: ${String(err)}`);
      return null;
    }
    if (!data.access_token) return null;
    const updated: Creds = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || creds.refreshToken,
      expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      scopes,
    };
    /* tmp + rename so a concurrent reader (ClaudeUsageBar polls this file)
       never sees a half-written credentials blob. */
    try {
      const tmp = `${CRED_PATH}.vault-gateway.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
      await fs.chmod(tmp, 0o600);
      await fs.rename(tmp, CRED_PATH);
      this.log("usage token refreshed");
    } catch (err) {
      this.log(`usage credentials save failed: ${String(err)}`);
    }
    return updated;
  }
}
