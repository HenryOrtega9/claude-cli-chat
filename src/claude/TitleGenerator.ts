import { runQuickPrompt } from "./QuickPrompt";

/* Spawns a one-off `claude --print` call with a small fast model (Haiku by
   default) and a focused prompt asking for a short conversation title. The
   spawn itself — stripped-down CLI flags, PATH enrichment, UTF-8 chunk
   decoding, timeout escalation — lives in QuickPrompt and is shared with
   the reply suggester. */

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
  /* When true, the parent tab is incognito. Title generation is skipped
     entirely: even with --no-session-persistence the CLI still writes a
     one-line `ai-title` record to ~/.claude/projects/<slug>/<session-id>.jsonl
     (Wire-format gotcha #6), and that session id is independent of the chat's
     own session — so the incognito teardown cleanup never sees it. Skipping is
     the only way to honor the "incognito tabs must touch no disk" invariant
     for this throwaway subprocess. */
  incognito?: boolean;
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
  /* Incognito tabs must touch no disk. The title-gen subprocess leaves an
     `ai-title` jsonl behind (gotcha #6) that no cleanup path reclaims, so
     never spawn it for an incognito tab. */
  if (opts.incognito) return null;

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

  const raw = await runQuickPrompt({
    claudePath: opts.claudePath,
    model: opts.model,
    cwd: opts.cwd,
    systemPrompt: TITLE_SYSTEM_PROMPT,
    prompt,
    entrypoint: "claude-cli-chat-titlegen",
    label: "title-gen",
    /* Hard cap so a malformed reply can't bloat memory. */
    maxOutputChars: 1024,
    /* 30s — anything longer indicates a hang. Title gen on Haiku with the
       QuickPrompt trimming should be ~1.5-3s typically. */
    timeoutMs: 30000,
  });
  if (raw === null) return null;
  const cleaned = cleanTitle(raw);
  console.log(`[claude-cli-chat] title-gen result`, { title: cleaned });
  return cleaned;
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
