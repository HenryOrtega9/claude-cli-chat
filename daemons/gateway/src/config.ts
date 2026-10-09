/* Environment + bind resolution for the Vault Gateway daemon.

   Contract: docs/ios-gateway/CONTRACTS.md § Gateway daemon. Every knob is an
   env var so the launchd plist is the only place a machine-specific value
   lives. The bind resolver is a direct port of daemons/watch-bridge/bridge.py
   `resolve_bind()`: prefer the Tailscale CLI, fall back to parsing utun
   addresses out of ifconfig (the CLI can't reach the GUI helper from a
   launchd session and exits 0 with a CLIError on stdout), and never fall back
   to 0.0.0.0. */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export const HOME = homedir();

/* Tailscale hands out addresses from the CGNAT block 100.64.0.0/10. Matching
   the whole /10 (not just 100.64/16) keeps this correct for tailnets that
   have grown past the first /16. */
const TAILNET_IP_RE = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;

const TAILSCALE_CLI = existsSync("/Applications/Tailscale.app/Contents/MacOS/Tailscale")
  ? "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
  : "/usr/local/bin/tailscale";

export type GatewayConfig = {
  vault: string;
  port: number;
  bind: string | null;
  tokenFile: string;
  maxChildren: number;
  approvalTimeoutS: number;
  claudePath: string;
  stateMirrorPath: string;
  healthDb: string;
  whoopCredentials: string;
  whoopCache: string;
  whoopReadTokenFile: string;
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(): GatewayConfig {
  const vault = process.env.VAULT_GATEWAY_VAULT ?? "";
  if (!vault) {
    throw new Error("VAULT_GATEWAY_VAULT is required (absolute path to the vault / working directory)");
  }
  return {
    vault: resolve(vault),
    port: envInt("VAULT_GATEWAY_PORT", 8788),
    bind: process.env.VAULT_GATEWAY_BIND || null,
    tokenFile: gatewayTokenPath(),
    maxChildren: envInt("VAULT_GATEWAY_MAX_CHILDREN", 4),
    approvalTimeoutS: envInt("VAULT_GATEWAY_APPROVAL_TIMEOUT_S", 600),
    claudePath: process.env.VAULT_GATEWAY_CLAUDE || "",
    stateMirrorPath: process.env.VAULT_GATEWAY_STATE_FILE || "/tmp/claude_state.ios",
    healthDb: healthDbPath(),
    whoopCredentials: whoopCredentialsPath(),
    whoopCache: whoopCachePath(),
    whoopReadTokenFile: expandHome(process.env.VAULT_GATEWAY_WHOOP_READ_TOKEN_FILE || `${HOME}/.config/vault-gateway/whoop-read-token`),
  };
}

function expandHome(raw: string): string {
  return resolve(raw.startsWith("~/") ? `${HOME}${raw.slice(1)}` : raw);
}

/* The main bearer token path. Shared with `whoop-auth`, which POSTs
   /whoop/poll with it after a login. */
export function gatewayTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.VAULT_GATEWAY_TOKEN_FILE || `${HOME}/.config/vault-gateway/token`);
}

/* Apple Health SQLite path, shared by the daemon and the `apple-health` CLI
   so both always agree. Deliberately outside the vault (raw health samples
   must never land in a git repo synced through iCloud). The parent directory
   is created by the store when it first opens, not here, so a bad path costs
   the health routes a 500 rather than the daemon its boot. */
export function healthDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.VAULT_GATEWAY_HEALTH_DB || `${HOME}/Library/Application Support/vault-gateway/apple-health.sqlite`);
}

/* WHOOP OAuth credentials (client id/secret plus the rotating token pair),
   shared by the daemon and `whoop-auth`. Mode 600 in a 700 directory; see
   whoop/credentials.ts for the locking rules. */
export function whoopCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.WHOOP_CREDENTIALS_FILE || `${HOME}/.config/whoop/credentials.json`);
}

/* The last good WHOOP pull, so a restart serves data before its first poll.
   Next to the Apple Health store: health data, outside the vault. */
export function whoopCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.VAULT_GATEWAY_WHOOP_CACHE || `${HOME}/Library/Application Support/vault-gateway/whoop-cache.json`);
}

/* Where `whoop-auth` reaches the running daemon: the same bind the daemon
   resolves, but one non-blocking attempt (a CLI must not sit through
   resolveBind's 60 s retry loop), falling back to loopback. */
export function localGatewayUrl(env: NodeJS.ProcessEnv = process.env): string {
  const rawPort = Number.parseInt(env.VAULT_GATEWAY_PORT ?? "", 10);
  const port = Number.isFinite(rawPort) && rawPort > 0 ? rawPort : 8788;
  const host = env.VAULT_GATEWAY_BIND || tailnetIpFromCli() || tailnetIpFromInterfaces() || "127.0.0.1";
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}

function tailnetIpFromInterfaces(): string | null {
  try {
    const out = execFileSync("/sbin/ifconfig", { encoding: "utf8", timeout: 5000 });
    for (const m of out.matchAll(/inet (100\.\d+\.\d+\.\d+)/g)) {
      if (TAILNET_IP_RE.test(m[1])) return m[1];
    }
  } catch {
    /* ifconfig missing or slow; fall through */
  }
  return null;
}

function tailnetIpFromCli(): string | null {
  try {
    const out = execFileSync(TAILSCALE_CLI, ["ip", "-4"], { encoding: "utf8", timeout: 5000 });
    const ip = out.trim().split("\n")[0]?.trim() ?? "";
    if (TAILNET_IP_RE.test(ip)) return ip;
  } catch {
    /* CLI absent or unreachable from launchd; fall through */
  }
  return null;
}

/* Blocks (async) up to 60s waiting for Tailscale to come up, exactly like the
   watch bridge. Explicit VAULT_GATEWAY_BIND short-circuits it — that's the
   `127.0.0.1` path used when fronting the daemon with `tailscale serve`. */
export async function resolveBind(explicit: string | null, log: (msg: string) => void): Promise<string> {
  if (explicit) return explicit;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const fromCli = tailnetIpFromCli();
    if (fromCli) return fromCli;
    const fromIfconfig = tailnetIpFromInterfaces();
    if (fromIfconfig) return fromIfconfig;
    await new Promise(r => setTimeout(r, 2000));
  }
  log("FATAL: could not resolve Tailscale IPv4 after 60s (is Tailscale running?). Set VAULT_GATEWAY_BIND to override.");
  process.exit(1);
}
