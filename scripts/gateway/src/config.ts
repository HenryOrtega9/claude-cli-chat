/* Environment + bind resolution for the Vault Gateway daemon.

   Contract: docs/ios-gateway/CONTRACTS.md § Gateway daemon. Every knob is an
   env var so the launchd plist is the only place a machine-specific value
   lives. The bind resolver is a direct port of scripts/watch-bridge/bridge.py
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
    tokenFile: process.env.VAULT_GATEWAY_TOKEN_FILE || `${HOME}/.config/vault-gateway/token`,
    maxChildren: envInt("VAULT_GATEWAY_MAX_CHILDREN", 4),
    approvalTimeoutS: envInt("VAULT_GATEWAY_APPROVAL_TIMEOUT_S", 600),
    claudePath: process.env.VAULT_GATEWAY_CLAUDE || "",
    stateMirrorPath: process.env.VAULT_GATEWAY_STATE_FILE || "/tmp/claude_state.ios",
  };
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
