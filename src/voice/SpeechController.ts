/* Voice output for chat responses and notes, driven by macOS `say` child
   processes. Two entry points:

   - Streaming: TabController feeds the accumulating assistant message text
     via updateStream() on every delta. The controller tracks how far into
     each message it has already spoken and emits new speech only at sentence
     or line boundaries, so Claude talks while the reply is still streaming.
   - Whole documents: speakDocument() reads an arbitrary markdown string
     (the read-note-aloud command).

   Why `say` and not window.speechSynthesis: field-tested 2026-07-18 —
   Electron's speechSynthesis hands utterances to the macOS speech daemon
   and `cancel()` silently fails to reach it. Symptoms: the Voice pill's
   mute didn't stop audio, speech survived quitting Obsidian outright, and
   a voice change overlapped two voices (old utterance uncancellable while
   new ones started). A `say` child process is the opposite: kill() stops
   audio instantly and deterministically, one chunk-sized process at a time
   means an orphan can speak at most one sentence, and the voice roster
   (`say -v ?`) includes downloaded Enhanced/Premium voices. macOS-only,
   which this plugin already is.

   Channels (2026-07-19 review): every stream and queued chunk is tagged
   with an owner channel (a tab id, or DOCUMENT_CHANNEL for note reads).
   stop(channel) silences only that owner; stop() with no argument is the
   global kill (plugin unload, Stop-speaking command, note reads taking
   over). One audio device means one narration at a time: the first channel
   to enqueue holds the floor and other channels' chunks are dropped (their
   offsets still advance, so nothing floods out later). Stream offsets are
   monotonic and deliberately SURVIVE stop() — "spoken" really means
   "handed to the queue" — so an interrupted response resumes from where it
   left off instead of re-narrating from sentence one. */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { ClaudeChatSettings } from "../settings";

/* A stream = one assistant message being spoken incrementally. Keyed by
   message id. `spoken` is the index into the RAW markdown text up to which
   chunks have been enqueued (sanitization happens per-chunk, after
   slicing, so indices always refer to the raw text). */
type SpeechStream = {
  spoken: number;
  channel: string;
};

type QueueItem = {
  text: string;
  channel: string;
};

export type SayVoice = { name: string; lang: string };

/* Channel used by speakDocument (read-note-aloud, settings test). */
export const DOCUMENT_CHANNEL = "__document__";

/* Sentence/line boundary in prose: newline, or terminal punctuation followed
   by whitespace. Closing quotes/brackets may trail the punctuation. */
const BOUNDARY_RE = /[.!?][)"'’”\]]*\s|\n/g;

/* Minimum sanitized chunk length worth emitting mid-stream. Shorter
   fragments are dropped — they're markdown residue ("1.", stray quotes),
   not content; real short answers are covered by the `final` override in
   drainStream, which speaks any non-empty tail (so a reply of just "7"
   is still voiced). */
const MIN_CHUNK = 2;

/* `say -r` is words per minute; ~175 is the default speaking rate, so the
   settings slider's 0.5–2.0 multiplier maps around that. */
const BASE_WPM = 175;

const SAY_BIN = "/usr/bin/say";

export class SpeechController {
  private getSettings: () => ClaudeChatSettings;
  private streams = new Map<string, SpeechStream>();
  private queue: QueueItem[] = [];
  /* The live `say` process, or null when idle. One chunk per process,
     spawned sequentially — the queue is ours, not the OS's, so stop() has
     exactly one process to kill and nothing buffered beyond it. */
  private child: ChildProcess | null = null;
  private childChannel: string | null = null;
  /* User-facing pause. While set, the live `say` process (if any) sits
     SIGSTOPped and the queue holds — chunks keep accumulating so resume()
     picks up exactly where the voice left off, mid-sentence included. */
  private paused = false;
  private voicesPromise: Promise<SayVoice[]> | null = null;
  /* Known-good voice names once the roster loads. Used to drop a stale
     `-v` (voice deleted in System Settings, or bad persisted value) —
     otherwise every `say` spawn would exit(1) and speech would fail
     silently. Null until the roster resolves; unknown names pass through
     in that window, where a failed spawn still advances the queue. */
  private voiceNames: Set<string> | null = null;
  /* Playback-state listeners (speaking started/stopped/paused/resumed).
     UI surfaces subscribe to drive the speaking indicator; they read the
     actual state back via isSpeaking()/isPaused(). */
  private listeners = new Set<() => void>();
  /* Reentrancy guard: a listener that mutates playback state inside its
     own notify callback must not recurse into a second notify sweep. */
  private notifying = false;

  constructor(getSettings: () => ClaudeChatSettings) {
    this.getSettings = getSettings;
    void this.listVoices().then(voices => {
      if (voices.length > 0) this.voiceNames = new Set(voices.map(v => v.name));
    });
  }

  destroy(): void {
    this.stop();
    this.listeners.clear();
  }

  /* Subscribe to playback-state changes. Returns the unsubscribe. */
  onStateChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    if (this.notifying) return;
    this.notifying = true;
    try {
      for (const cb of this.listeners) {
        try { cb(); } catch { /* listener errors must not break playback */ }
      }
    } finally {
      this.notifying = false;
    }
  }

  isSpeaking(): boolean {
    return this.child !== null || this.queue.length > 0;
  }

  isPaused(): boolean {
    return this.paused;
  }

  /* Freeze playback in place: the live process is SIGSTOPped mid-word and
     the queue stops draining. Pausing with nothing playing is valid too —
     it pre-pauses whatever arrives next (chunks queue but stay silent). */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    if (this.child) {
      try { this.child.kill("SIGSTOP"); } catch { /* already dead */ }
    }
    this.notify();
  }

  /* Resume from exactly where pause() froze things. */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.child) {
      try { this.child.kill("SIGCONT"); } catch { /* already dead */ }
    } else {
      this.playNext();
    }
    this.notify();
  }

  /* Returns the new paused state so the UI can flip its icon off it. */
  togglePause(): boolean {
    if (this.paused) this.resume();
    else this.pause();
    return this.paused;
  }

  /* Voice roster from `say -v ?` for the settings dropdown. Includes any
     Enhanced/Premium voices downloaded via System Settings (Siri voices are
     system-private and never listed — that's an Apple restriction, not
     ours). A successful roster is cached for the plugin's lifetime; a
     failed call (timeout, missing binary) is NOT cached, so the next
     caller retries instead of pinning an empty roster forever. */
  listVoices(): Promise<SayVoice[]> {
    if (this.voicesPromise) return this.voicesPromise;
    const attempt = new Promise<SayVoice[]>(resolve => {
      execFile(SAY_BIN, ["-v", "?"], { timeout: 5000 }, (err, stdout) => {
        if (err || !stdout) {
          if (this.voicesPromise === attempt) this.voicesPromise = null;
          resolve([]);
          return;
        }
        const voices: SayVoice[] = [];
        for (const line of stdout.split("\n")) {
          /* "Ava (Premium)      en_US    # Hello! ..." — anchor on the
             locale token, not column spacing: long names like
             "Eddy (English (US))" leave only a single space before the
             locale. Names never contain locale-shaped tokens, so the lazy
             prefix stops at the right place. */
          const m = line.match(/^(.+?)\s+([A-Za-z]{2,3}[_-][A-Za-z0-9]{2,}(?:[_-][A-Za-z0-9]+)?)\s+#/);
          if (m) voices.push({ name: m[1].trim(), lang: m[2].replace("_", "-") });
        }
        resolve(voices);
      });
    });
    this.voicesPromise = attempt;
    return attempt;
  }

  /* Feed the full accumulated raw markdown of a streaming assistant message.
     Safe to call on every delta AND with the final replacement text from the
     complete assistant event — the spoken offset only moves forward, so
     re-sending a superset of already-spoken text never double-speaks. */
  updateStream(channel: string, messageId: string, fullText: string): void {
    let stream = this.streams.get(messageId);
    if (!stream) {
      stream = { spoken: 0, channel };
      this.streams.set(messageId, stream);
    }
    this.drainStream(stream, fullText, false);
  }

  /* The message finished: speak whatever tail remains past the last
     boundary, then forget the stream. Creates the stream when none exists —
     that's the non-streaming path (includePartialMessages off), where the
     complete text arrives in one shot with no prior deltas. */
  finalizeStream(channel: string, messageId: string, fullText: string): void {
    const stream = this.streams.get(messageId) ?? { spoken: 0, channel };
    this.drainStream(stream, fullText, true);
    this.streams.delete(messageId);
  }

  /* Drop stream-offset tracking for a channel without touching audio.
     Called at turn teardown so streams that never reached finalize (errored
     or killed turns) don't accumulate forever. */
  forgetChannel(channel: string): void {
    for (const [id, s] of this.streams) {
      if (s.channel === channel) this.streams.delete(id);
    }
  }

  /* Read a whole markdown document (read-note-aloud). Frontmatter is the
     caller's job to strip; everything else goes through the same
     chunker/sanitizer as streaming text. */
  speakDocument(text: string): void {
    const stream: SpeechStream = { spoken: 0, channel: DOCUMENT_CHANNEL };
    this.drainStream(stream, text, true);
  }

  /* Silence a channel — or everything, when called with no argument.
     Scoped stops leave other channels' audio and all stream offsets alone;
     offsets are monotonic by design, so an interrupted message resumes
     from the interruption point instead of re-narrating from the top.
     Pause survives a scoped stop only while something else is still
     playing; it always clears when playback goes fully idle, so the next
     narration starts audible. */
  stop(channel?: string): void {
    if (channel === undefined) {
      this.queue = [];
    } else {
      this.queue = this.queue.filter(item => item.channel !== channel);
    }
    const child = this.child;
    const owned = channel === undefined || this.childChannel === channel;
    if (child && owned) {
      this.child = null;
      this.childChannel = null;
      /* A SIGSTOPped process queues SIGTERM until it's continued, so a
         paused stop would leak a suspended `say` holding its audio
         position. CONT first, then TERM — both no-ops on a dead pid. */
      try { child.kill("SIGCONT"); } catch { /* already dead */ }
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
    }
    if (!this.child && this.queue.length === 0) {
      this.paused = false;
    } else if (!this.child && !this.paused) {
      /* Killed the owner's child but another channel still has queued
         chunks — keep the floor moving. */
      this.playNext();
    }
    this.notify();
  }

  /* ---------- chunking ---------- */

  private drainStream(stream: SpeechStream, fullText: string, final: boolean): void {
    for (;;) {
      /* Captured BEFORE nextChunk advances the offset: tells the sanitizer
         whether the chunk's first line is a true document line start (line-
         anchored strips like blockquote/bullet only apply there — a chunk
         that begins mid-line after a sentence boundary must not have a
         leading "> " or "- " stripped out of running prose). */
      const chunkAtLineStart = stream.spoken === 0 || fullText[stream.spoken - 1] === "\n";
      const chunk = this.nextChunk(stream, fullText, final);
      if (chunk === null) return;
      const spoken = sanitizeForSpeech(chunk, chunkAtLineStart);
      /* Mid-stream, sub-MIN_CHUNK fragments are markdown residue; at
         finalize, ANY non-empty tail is real content (a reply of "7" must
         still be voiced). */
      if (spoken.length >= MIN_CHUNK || (final && spoken.length > 0)) {
        this.enqueue(stream.channel, spoken);
      }
    }
  }

  /* Extract the next speakable raw-text chunk starting at stream.spoken, or
     null if no complete chunk is available yet. Advances stream.spoken.
     Fenced code blocks are consumed whole and skipped (never spoken); an
     unterminated fence blocks until its close arrives or `final` forces
     consumption. */
  private nextChunk(stream: SpeechStream, fullText: string, final: boolean): string | null {
    const rest = fullText.slice(stream.spoken);
    if (rest.length === 0) return null;

    /* A fence only opens at a true line start. Chunk boundaries can land
       mid-line (after "sentence. "), so `rest` starting with ``` does NOT
       imply a fence — "type three backticks. ``` is the marker" is prose.
       Without this check the whole remainder of such a message gets
       swallowed as an unterminated fence. */
    const atLineStart = stream.spoken === 0 || fullText[stream.spoken - 1] === "\n";
    const open = atLineStart ? rest.match(/^(`{3,}|~{3,})/) : null;
    if (open) {
      const marker = open[1];
      /* Close fence: a line of AT LEAST as many of the same character,
         with nothing but trailing whitespace (an info string like ```js
         cannot close a fence, and a longer ```` fence isn't closed by an
         inner ```). Mid-stream the close line must be newline-terminated —
         a bare "```" at the buffer's edge could still grow into "```js"
         (a content line) on the next delta. */
      const closePattern = final
        ? `\\n${marker[0]}{${marker.length},}[ \\t]*(\\n|$)`
        : `\\n${marker[0]}{${marker.length},}[ \\t]*\\n`;
      const cm = rest.slice(marker.length).match(new RegExp(closePattern));
      if (!cm || cm.index === undefined) {
        if (!final) return null;             /* wait for the closing fence */
        stream.spoken = fullText.length;     /* stream died mid-fence: drop it */
        return null;
      }
      stream.spoken += marker.length + cm.index + cm[0].length;
      return "";                              /* code is skipped silently */
    }

    /* Prose runs up to the next newline-anchored fence candidate (if any);
       boundaries only count inside the prose region. The newline before
       the fence belongs to the prose chunk, which leaves the next
       iteration sitting at a true line start for the fence branch. */
    const nextFence = rest.match(/\n(`{3,}|~{3,})/);
    const proseEnd = nextFence && nextFence.index !== undefined ? nextFence.index + 1 : rest.length;
    const prose = rest.slice(0, proseEnd);

    BOUNDARY_RE.lastIndex = 0;
    let lastBoundary = -1;
    for (let m = BOUNDARY_RE.exec(prose); m !== null; m = BOUNDARY_RE.exec(prose)) {
      lastBoundary = m.index + m[0].length;
    }

    if (lastBoundary !== -1) {
      stream.spoken += lastBoundary;
      return prose.slice(0, lastBoundary);
    }
    /* No boundary in the prose yet. If a fence follows or the stream is
       done, the whole prose run is the chunk; otherwise wait for more. */
    if (nextFence || final) {
      stream.spoken += proseEnd;
      return prose;
    }
    return null;
  }

  /* ---------- playback ---------- */

  private enqueue(channel: string, text: string): void {
    /* One narration at a time: whoever is already playing (or queued)
       holds the floor. Chunks from other channels are dropped — their
       stream offsets have already advanced, so nothing floods out when
       the floor frees up; that conversation simply isn't narrated. */
    const floor = this.childChannel ?? this.queue[0]?.channel ?? null;
    if (floor !== null && floor !== channel) return;
    this.queue.push({ text, channel });
    if (!this.child && !this.paused) this.playNext();
    else if (this.paused) this.notify();      /* pre-paused: bars must show "held" */
  }

  private playNext(): void {
    /* Race guard: pause() can land just as the live child exits on its own
       (the SIGSTOP misses a dying pid). The exit's advance() then calls in
       here — honor the pause instead of draining the next chunk audibly. */
    if (this.paused) {
      this.child = null;
      this.childChannel = null;
      this.notify();
      return;
    }
    const item = this.queue.shift();
    if (item === undefined) {
      this.child = null;
      this.childChannel = null;
      this.notify();                          /* went idle */
      return;
    }
    const settings = this.getSettings();
    const args = ["-r", String(Math.round(BASE_WPM * clampRate(settings.voiceRate)))];
    if (settings.voiceName && (this.voiceNames === null || this.voiceNames.has(settings.voiceName))) {
      args.push("-v", settings.voiceName);
    }
    /* Text rides on stdin, never argv — chunk content can start with "-"
       or contain anything else without being parsed as an option. */
    let child: ChildProcess;
    try {
      child = spawn(SAY_BIN, args, { stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      /* Synchronous spawn failure (exotic — bad args class). Skip this
         chunk and keep the queue draining rather than wedging. */
      this.child = null;
      this.childChannel = null;
      this.playNext();
      return;
    }
    this.child = child;
    this.childChannel = item.channel;
    const advance = () => {
      if (this.child !== child) return;      /* stop() superseded us */
      this.child = null;
      this.childChannel = null;
      this.playNext();
    };
    child.on("exit", advance);
    child.on("error", advance);
    child.stdin?.on("error", () => { /* EPIPE on a killed child — ignore */ });
    child.stdin?.end(item.text);
    this.notify();                            /* started (or continued) speaking */
  }
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 1;
  return Math.min(3, Math.max(0.5, rate));
}

/* Reduce a raw markdown chunk to plain speakable prose. Operates on small
   sentence-sized chunks, so simple regex passes are fine — no need for a
   real parser here. `firstLineAtLineStart` says whether the chunk's first
   line begins at a real document line start; line-anchored structural
   strips (heading/quote/bullet/checkbox/number) are skipped for a first
   line that is actually the middle of a document line, so prose like
   "was 2. > 1 means…" keeps its comparison operator. */
export function sanitizeForSpeech(raw: string, firstLineAtLineStart = true): string {
  let text = raw;
  /* Images vanish; links and wiki-links read as their display text. */
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  text = text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "$1");
  text = text.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2");
  text = text.replace(/\[\[([^\]]*)\]\]/g, "$1");
  /* Bare URLs are noise when read character by character. */
  text = text.replace(/https?:\/\/\S+/g, "link");
  /* Structural markers, per line: headings, quotes, bullets, checkboxes,
     numbered-list dots, table pipes, horizontal rules. */
  text = text
    .split("\n")
    .map((line, i) => {
      let l = line;
      const realLineStart = i > 0 || firstLineAtLineStart;
      if (realLineStart) {
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) return "";        /* hr */
        if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l)) return "";          /* table separator row */
        l = l.replace(/^\s{0,3}#{1,6}\s+/, "");                       /* heading */
        l = l.replace(/^\s*>\s?/, "");                                 /* blockquote */
        l = l.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, "");                /* checkbox */
        l = l.replace(/^\s*[-*+]\s+/, "");                             /* bullet */
        l = l.replace(/^\s*\d+[.)]\s+/, "");                           /* numbered */
      }
      l = l.replace(/\s*\|\s*/g, ", ").replace(/^,\s*|,\s*$/g, "");    /* table row */
      return l;
    })
    .join("\n");
  /* Inline emphasis + code. Single `_` is left alone (snake_case). */
  text = text.replace(/`([^`]*)`/g, "$1");
  text = text.replace(/\*\*([^*]+)\*\*/g, "$1");
  text = text.replace(/__([^_]+)__/g, "$1");
  text = text.replace(/(^|\s)\*([^*\n]+)\*(?=[\s.,!?;:]|$)/g, "$1$2");
  text = text.replace(/~~([^~]+)~~/g, "$1");
  /* Emoji and pictographs read as awkward names ("sparkles"). Drop them. */
  text = text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, "");
  /* Em/en dashes speak better as pauses. */
  text = text.replace(/\s*[—–]\s*/g, ", ");
  return text.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}
