import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { autodetectClaudePath } from "../settings-autodetect";

/* One-shot `claude --print` helper for the plugin's small side passes
   (auto-titling a tab, suggesting the user's next reply). Each caller
   supplies a focused system prompt + user prompt and gets back the trimmed
   stdout, or null on any failure. The spawn is stripped down for speed:
     - --system-prompt overrides the default system prompt entirely, so the
       CLI skips CLAUDE.md auto-discovery, auto-memory loading, dynamic
       per-machine context, and skill catalog injection — none of which a
       side pass needs.
     - --tools "" empties the tool catalog so no tool definitions are sent
       to the API.
     - --disable-slash-commands skips slash-command discovery on startup.
     - --setting-sources user limits config loading to ~/.claude only,
       skipping per-project + local settings walks.
     - --no-session-persistence keeps these throwaways out of the user's
       saved session list. NOTE: the CLI still writes a one-line `ai-title`
       record to ~/.claude/projects/<slug>/<random-id>.jsonl regardless
       (wire-format gotcha #7), so callers must skip incognito tabs.

   Extracted from TitleGenerator so the reply suggester shares one spawn
   path — PATH enrichment, UTF-8 chunk-boundary decoding, the SIGTERM →
   SIGKILL timeout escalation, and `close`-not-`exit` draining are all
   behaviors that were debugged once and shouldn't be re-learned twice. */

export type QuickPromptOptions = {
  /* Path to the `claude` binary. Empty falls back to PATH lookup. */
  claudePath?: string;
  /* Model alias (e.g. "haiku" or "claude-haiku-4-5-20251001"). */
  model: string;
  /* Working dir for the subprocess (vault root usually). */
  cwd: string;
  systemPrompt: string;
  prompt: string;
  /* Tag for CLAUDE_CODE_ENTRYPOINT so the CLI's own telemetry can tell the
     side passes apart from real chat turns. */
  entrypoint: string;
  /* Log prefix, e.g. "title-gen". */
  label: string;
  /* Hard cap on the reply we keep, in chars. Anything longer is truncated. */
  maxOutputChars?: number;
  timeoutMs?: number;
};

export async function runQuickPrompt(opts: QuickPromptOptions): Promise<string | null> {
  const cmd = opts.claudePath || autodetectClaudePath() || "claude";
  const maxOutput = opts.maxOutputChars ?? 1024;
  const timeoutMs = opts.timeoutMs ?? 30000;

  /* PATH enrichment matches SubprocessManager so the binary resolves from a
     Finder-launched Obsidian even when the shell PATH wasn't inherited.
     Guard `~/.local/bin` when HOME is unset so we don't inject a bare
     `/.local/bin`. Also append the dir containing the claude binary when an
     explicit path was provided, so sibling tooling resolves alongside it. */
  const home = process.env.HOME ?? "";
  const claudeDir = opts.claudePath ? dirname(opts.claudePath) : "";
  const enrichedPath = [
    process.env.PATH ?? "",
    home ? `${home}/.local/bin` : "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    claudeDir,
  ].filter(Boolean).join(":");

  const args = [
    "--print",
    "--model", opts.model,
    "--system-prompt", opts.systemPrompt,
    "--tools", "",
    "--disable-slash-commands",
    "--setting-sources", "user",
    "--no-session-persistence",
    opts.prompt,
  ];

  /* eslint-disable no-console */
  const t0 = Date.now();
  console.log(`[claude-cli-chat] ${opts.label} spawn`, { cmd, model: opts.model });

  /* cwd existence check: a missing cwd causes spawn() to emit ENOENT on the
     child's `error` event, but pre-checking gives a clearer log and avoids
     the spawn overhead entirely. */
  if (!existsSync(opts.cwd)) {
    console.warn(`[claude-cli-chat] ${opts.label} skipped: cwd does not exist: ${opts.cwd}`);
    return null;
  }

  return new Promise<string | null>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        PATH: enrichedPath,
        CLAUDE_CODE_ENTRYPOINT: opts.entrypoint,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    /* Decode at string boundaries: a multi-byte UTF-8 code point (any
       non-ASCII char) can straddle two stdout chunks, and decoding each
       Buffer independently would turn each half into U+FFFD. StringDecoder
       holds a straddling sequence's leading bytes until the next chunk
       completes it. */
    const decoder = new StringDecoder("utf8");
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < maxOutput) stdout += decoder.write(chunk);
    });
    let stderrBuf = "";
    child.stderr.on("data", chunk => { stderrBuf += chunk.toString("utf8"); });

    /* Anything past the timeout indicates a hang; a Haiku side pass with
       the optimizations above should be ~1.5-3s typically. */
    const timeout = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      /* Escalate to SIGKILL if SIGTERM is ignored (e.g. wedged mid-network
         retry). We've already resolved(null), so without this a hung
         `claude --print` survives as an orphan holding the API connection. The
         kill is harmless if the process already exited. */
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 2000);
      console.warn(`[claude-cli-chat] ${opts.label} TIMEOUT after ${Date.now() - t0}ms`);
      resolve(null);
    }, timeoutMs);

    /* Use `close` instead of `exit` so stdout is fully drained before we
       resolve. `exit` fires when the process terminates but stdout may still
       have buffered data; `close` waits for the stdio streams to flush too. */
    child.on("close", code => {
      clearTimeout(timeout);
      const elapsed = Date.now() - t0;
      if (code !== 0) {
        console.warn(`[claude-cli-chat] ${opts.label} failed in ${elapsed}ms (exit ${code})`, { stderr: stderrBuf.slice(0, 400) });
        resolve(null);
        return;
      }
      /* Flush any final code point the decoder is still holding. */
      if (stdout.length < maxOutput) stdout += decoder.end();
      console.log(`[claude-cli-chat] ${opts.label} done in ${elapsed}ms`);
      resolve(stdout.slice(0, maxOutput));
    });
    child.on("error", err => {
      clearTimeout(timeout);
      console.warn(`[claude-cli-chat] ${opts.label} spawn error`, err);
      resolve(null);
    });
  });
}
