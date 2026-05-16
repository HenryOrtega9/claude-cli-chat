/* StatusIndicator renders the in-flight state between the message list and
   the input box. Two modes:
   - "thinking": cycles whimsical gerunds every ~3s, matching the Claude Code
     terminal's playful spinner labels.
   - "retrying": shows attempt count + a live countdown to the next try, used
     when the CLI is backing off on 5xx responses from the API. */

const THINKING_WORDS = [
  "Pondering", "Cogitating", "Brewing", "Cooking", "Reflecting",
  "Synthesizing", "Marinating", "Percolating", "Mulling", "Ruminating",
  "Brainstorming", "Considering", "Contemplating", "Devising", "Crafting",
  "Conjuring", "Forging", "Weaving", "Composing", "Computing",
  "Processing", "Analyzing", "Reasoning", "Thinking", "Noodling",
  "Scheming", "Plotting", "Spinning up", "Warming up", "Dreaming up",
];

export class StatusIndicator {
  private root: HTMLElement;
  private dotEl: HTMLElement;
  private labelEl: HTMLElement;
  private detailEl: HTMLElement;
  private wordTimer: number | null = null;
  private countdownTimer: number | null = null;
  private mode: "idle" | "thinking" | "retrying" = "idle";

  constructor(parent: HTMLElement) {
    this.root = parent.createDiv({ cls: "claudian-status-indicator" });
    this.dotEl = this.root.createSpan({ cls: "claudian-status-dot" });
    this.labelEl = this.root.createSpan({ cls: "claudian-status-label" });
    this.detailEl = this.root.createSpan({ cls: "claudian-status-detail" });
    this.hide();
  }

  setThinking() {
    this.mode = "thinking";
    this.clearTimers();
    this.root.removeClass("is-retrying");
    this.root.addClass("is-thinking");
    this.root.style.display = "";
    this.detailEl.setText("");
    this.cycleWord();
    /* Cycle every 3s so the user sees the spinner is alive without it
       being distracting. */
    this.wordTimer = window.setInterval(() => this.cycleWord(), 3000);
  }

  setRetrying(attempt: number, maxRetries: number, retryDelayMs: number) {
    this.mode = "retrying";
    this.clearTimers();
    this.root.removeClass("is-thinking");
    this.root.addClass("is-retrying");
    this.root.style.display = "";
    this.labelEl.setText(`Retrying (${attempt}/${maxRetries})`);
    const startedAt = Date.now();
    const tick = () => {
      const remaining = Math.max(0, retryDelayMs - (Date.now() - startedAt));
      this.detailEl.setText(` · next attempt in ${this.formatRemaining(remaining)}`);
      if (remaining <= 0 && this.countdownTimer !== null) {
        window.clearInterval(this.countdownTimer);
        this.countdownTimer = null;
        this.detailEl.setText(" · sending now…");
      }
    };
    tick();
    this.countdownTimer = window.setInterval(tick, 250);
  }

  hide() {
    this.mode = "idle";
    this.clearTimers();
    this.root.removeClass("is-thinking");
    this.root.removeClass("is-retrying");
    this.root.style.display = "none";
    this.labelEl.setText("");
    this.detailEl.setText("");
  }

  destroy() {
    this.clearTimers();
    this.root.remove();
  }

  private cycleWord() {
    const word = THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)];
    this.labelEl.setText(`${word}…`);
  }

  private formatRemaining(ms: number): string {
    const seconds = ms / 1000;
    if (seconds >= 10) return `${Math.ceil(seconds)}s`;
    /* Show one decimal for the last 10s so the countdown feels alive. */
    return `${seconds.toFixed(1)}s`;
  }

  private clearTimers() {
    if (this.wordTimer !== null) {
      window.clearInterval(this.wordTimer);
      this.wordTimer = null;
    }
    if (this.countdownTimer !== null) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }
}
