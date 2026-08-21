/* RemoteSpeechController — voice mode over the native `speak` bridge.

   `SpeechController` (src/voice/SpeechController.ts) drives macOS `say` child
   processes and imports node:child_process, so it cannot exist in this bundle
   at all. What the view layer actually touches is ten members, listed in
   PluginHost as `speech`, and on iOS the equivalent capability is
   AVSpeechSynthesizer behind the bridge's `speak` / `speak {stop:true}`.

   Two behaviors of the real controller are deliberately NOT reproduced,
   because AVSpeechSynthesizer gives us no seam for them:

     - Per-channel silencing. `stop(channel)` stops everything, since the
       native side has one synthesizer with one queue. With one tab speaking at
       a time (the phone shows one tab at a time) that is indistinguishable.
     - Pause / resume. The bridge exposes stop, not pause, so togglePause()
       stops and reports "not paused". The transport button therefore acts as
       a stop button; better than a button that lies about being paused.

   Streaming still narrates incrementally: `updateStream` speaks each completed
   sentence as it lands, tracking a per-message offset so an interrupted reply
   never re-narrates what was already spoken — the same monotonic-offset rule
   the real controller documents. */

import type { ClaudeChatSettings } from "../../settings-data";
import type { GatewayTransport } from "./transport";

/* Local markdown stripper. `sanitizeForSpeech` lives in SpeechController.ts,
   which imports node:child_process and therefore cannot be in this bundle at
   all; extracting it would mean editing src/voice, which this change does not
   own. This is the same idea at a smaller scale: drop fences, images, link
   syntax, emphasis and heading/list markers so the synthesizer reads prose
   rather than punctuation. */
function stripMarkdownForSpeech(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " image ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/\s+/g, " ");
}

export class RemoteSpeechController {
  private readonly listeners = new Set<() => void>();
  /* messageId -> characters already handed to the synthesizer. Survives
     stop(), so a cancelled turn's remainder is never spoken later. */
  private readonly spokenTo = new Map<string, number>();
  private speaking = false;

  constructor(
    private readonly transport: GatewayTransport,
    private readonly settings: () => ClaudeChatSettings,
  ) {}

  destroy(): void {
    this.stop();
    this.listeners.clear();
  }

  onStateChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  isPaused(): boolean {
    return false;
  }

  togglePause(): boolean {
    this.stop();
    return false;
  }

  updateStream(_channel: string, messageId: string, fullText: string): void {
    const offset = this.spokenTo.get(messageId) ?? 0;
    if (fullText.length <= offset) return;
    const pending = fullText.slice(offset);
    /* Only speak up to the last sentence boundary; a half sentence read aloud
       and then continued reads as a stutter. */
    const boundary = Math.max(
      pending.lastIndexOf(". "),
      pending.lastIndexOf("! "),
      pending.lastIndexOf("? "),
      pending.lastIndexOf("\n"),
    );
    if (boundary < 0) return;
    const chunk = pending.slice(0, boundary + 1);
    this.spokenTo.set(messageId, offset + chunk.length);
    this.emit(chunk);
  }

  finalizeStream(_channel: string, messageId: string, fullText: string): void {
    const offset = this.spokenTo.get(messageId) ?? 0;
    if (fullText.length > offset) {
      this.spokenTo.set(messageId, fullText.length);
      this.emit(fullText.slice(offset));
    }
  }

  forgetChannel(_channel: string): void {
    /* Offsets are keyed by message, and a message id never outlives its tab.
       Nothing to reclaim that the next stop() does not already cover. */
  }

  speakDocument(text: string): void {
    this.emit(text);
  }

  stop(_channel?: string): void {
    if (!this.speaking) return;
    this.speaking = false;
    try { this.transport.stopSpeaking(); } catch { /* bridge unavailable */ }
    this.notify();
  }

  private emit(raw: string): void {
    const text = stripMarkdownForSpeech(raw).trim();
    if (!text) return;
    /* voiceName / voiceRate are macOS `say` concepts; the native side picks a
       locale voice. Reading the setting keeps the shape honest for the day the
       bridge grows a voice parameter. */
    void this.settings();
    this.speaking = true;
    try { this.transport.speak(text); } catch { /* bridge unavailable */ }
    this.notify();
  }

  private notify(): void {
    for (const cb of this.listeners) {
      try { cb(); } catch { /* a listener must not break narration */ }
    }
  }
}
