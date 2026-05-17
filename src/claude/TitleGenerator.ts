import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { autodetectClaudePath } from "../settings";

/* Spawns a one-off `claude --print` call with a small fast model (Haiku by
   default) and a focused prompt asking for a short conversation title.
   Several speed optimizations are layered in:
     - --system-prompt overrides the default system prompt entirely, so the
       CLI skips CLAUDE.md auto-discovery, auto-memory loading, dynamic
       per-machine context, and skill catalog injection — none of which a
       title-generation pass needs.
     - --tools "" empties the tool catalog so no tool definitions are sent
       to the API.
     - --disable-slash-commands skips slash-command discovery on startup.
     - --setting-sources user limits config loading to ~/.claude only,
       skipping per-project + local settings walks.
     - --no-session-persistence keeps these throwaways out of the user's
       saved session list. */

export type TitleGenOptions = {
  userMessage: string;
  /* Optional. When present, included in the prompt for richer topic signal.
     When absent (parallel-fire mode — title-gen kicked off at submit, before
     the assistant has streamed), the prompt asks Haiku to title from the
     user's question alone. */
  assistantResponse?: string;
  /* Path to the `claude` binary. Empty falls back to PATH lookup. */
  claudePath?: string;
  /* Model alias (e.g. "haiku" or "claude-haiku-4-5-20251001"). */
  model: string;
  /* Working dir for the subprocess (vault root usually). */
  cwd: string;
};

/* Minimal system prompt — the only instructions Haiku needs. No vault
   awareness, no tool catalog, no skill listings. Phrased emphatically so
   Haiku doesn't try to "respond" to the conversation snippet as if it were
   the next turn. */
const TITLE_SYSTEM_PROMPT =
  "You are a title generator. " +
  "Your input is a record of an existing chat between a user and another AI. " +
  "Your output is a 3-6 word title summarizing the topic. " +
  "Never continue the conversation, never answer the user's question, never reply as the AI. " +
  "Reply with ONLY the title text — no quotes, no preamble, no trailing punctuation.";

export async function generateTitle(opts: TitleGenOptions): Promise<string | null> {
  const cmd = opts.claudePath || autodetectClaudePath() || "claude";

  /* Truncate both sides of the conversation snippet so input tokens stay
     small. Title generation doesn't need the full response — the first
     few hundred characters carry enough topic signal. */
  const truncatedUser = opts.userMessage.length > 300
    ? opts.userMessage.slice(0, 300) + "…"
    : opts.userMessage;
  const truncatedResponse = opts.assistantResponse && opts.assistantResponse.length > 400
    ? opts.assistantResponse.slice(0, 400) + "…"
    : opts.assistantResponse ?? "";

  /* Strong framing so the model treats the snippet as DATA, not as a real
     conversation directed at it. XML-style tags + a trailing "Title:"
     priming cue land Haiku reliably on a single short title.

     Two prompt shapes depending on whether we have an assistant response
     yet. Parallel-fire mode (no response) uses the user-only shape so the
     title can start generating the moment the user submits. */
  const prompt = truncatedResponse
    ? "The transcript below is a chat I had with another AI. Output only a 3-6 word title summarizing the topic.\n" +
      "\n" +
      "<transcript>\n" +
      `[my message]\n${truncatedUser}\n` +
      "\n" +
      `[the AI's reply]\n${truncatedResponse}\n` +
      "</transcript>\n" +
      "\n" +
      "Title:"
    : "The message below is the opening message of a chat I just started with another AI. Output only a 3-6 word title describing the topic the user is asking about.\n" +
      "\n" +
      "<message>\n" +
      `${truncatedUser}\n` +
      "</message>\n" +
      "\n" +
      "Title:";

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
    "--system-prompt", TITLE_SYSTEM_PROMPT,
    "--tools", "",
    "--disable-slash-commands",
    "--setting-sources", "user",
    "--no-session-persistence",
    prompt,
  ];

  /* eslint-disable no-console */
  const t0 = Date.now();
  console.log(`[claude-cli-chat] title-gen spawn`, { cmd, model: opts.model });

  /* cwd existence check: a missing cwd causes spawn() to emit ENOENT on the
     child's `error` event, but pre-checking gives a clearer log and avoids
     the spawn overhead entirely. */
  if (!existsSync(opts.cwd)) {
    console.warn(`[claude-cli-chat] title-gen skipped: cwd does not exist: ${opts.cwd}`);
    return null;
  }

  return new Promise<string | null>((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        PATH: enrichedPath,
        CLAUDE_CODE_ENTRYPOINT: "claude-cli-chat-titlegen",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    /* Hard cap so a malformed reply can't bloat memory. */
    const MAX_OUTPUT = 1024;
    child.stdout.on("data", chunk => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
    });
    let stderrBuf = "";
    child.stderr.on("data", chunk => { stderrBuf += chunk.toString("utf8"); });

    /* 30s timeout — anything longer indicates a hang. Title gen on Haiku
       with the optimizations above should be ~1.5-3s typically. */
    const timeout = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      console.warn(`[claude-cli-chat] title-gen TIMEOUT after ${Date.now() - t0}ms`);
      resolve(null);
    }, 30000);

    /* Use `close` instead of `exit` so stdout is fully drained before we
       call cleanTitle(). `exit` fires when the process terminates but
       stdout may still have buffered data; `close` waits for the stdio
       streams to flush too. */
    child.on("close", code => {
      clearTimeout(timeout);
      const elapsed = Date.now() - t0;
      if (code !== 0) {
        console.warn(`[claude-cli-chat] title-gen failed in ${elapsed}ms (exit ${code})`, { stderr: stderrBuf.slice(0, 400) });
        resolve(null);
        return;
      }
      const cleaned = cleanTitle(stdout);
      console.log(`[claude-cli-chat] title-gen done in ${elapsed}ms`, { title: cleaned });
      resolve(cleaned);
    });
    child.on("error", err => {
      clearTimeout(timeout);
      console.warn(`[claude-cli-chat] title-gen spawn error`, err);
      resolve(null);
    });
  });
}

/* Sanitize the model's reply: trim, strip wrapping quotes, drop a trailing
   period, collapse whitespace. Rejects responses that look like the model
   "continuing" the conversation rather than titling it. */
function cleanTitle(raw: string): string | null {
  let title = raw.trim();
  if (!title) return null;
  /* Strip wrapping matching quote marks. */
  if ((title.startsWith('"') && title.endsWith('"')) ||
      (title.startsWith("'") && title.endsWith("'"))) {
    title = title.slice(1, -1).trim();
  }
  /* Some models prefix the title with "Title:" — strip that. */
  title = title.replace(/^title:\s*/i, "");
  /* Collapse internal whitespace. */
  title = title.replace(/\s+/g, " ");
  /* Trim a trailing period. */
  if (title.endsWith(".")) title = title.slice(0, -1);
  if (!title) return null;

  /* Reject continuation-style responses. If the model produced something
     long and conversational ("I don't see any file..."), it's tried to
     reply to the user instead of titling. The fallback (first 48 chars of
     the user message, set during submit) is a better tab label than that. */
  const wordCount = title.split(/\s+/).length;
  if (wordCount > 10) return null;
  if (/^(i (don'?t|can|cannot|see|notice|understand|appreciate|think|believe|am|will|do)\b|sorry\b|here\b|let me\b|sure\b|of course\b|certainly\b)/i.test(title)) {
    return null;
  }

  if (title.length > 60) title = title.slice(0, 60).trimEnd() + "…";
  return title;
}
