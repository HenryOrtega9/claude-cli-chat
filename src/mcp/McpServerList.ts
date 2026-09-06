import { spawn } from "node:child_process";

/* The real set of MCP servers the Claude Code CLI loads on a subprocess
   spawn lives in the CLI's own config sources (~/.claude.json user scope,
   per-project scope, and the claude.ai account connectors). Our vault-local
   .claude/mcp.json is NOT one of those sources — the CLI ignores it — so the
   only complete, authoritative list is whatever `claude mcp list` reports.
   This module shells out to that command and parses its line-oriented output
   so the MCP manager modal and the cost-surface pill can show every server
   the spawned chat actually sees, instead of a stale local subset. */

export type McpServerStatus = "connected" | "pending" | "failed" | "unknown";

export type ParsedMcpServer = {
  /** Display name as the CLI prints it, e.g. "claude.ai Gmail". */
  name: string;
  /** Command line (stdio) or URL (remote) the CLI shows after the name. */
  endpoint: string;
  transport: "stdio" | "remote" | "unknown";
  status: McpServerStatus;
  /** Human-readable status text with the leading glyph stripped. */
  statusText: string;
};

function classifyStatus(text: string): McpServerStatus {
  const t = text.toLowerCase();
  if (/connected/.test(t)) return "connected";
  if (/pending|approval|auth/.test(t)) return "pending";
  if (/fail|error|disconnect|not connected/.test(t)) return "failed";
  return "unknown";
}

/* Parse the stdout of `claude mcp list`. Each server is one line shaped like:
     <name>: <command-or-url> - <glyph> <status>
   The name can contain spaces and dots ("claude.ai Google Drive"); the
   endpoint (a URL) can contain colons, so we split the name off the FIRST
   ": " and the status off the LAST " - ". A leading "Checking MCP server
   health…" banner and any blank lines have no ": " and are skipped. The
   parser is deliberately tolerant: an unrecognized line is dropped rather
   than aborting the whole list, since the CLI's exact phrasing may drift
   across versions. */
export function parseMcpListOutput(text: string): ParsedMcpServer[] {
  const out: ParsedMcpServer[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || !line.includes(": ")) continue;

    let left = line;
    let statusRaw = "";
    const dash = line.lastIndexOf(" - ");
    if (dash !== -1) {
      left = line.slice(0, dash);
      statusRaw = line.slice(dash + 3).trim();
    }

    const colon = left.indexOf(": ");
    if (colon === -1) continue;
    const name = left.slice(0, colon).trim();
    const endpoint = left.slice(colon + 2).trim();
    if (!name) continue;

    /* Strip the leading status glyph (✓ / ✗ / ⏸ …) and any spacing so the
       text starts at the first letter. */
    const statusText = statusRaw.replace(/^[^A-Za-z]+/, "").trim();
    const transport: ParsedMcpServer["transport"] = /^https?:\/\//i.test(endpoint)
      ? "remote"
      : endpoint
        ? "stdio"
        : "unknown";

    out.push({ name, endpoint, transport, status: classifyStatus(statusText), statusText });
  }
  return out;
}

/* Spawn `claude mcp list` and resolve the parsed server set. PATH is enriched
   the same way the modal's status check does, since Obsidian launched from
   Finder/Dock doesn't inherit the shell PATH and `claude` lives in
   ~/.local/bin. Rejects on non-zero exit, spawn error, or timeout so callers
   can fall back to whatever runtime data they already have. */
export function listMcpServersViaCli(claudePath: string, timeoutMs = 30_000): Promise<ParsedMcpServer[]> {
  return new Promise((resolve, reject) => {
    const home = process.env.HOME ?? "";
    const enrichedPath = [
      home ? `${home}/.local/bin` : "",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      process.env.PATH ?? "",
    ].filter(Boolean).join(":");

    const child = spawn(claudePath || "claude", ["mcp", "list"], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: enrichedPath },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      /* Escalate to SIGKILL if SIGTERM is ignored (e.g. wedged mid-network/auth
         during health checks). Mirrors TitleGenerator's reap so a hung
         `claude mcp list` can't survive as an orphan after we drop the child
         reference. Harmless if the process already exited. */
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 2000);
      finish(() => reject(new Error("claude mcp list timed out")));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", err => finish(() => reject(err)));
    /* Resolve on `close`, not `exit`: `exit` can fire while stdout still holds
       undelivered chunks, so a long server list would be parsed truncated and
       servers would silently vanish from the modal / pill. `close` only fires
       after both stdio streams have ended (same hazard QuickPrompt and
       SubprocessManager guard against). */
    child.on("close", code => finish(() => {
      if (code === 0) resolve(parseMcpListOutput(stdout));
      else reject(new Error(stderr.trim() || stdout.trim() || `claude mcp list exited ${code}`));
    }));
  });
}
