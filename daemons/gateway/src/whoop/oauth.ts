/* WHOOP OAuth 2.0: the authorize URL, the code exchange (whoop-auth only) and
   the refresh grant (the daemon only).

   Facts this relies on (developer.whoop.com, checked 2026-10-09):
   - `state` must be eight characters;
   - a refresh token is only issued when `offline` is among the scopes, and
     the refresh grant asks for `scope=offline` again;
   - client credentials go in an application/x-www-form-urlencoded body;
   - refresh tokens rotate: each refresh returns a new pair and invalidates
     the old one, and of two concurrent refreshes only the first succeeds.

   WHOOP_API_BASE (default https://api.prod.whoop.com) moves the API and, via
   it, the OAuth endpoints; WHOOP_OAUTH_BASE moves only the latter. The tests
   point both at a fake server. */

import { randomInt } from "node:crypto";

import type { WhoopCredentials } from "./credentials";

export const WHOOP_SCOPES = [
  "read:recovery", "read:cycles", "read:sleep", "read:workout", "read:profile", "read:body_measurement", "offline",
] as const;

export const DEFAULT_REDIRECT_URI = "http://localhost:8799/whoop/callback";

const TOKEN_TIMEOUT_MS = 15_000;

export function whoopApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.WHOOP_API_BASE || "https://api.prod.whoop.com").replace(/\/+$/, "");
}

export function whoopOAuthBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.WHOOP_OAUTH_BASE || `${whoopApiBase(env)}/oauth/oauth2`).replace(/\/+$/, "");
}

const STATE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/* Exactly 8 alphanumerics from a CSPRNG (randomInt is uniform, no modulo
   bias). */
export function newState(): string {
  let out = "";
  for (let i = 0; i < 8; i++) out += STATE_ALPHABET[randomInt(STATE_ALPHABET.length)];
  return out;
}

export function buildAuthorizeUrl(opts: { clientId: string; redirectUri: string; state: string; base?: string }): string {
  const url = new URL(`${opts.base ?? whoopOAuthBase()}/auth`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", WHOOP_SCOPES.join(" "));
  url.searchParams.set("state", opts.state);
  return url.toString();
}

export type TokenSet = {
  access_token: string;
  refresh_token: string | null;
  expires_in: number;
  scope: string | null;
};

/* `reauth`: the grant itself was refused (invalid_grant, or any 400/401 from
   the token endpoint). Retrying cannot help; a person has to run whoop-auth.
   `transient`: network, timeout, 429, 5xx. Back off and try again. */
export class TokenError extends Error {
  constructor(message: string, readonly kind: "reauth" | "transient", readonly status: number) {
    super(message);
    this.name = "TokenError";
  }
}

type TokenParams = Record<string, string>;

/* WHOOP documents the form encoding. If a 400/415 ever says the content type
   is the problem, try the same grant once as JSON before giving up; never on
   an invalid_grant, which is a verdict on the token, not the encoding. */
function looksLikeContentTypeError(status: number, text: string): boolean {
  if (status === 415) return true;
  if (status !== 400 || /invalid_grant/i.test(text)) return false;
  return /content[\s_-]?type|media[\s_-]?type|x-www-form-urlencoded|unsupported_content/i.test(text);
}

async function postToken(params: TokenParams, base: string): Promise<TokenSet> {
  const url = `${base}/token`;
  const attempt = async (json: boolean): Promise<{ status: number; text: string }> => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": json ? "application/json" : "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: json ? JSON.stringify(params) : new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
      return { status: res.status, text: await res.text() };
    } catch (err) {
      throw new TokenError(`token request failed: ${err instanceof Error ? err.message : String(err)}`, "transient", 0);
    }
  };

  let { status, text } = await attempt(false);
  if (looksLikeContentTypeError(status, text)) ({ status, text } = await attempt(true));

  let body: Record<string, unknown> = {};
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* non-JSON error page */ }
  if (status >= 200 && status < 300) {
    if (typeof body.access_token !== "string" || !body.access_token) {
      throw new TokenError("token endpoint answered without an access_token", "transient", status);
    }
    const expiresIn = Number(body.expires_in);
    return {
      access_token: body.access_token,
      refresh_token: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : null,
      expires_in: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
      scope: typeof body.scope === "string" ? body.scope : null,
    };
  }
  const code = typeof body.error === "string" ? body.error : "";
  const detail = typeof body.error_description === "string" ? `: ${body.error_description}` : "";
  const message = `token endpoint HTTP ${status}${code ? ` ${code}` : ""}${detail}`;
  if (code === "invalid_grant" || status === 400 || status === 401) throw new TokenError(message, "reauth", status);
  throw new TokenError(message, "transient", status);
}

export function exchangeCode(opts: {
  clientId: string; clientSecret: string; redirectUri: string; code: string; base?: string;
}): Promise<TokenSet> {
  return postToken({
    grant_type: "authorization_code",
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
  }, opts.base ?? whoopOAuthBase());
}

export function refreshTokens(opts: {
  clientId: string; clientSecret: string; refreshToken: string; base?: string;
}): Promise<TokenSet> {
  return postToken({
    grant_type: "refresh_token",
    refresh_token: opts.refreshToken,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    scope: "offline",
  }, opts.base ?? whoopOAuthBase());
}

/* The credentials after a successful grant. A refresh that (against the
   docs) returns no new refresh token keeps the old one rather than dropping
   the connection. */
export function applyTokens(creds: WhoopCredentials, tokens: TokenSet, now: number = Date.now()): WhoopCredentials {
  return {
    ...creds,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? creds.refresh_token,
    expires_at: new Date(now + tokens.expires_in * 1000).toISOString(),
    scope: tokens.scope ?? creds.scope,
    obtained_at: new Date(now).toISOString(),
  };
}
