/* Vault Gateway daemon — entry point.

   Boot order matters and is load-bearing:
     1. Read (or generate) the bearer token. Without it every request 401s,
        so there is no point listening first.
     2. Install the node Platform so the shared stores have file I/O.
     3. Listen. /health answers `starting` from this moment, which is what the
        phone's connectivity banner keys on.
     4. Restore tabs, prime the MCP deny patterns, warm the catalog. When that
        finishes, /health flips to `ready`.

   Children are NOT respawned on restore: a tab gets a `claude` child on its
   next turn, resuming by session id. A restart therefore costs nothing but
   the first token of latency on the next message. */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadConfig, resolveBind } from "./config";
import { installNodePlatform } from "./platform-node";
import { loadOrCreateToken } from "./token";
import { detectClaudePath } from "./catalog";
import { TabRegistry } from "./registry";
import { GatewayServer } from "./server";
import { StateMirror } from "./state-mirror";
import type { Frame } from "./frames";

const STORE_DIR = ".claude-cli-chat/ios";

/* SubprocessManager's TabSession (src/claude/SubprocessManager.ts) traces
   every stream event and stderr chunk through bare `console.log`/
   `console.warn`, unconditionally. In the Obsidian plugin those land in a
   DevTools console that gets cleared; here they land on stdout, which the
   launchd plist pins to an unrotated /tmp/vault-gateway.log for the whole
   life of the daemon. With --include-partial-messages on by default (the
   default below) that's roughly one ~500-byte line per token delta per tab,
   forever — burying this file's own log() calls at a ratio of thousands to
   one and growing the log without bound. Gated behind an explicit opt-in
   rather than removed outright, since the trace is genuinely useful when
   chasing a wire-format bug. Installed before anything can spawn a child
   (TabRegistry/SubprocessManager are constructed further down, after this
   module's imports have already resolved), so no event is ever traced
   unless asked for. log() below is unaffected: it writes to stdout directly
   rather than through console.log. */
if (process.env.VAULT_GATEWAY_TRACE_EVENTS !== "1") {
  console.log = () => {};
  console.warn = () => {};
}

function log(msg: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function version(): string {
  try {
    const manifest = JSON.parse(readFileSync(resolve(__dirname, "../../../manifest.json"), "utf8")) as { version?: string };
    return manifest.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const startedAt = Date.now();

  const token = loadOrCreateToken(config.tokenFile, log);
  installNodePlatform(config.vault, log);

  /* Persistence's quit-time flushSync path takes its fs handle by injection
     now that the module is browser-safe. Optional-chained so this keeps
     building against either side of that refactor. */
  const persistenceModule = await import("../../../src/storage/Persistence") as {
    setSyncFileWriter?: (w: unknown) => void;
  };
  persistenceModule.setSyncFileWriter?.(await import("node:fs"));

  const claudePath = config.claudePath || detectClaudePath();
  const mirror = new StateMirror(config.stateMirrorPath);

  let ready = false;
  let server: GatewayServer;
  let denyPatterns: string[] = [];

  const registry = new TabRegistry({
    vault: config.vault,
    storeDir: STORE_DIR,
    claudePath,
    maxChildren: config.maxChildren,
    approvalTimeoutMs: config.approvalTimeoutS * 1000,
    includePartialMessages: process.env.VAULT_GATEWAY_PARTIAL !== "0",
    mcpDenyPatterns: () => denyPatterns,
    emit: (frame: Frame) => server?.broadcast(frame),
    onStateChange: () => mirror.reflect(registry.list()),
    log,
  });

  server = new GatewayServer({
    config,
    registry,
    token,
    mirror,
    claudePath,
    startedAt,
    version: version(),
    isReady: () => ready,
    log,
  });

  const bind = await resolveBind(config.bind, log);
  await server.listen(bind, config.port);
  log(`vault-gateway listening on http://${bind}:${config.port} (vault: ${config.vault})`);
  log(`claude: ${claudePath} | maxChildren: ${config.maxChildren} | approval timeout: ${config.approvalTimeoutS}s`);

  /* --- async warm-up; /health reports `starting` until this lands --- */
  try {
    const { MCPConfigStore } = await import("../../../src/mcp/MCPConfig");
    denyPatterns = await new MCPConfigStore(null).getDenyPatterns();
    if (denyPatterns.length > 0) log(`mcp deny patterns: ${denyPatterns.join(", ")}`);
  } catch (err) {
    log(`mcp deny pattern prime failed: ${String(err)}`);
  }
  await registry.restore();
  mirror.set("idle");
  ready = true;
  log("state: ready");
  /* Warm the catalog off the critical path — the first /catalog would
     otherwise pay for a `claude mcp list` spawn while the phone waits. */
  void server.catalog().then(c => log(`catalog warm (hash ${c.hash}, ${c.mcpServers.length} mcp server(s))`)).catch(() => undefined);

  const shutdown = async (signal: string) => {
    log(`${signal} received; shutting down`);
    mirror.set("idle");
    try { await server.close(); } catch { /* already closing */ }
    try { await registry.shutdown(); } catch (err) { log(`shutdown error: ${String(err)}`); }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  /* A throw inside an event handler must not take the daemon down with a live
     conversation attached; log it and keep serving. */
  process.on("uncaughtException", err => log(`uncaughtException: ${err.stack ?? String(err)}`));
  process.on("unhandledRejection", err => log(`unhandledRejection: ${String(err)}`));
}

main().catch(err => {
  process.stderr.write(`[vault-gateway] FATAL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
