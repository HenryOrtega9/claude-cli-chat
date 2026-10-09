/* `whoop-auth`: connect the vault gateway to a WHOOP account.

   Bundled by daemons/gateway/build.mjs to dist/whoop-auth.js. It owns the
   human half of OAuth only: the client id/secret prompt, the consent page,
   the one authorization-code exchange, and logout. Refreshing is the
   daemon's job alone (src/whoop/service.ts), because WHOOP refresh tokens are
   single use and two refreshers would burn each other's tokens. Every write
   here goes through the same credentials lock the daemon refreshes under.

   The redirect is caught two ways at once: a listener on 127.0.0.1 and ::1
   (port 8799 by default), and a full redirect URL pasted on stdin, which is
   how it works over SSH where the browser runs on another machine. */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";

import { gatewayTokenPath, localGatewayUrl, whoopCachePath, whoopCredentialsPath } from "../config";
import { WhoopApi } from "./api";
import {
  CredentialsError, emptyCredentials, hasTokens, loadCredentials, updateCredentials, type WhoopCredentials,
} from "./credentials";
import {
  applyTokens, buildAuthorizeUrl, DEFAULT_REDIRECT_URI, exchangeCode, newState, TokenError, whoopApiBase,
} from "./oauth";
import { readWhoopCache } from "./service";
import { buildSummary, summaryLine, type WhoopSummary } from "./summary";

const USAGE = `whoop-auth: connect the vault gateway to WHOOP

Usage:
  whoop-auth [login] [--redirect-uri <uri>]
      asks for the WHOOP app's Client ID and Client Secret if none are stored,
      opens the WHOOP consent page (over SSH it prints the URL instead) and waits
      up to 5 minutes for the redirect to ${DEFAULT_REDIRECT_URI}.
      Over SSH, paste the full URL your browser ended up on instead.
      --redirect-uri overrides the redirect (for example an https tailscale serve
      name that forwards to 127.0.0.1:8799); it must match the WHOOP app exactly.
  whoop-auth status       configured?, token expiry, the last cached summary
  whoop-auth set-client   enter a new Client ID / Client Secret
  whoop-auth logout       forget the tokens, keep the client id and secret

Credentials: $WHOOP_CREDENTIALS_FILE or ~/.config/whoop/credentials.json (mode 600)`;

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_CALLBACK_PORT = 8799;
const GATEWAY_POLL_TIMEOUT_MS = 45_000;

class CliError extends Error {}

type Args = { command: string; flags: Map<string, string> };

const VALUE_FLAGS = new Set(["redirect-uri"]);

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") { flags.set("help", "1"); continue; }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      if (!VALUE_FLAGS.has(name)) throw new CliError(`unknown option --${name}`);
      const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
      if (value === undefined) throw new CliError(`--${name} needs a value`);
      flags.set(name, value);
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > 1) throw new CliError(`unexpected argument "${positional[1]}"`);
  return { command: positional[0] ?? "login", flags };
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

/* One readline over stdin for the whole run: prompts and pasted redirect
   URLs share it. Output goes through a gate so the secret prompt can stop
   the terminal echoing what is typed. */
class Terminal {
  private muted = false;
  private readonly rl: Interface;
  private readonly lines: string[] = [];
  private readonly waiters: ((line: string | null) => void)[] = [];
  private closed = false;

  constructor() {
    const gate = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        if (!this.muted) process.stdout.write(chunk);
        cb();
      },
    });
    this.rl = createInterface({ input: process.stdin, output: gate, terminal: process.stdin.isTTY === true });
    this.rl.on("line", line => {
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.lines.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) waiter(null);
    });
  }

  /* null once stdin has ended. */
  nextLine(): Promise<string | null> {
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift() as string);
    if (this.closed) return Promise.resolve(null);
    return new Promise(resolve => this.waiters.push(resolve));
  }

  async ask(prompt: string, hidden = false): Promise<string> {
    process.stdout.write(prompt);
    this.muted = hidden;
    const line = await this.nextLine();
    this.muted = false;
    if (hidden && process.stdin.isTTY) process.stdout.write("\n");
    if (line === null) throw new CliError("stdin closed before an answer was given");
    return line.trim();
  }

  close(): void {
    this.rl.close();
    /* readline leaves stdin open; a destroyed stdin lets the process exit
       without process.exit(), which could cut off buffered pipe output. */
    process.stdin.destroy();
  }
}

/* ---------- redirect handling ---------- */

type RedirectCheck = { ok: true; code: string } | { ok: false; fatal: boolean; message: string };

/* State first: a redirect carrying someone else's state is ignored, never
   acted on, even when it reports an error. */
function checkRedirect(url: URL, expectedState: string): RedirectCheck {
  const state = url.searchParams.get("state");
  if (state !== expectedState) return { ok: false, fatal: false, message: "state does not match this login attempt" };
  const error = url.searchParams.get("error");
  if (error) {
    const desc = url.searchParams.get("error_description");
    return { ok: false, fatal: true, message: `WHOOP refused the authorization: ${error}${desc ? ` (${desc})` : ""}` };
  }
  const code = url.searchParams.get("code");
  if (!code) return { ok: false, fatal: false, message: "the redirect carries no code" };
  return { ok: true, code };
}

function page(res: ServerResponse, status: number, message: string): void {
  const body = `<!doctype html><meta charset="utf-8"><title>whoop-auth</title>`
    + `<body style="font:16px -apple-system,system-ui,sans-serif;margin:3em">${message.replace(/[<>&]/g, c => `&#${c.charCodeAt(0)};`)}</body>`;
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}

/* The local port the redirect lands on: the redirect URI's own port when it
   points at this machine, otherwise (an https name fronted by tailscale
   serve) 8799, which serve is expected to forward to. */
function callbackPort(redirect: URL): number {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
  const port = Number(redirect.port);
  return local && port > 0 ? port : DEFAULT_CALLBACK_PORT;
}

function waitForCode(opts: { redirect: URL; state: string; term: Terminal }): Promise<string> {
  const port = callbackPort(opts.redirect);
  return new Promise<string>((resolve, reject) => {
    const servers: Server[] = [];
    let done = false;
    const finish = (err: Error | null, code?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const s of servers) { s.closeAllConnections(); s.close(); }
      if (err) reject(err);
      else resolve(code as string);
    };
    const timer = setTimeout(() => finish(new CliError("timed out after 5 minutes waiting for the WHOOP redirect")), LOGIN_TIMEOUT_MS);

    const handle = (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method !== "GET" || url.pathname !== opts.redirect.pathname) return page(res, 404, "Not found.");
      const check = checkRedirect(url, opts.state);
      if (!check.ok) {
        page(res, 400, `whoop-auth: ${check.message}.`);
        if (check.fatal) finish(new CliError(check.message));
        else out(`Ignored a redirect: ${check.message}.`);
        return;
      }
      page(res, 200, "WHOOP is connected. You can close this tab.");
      finish(null, check.code);
    };

    /* 127.0.0.1 is required; ::1 is best effort ("localhost" may resolve to
       either in the browser, and a Mac with IPv6 off cannot bind it). */
    for (const host of ["127.0.0.1", "::1"]) {
      const server = createServer(handle);
      servers.push(server);
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (host !== "127.0.0.1") return;
        finish(new CliError(err.code === "EADDRINUSE"
          ? `port ${port} is already in use; free it or pass a --redirect-uri with another localhost port (registered on the WHOOP app)`
          : `cannot listen on ${host}:${port}: ${err.message}`));
      });
      server.listen(port, host);
    }

    void (async () => {
      for (;;) {
        const line = await opts.term.nextLine();
        if (line === null || done) return;
        const text = line.trim();
        if (!text) continue;
        let url: URL;
        try {
          url = new URL(text);
        } catch {
          out("That is not a URL. Paste the full address your browser was redirected to.");
          continue;
        }
        const check = checkRedirect(url, opts.state);
        if (check.ok) return finish(null, check.code);
        if (check.fatal) return finish(new CliError(check.message));
        out(`Ignored that URL: ${check.message}.`);
      }
    })();
  });
}

/* ---------- gateway ---------- */

async function pokeGateway(): Promise<void> {
  let token: string;
  try {
    token = readFileSync(gatewayTokenPath(), "utf8").trim();
  } catch {
    out("No gateway token on this machine; the daemon will pick the tokens up on its next check.");
    return;
  }
  const base = localGatewayUrl();
  try {
    const res = await fetch(`${base}/whoop/poll`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(GATEWAY_POLL_TIMEOUT_MS),
    });
    if (res.status === 404) {
      out(`The gateway at ${base} has no WHOOP routes yet; rebuild and restart it, and it will pick the tokens up.`);
      return;
    }
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const summary = await res.json() as WhoopSummary;
    if (summary.auth !== "ok" || summary.last_error) {
      out(`Gateway polled WHOOP: auth ${summary.auth}${summary.last_error ? `, ${summary.last_error}` : ""}`);
    } else {
      out(`Gateway polled WHOOP: ${summaryLine(summary)}`);
    }
  } catch (err) {
    out(`Tokens saved. The gateway at ${base} did not answer (${err instanceof Error ? err.message : String(err)}); it will pick them up on its next check.`);
  }
}

/* ---------- commands ---------- */

function parseRedirect(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`--redirect-uri is not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new CliError("--redirect-uri must be http or https");
  return url;
}

async function promptClient(term: Terminal): Promise<{ id: string; secret: string }> {
  const id = await term.ask("Client ID: ");
  const secret = await term.ask("Client Secret: ", true);
  if (!id || !secret) throw new CliError("both the Client ID and the Client Secret are required");
  return { id, secret };
}

/* A new client id invalidates the tokens issued to the old one. */
function withClient(cur: WhoopCredentials | null, id: string, secret: string, redirectUri: string): WhoopCredentials {
  const base = cur ?? emptyCredentials();
  const sameClient = base.client_id === id;
  return {
    ...(sameClient ? base : emptyCredentials()),
    client_id: id,
    client_secret: secret,
    redirect_uri: redirectUri,
  };
}

async function login(args: Args): Promise<void> {
  const path = whoopCredentialsPath();
  const term = new Terminal();
  try {
    let creds = await loadCredentials(path);
    const redirectUri = parseRedirect(args.flags.get("redirect-uri") ?? (creds?.redirect_uri || DEFAULT_REDIRECT_URI)).toString();
    out(`Redirect URI (register exactly this on the WHOOP app): ${redirectUri}`);
    if (!creds?.client_id || !creds.client_secret) {
      out("No WHOOP client stored yet. Create an app at https://developer-dashboard.whoop.com, then enter its credentials.");
      const { id, secret } = await promptClient(term);
      creds = await updateCredentials(path, cur => withClient(cur, id, secret, redirectUri));
    } else if (creds.redirect_uri !== redirectUri) {
      creds = await updateCredentials(path, cur => ({ ...(cur ?? creds as WhoopCredentials), redirect_uri: redirectUri }));
    }
    const { client_id: clientId, client_secret: clientSecret } = creds;

    const state = newState();
    const authorizeUrl = buildAuthorizeUrl({ clientId, redirectUri, state });
    const redirect = new URL(redirectUri);
    if (process.env.SSH_CONNECTION) {
      out("\nOpen this URL in a browser signed in to WHOOP:");
      out(authorizeUrl);
      out("\nThe browser cannot reach this machine's localhost over SSH, so after approving,");
      out("copy the full URL from its address bar and paste it here.");
    } else {
      out("\nOpening the WHOOP consent page in your browser. If it does not open, visit:");
      out(authorizeUrl);
      const child = spawn("open", [authorizeUrl], { stdio: "ignore", detached: true });
      child.on("error", () => out("(could not run `open`; use the URL above)"));
      child.unref();
    }
    out(`Waiting for the redirect on port ${callbackPort(redirect)} (5 minutes)...`);

    const code = await waitForCode({ redirect, state, term });
    let tokens;
    try {
      tokens = await exchangeCode({ clientId, clientSecret, redirectUri, code });
    } catch (err) {
      if (err instanceof TokenError) throw new CliError(`code exchange failed: ${err.message}`);
      throw err;
    }
    if (!tokens.refresh_token) {
      throw new CliError("WHOOP returned no refresh token, so the daemon could not stay connected. Check that the app allows the offline scope.");
    }
    const saved = await updateCredentials(path, cur => applyTokens(withClient(cur, clientId, clientSecret, redirectUri), tokens));
    out(`\nSaved tokens to ${path} (mode 600). Access token expires ${saved.expires_at}.`);

    try {
      const profile = await new WhoopApi({ base: whoopApiBase(), token: async () => saved.access_token as string }).profile();
      const name = [profile.first_name, profile.last_name].filter(Boolean).join(" ");
      out(`Connected as ${name || profile.email || `WHOOP user ${profile.user_id ?? "?"}`}${name && profile.email ? ` <${profile.email}>` : ""}.`);
    } catch (err) {
      out(`Connected (profile lookup failed: ${err instanceof Error ? err.message : String(err)}).`);
    }
    await pokeGateway();
  } finally {
    term.close();
  }
}

function relative(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (Math.abs(min) < 90) return min >= 0 ? `in ${min} min` : `${-min} min ago`;
  const h = Math.round(min / 6) / 10;
  return h >= 0 ? `in ${h} h` : `${-h} h ago`;
}

async function status(): Promise<void> {
  const path = whoopCredentialsPath();
  out(`Credentials: ${path}`);
  let creds: WhoopCredentials | null;
  try {
    creds = await loadCredentials(path);
  } catch (err) {
    if (err instanceof CredentialsError) throw new CliError(err.message);
    throw err;
  }
  out(`Client:      ${creds?.client_id ? `${creds.client_id} (secret stored)` : "not set (run whoop-auth)"}`);
  if (creds?.redirect_uri) out(`Redirect:    ${creds.redirect_uri}`);
  if (hasTokens(creds)) {
    const expiry = Date.parse(creds.expires_at ?? "");
    out(`Tokens:      connected${creds.obtained_at ? ` since ${creds.obtained_at}` : ""}`);
    out(`Access:      ${Number.isFinite(expiry) ? `expires ${creds.expires_at} (${relative(expiry - Date.now())}); the daemon refreshes it` : "expiry unknown"}`);
    if (creds.scope) out(`Scope:       ${creds.scope}`);
  } else {
    out("Tokens:      not connected (run whoop-auth)");
  }
  const cachePath = whoopCachePath();
  const cached = readWhoopCache(cachePath);
  if (!cached) {
    out(`Last pull:   none cached (${cachePath})`);
    return;
  }
  const summary = buildSummary(cached.raw, new Date(), {
    auth: hasTokens(creds) ? "ok" : "not_configured",
    fetchedAt: cached.fetchedAt,
    lastPollOk: true,
    nextPollAt: null,
    lastError: null,
  });
  out(`Last pull:   ${summary.fetched_at} (${relative(cached.fetchedAt - Date.now())})${summary.stale ? ", stale" : ""}`);
  out(`             ${summaryLine(summary)}`);
}

async function setClient(args: Args): Promise<void> {
  const path = whoopCredentialsPath();
  const term = new Terminal();
  try {
    const current = await loadCredentials(path);
    const redirectUri = parseRedirect(args.flags.get("redirect-uri") ?? (current?.redirect_uri || DEFAULT_REDIRECT_URI)).toString();
    const { id, secret } = await promptClient(term);
    const saved = await updateCredentials(path, cur => withClient(cur, id, secret, redirectUri));
    out(`Saved the client to ${path}.`);
    out(hasTokens(saved) ? "Tokens kept (same client id)." : "Run `whoop-auth` to connect an account.");
  } finally {
    term.close();
  }
}

async function logout(): Promise<void> {
  const path = whoopCredentialsPath();
  if (!(await loadCredentials(path))) {
    out(`Nothing to log out of (${path} does not exist).`);
    return;
  }
  await updateCredentials(path, cur => ({
    ...(cur ?? emptyCredentials()),
    access_token: null, refresh_token: null, expires_at: null, scope: null, obtained_at: null,
  }));
  out("Tokens removed; the client id and secret are kept. Run `whoop-auth` to connect again.");
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.flags.has("help") || args.command === "help") return out(USAGE);
  switch (args.command) {
    case "login": return login(args);
    case "status": return status();
    case "set-client": return setClient(args);
    case "logout": return logout();
    default: throw new CliError(`unknown command "${args.command}"\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).catch(err => {
  const message = err instanceof CliError || err instanceof CredentialsError
    ? err.message
    : (err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.stderr.write(`whoop-auth: ${message}\n`);
  process.exitCode = 1;
});
