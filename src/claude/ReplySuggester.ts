import { runQuickPrompt } from "./QuickPrompt";

/* After each successful turn, propose the user's next message from the last
   exchange. One Haiku `claude --print` pass (see QuickPrompt for the spawn
   trimming). The result lands in the composer as ghost text that Tab
   accepts; anything the user types instead dismisses it. */

export type ReplySuggestOptions = {
  /* The user's most recent message (bubble text, not the wire text). */
  userMessage: string;
  /* The assistant's final reply for the turn. */
  assistantResponse: string;
  /* Path to the `claude` binary. Empty falls back to PATH lookup. */
  claudePath?: string;
  /* Model alias (e.g. "haiku" or "claude-haiku-4-5-20251001"). */
  model: string;
  /* Working dir for the subprocess (vault root usually). */
  cwd: string;
  /* When true, the parent tab is incognito and the pass is skipped: even
     with --no-session-persistence the CLI leaves an ai-title jsonl behind
     (wire-format gotcha #7) that no cleanup path reclaims. */
  incognito?: boolean;
};

/* Phrased emphatically so Haiku writes AS the user rather than answering the
   assistant's reply itself — the transcript is data, and the only valid
   output is the next thing the human would type. */
const SUGGEST_SYSTEM_PROMPT =
  "You write the USER's next message in an ongoing chat between a user and an AI assistant. " +
  "Your input is the user's last message and the assistant's reply to it. " +
  "Output ONE short follow-up the user would plausibly send next, written in the user's own first-person voice: " +
  "for example accepting an offer the assistant made, asking it to continue or go deeper, requesting a concrete next step, or asking a natural clarifying question. " +
  "If the assistant ended with a question or an offer, answer or accept it directly. " +
  "Never reply as the assistant, never answer the user's question, never explain or comment. " +
  "At most 15 words. Reply with ONLY the message text — no quotes, no preamble, no label.";

export async function suggestReply(opts: ReplySuggestOptions): Promise<string | null> {
  if (opts.incognito) return null;
  const user = opts.userMessage.trim();
  const reply = opts.assistantResponse.trim();
  if (!user || !reply) return null;

  /* The user side rarely needs more than its opening; the assistant side is
     the opposite — offers and questions cluster at the END of a reply, so
     keep the tail, with a little of the head for topic context. */
  const userSnippet = user.length > 600 ? user.slice(0, 600) + "…" : user;
  let replySnippet = reply;
  if (reply.length > 1800) {
    replySnippet = reply.slice(0, 500) + "\n…\n" + reply.slice(-1300);
  }

  const prompt =
    "Below is the latest exchange in my chat with an AI assistant. Write the next message I would send, in my voice. Output only that message.\n" +
    "\n" +
    "<exchange>\n" +
    `[my message]\n${userSnippet}\n` +
    "\n" +
    `[the assistant's reply]\n${replySnippet}\n` +
    "</exchange>\n" +
    "\n" +
    "My next message:";

  const raw = await runQuickPrompt({
    claudePath: opts.claudePath,
    model: opts.model,
    cwd: opts.cwd,
    systemPrompt: SUGGEST_SYSTEM_PROMPT,
    prompt,
    entrypoint: "claude-cli-chat-suggest",
    label: "reply-suggest",
    maxOutputChars: 600,
    timeoutMs: 20000,
  });
  return raw === null ? null : cleanSuggestion(raw);
}

/* Trim, strip wrapping quotes and stray labels, collapse whitespace, and
   reject anything that reads like the assistant talking rather than the
   user. Exported for tests. */
export function cleanSuggestion(raw: string): string | null {
  let text = raw.trim();
  if (!text) return null;
  /* Keep only the first paragraph — a model that "helpfully" lists three
     options has already broken the contract, and the first is the best. */
  text = text.split(/\n\s*\n/)[0].trim();
  text = text.replace(/^(my next message|next message|user|me|suggestion)\s*:\s*/i, "");
  text = text.replace(/^[-*•]\s+/, "");
  if ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'")) ||
      (text.startsWith("“") && text.endsWith("”"))) {
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const wordCount = text.split(/\s+/).length;
  if (wordCount > 30 || text.length > 200) return null;
  /* Assistant-voice tells: "I'd be happy to", "Here's", "As an AI". Plain
     acceptances ("Sure, go ahead") are exactly what a user types back to an
     offer, so they stay. */
  if (/^(here('s| is| are)|i('d| would) be (happy|glad)|as an ai|great question|i can help|i'll help)\b/i.test(text)) {
    return null;
  }
  return text;
}
