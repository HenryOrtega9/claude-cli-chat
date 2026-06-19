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

/* Claude-mark-style spark glyph. Eleven tapered-spindle rays at non-uniform
   angles and varied lengths, recreating the organic asymmetry of the real
   Anthropic mark without copying the trademarked asset. The asymmetry
   serves a second purpose: a perfectly 12-fold symmetric asterisk looks
   stationary even while spinning (every 30° tick maps onto itself); these
   irregular rays mean rotation is visibly readable without needing any
   opacity tricks. All rays render at full color for a clean, solid look.

   Spindle is parameterized by length L — outer tip at y=(12-L), waist
   control points at y=(12-L/2), inner base at y=11 (small gap near center
   so rays don't bunch into a solid disk). All coords stay inside the 24×24
   viewBox so nothing bleeds past the pill background at 18px display. */
const SPARK_SVG = (() => {
  const rays: Array<{ a: number; L: number }> = [
    { a: 0,   L: 9.5 },
    { a: 32,  L: 7   },
    { a: 65,  L: 8.5 },
    { a: 98,  L: 10  },
    { a: 132, L: 7.5 },
    { a: 163, L: 9   },
    { a: 198, L: 8   },
    { a: 230, L: 7   },
    { a: 263, L: 10  },
    { a: 295, L: 7.5 },
    { a: 328, L: 8.5 },
  ];
  const spindle = (L: number) => {
    const oy = (12 - L).toFixed(2);
    const my = (12 - L / 2).toFixed(2);
    return `M 12 ${oy} Q 13 ${my} 12.5 11 L 11.5 11 Q 11 ${my} 12 ${oy} Z`;
  };
  const paths = rays.map(r =>
    `<path d="${spindle(r.L)}" transform="rotate(${r.a} 12 12)"/>`
  ).join("");
  return `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<g fill="currentColor">${paths}</g>` +
    `</svg>`;
})();

export class StatusIndicator {
  private root: HTMLElement;
  private sparkEl: HTMLElement;
  private dotEl: HTMLElement;
  private labelEl: HTMLElement;
  private detailEl: HTMLElement;
  private wordTimer: number | null = null;
  private countdownTimer: number | null = null;
  private watchdogTimer: number | null = null;
  private mode: "idle" | "thinking" | "retrying" = "idle";

  /* Inactivity ceiling for the thinking spinner. Each inbound CLI event kicks
     this via heartbeat(), so it measures silence-since-last-event, not total
     turn time — a turn with long-but-progressing tool calls keeps resetting
     it. Only genuine silence (a wedged/dead CLI emitting nothing) trips it. */
  private static readonly WATCHDOG_MS = 120_000;

  constructor(parent: HTMLElement) {
    this.root = parent.createDiv({ cls: "claudian-status-indicator" });
    /* Spark (thinking) and dot (retrying) coexist in DOM; CSS toggles which
       one is visible based on the is-thinking / is-retrying class on root. */
    this.sparkEl = this.root.createSpan({ cls: "claudian-status-spark" });
    this.sparkEl.innerHTML = SPARK_SVG;
    this.dotEl = this.root.createSpan({ cls: "claudian-status-dot" });
    this.labelEl = this.root.createSpan({ cls: "claudian-status-label" });
    this.detailEl = this.root.createSpan({ cls: "claudian-status-detail" });
    this.hide();
  }

  /* The TabController hands this root to MessageRenderer.setTailEl so the
     pill rides at the bottom of the message list (just above the sentinel)
     and trails whatever assistant block was last rendered. */
  get rootEl(): HTMLElement { return this.root; }

  setThinking() {
    this.mode = "thinking";
    this.clearTimers();
    /* Drop any stale watchdog hint from a prior stall so it doesn't linger
       on later healthy spinners. */
    this.root.removeAttribute("title");
    this.root.removeClass("is-retrying");
    this.root.addClass("is-thinking");
    this.root.style.display = "";
    this.detailEl.setText("");
    this.cycleWord();
    /* Cycle every 3s so the user sees the spinner is alive without it
       being distracting. */
    this.wordTimer = window.setInterval(() => this.cycleWord(), 3000);
    this.armWatchdog();
  }

  /* Reset the inactivity watchdog on any sign of life from the CLI, without
     disturbing the visible spinner (no word re-roll, no label change). The
     event router calls this for every inbound CLI event so a turn with long
     but healthy tool calls — e.g. several sequential Perplexity lookups that
     each take 30s+ — keeps the pill alive instead of tripping the watchdog
     mid-turn. No-op unless a thinking spinner is currently showing. */
  heartbeat() {
    if (this.mode !== "thinking") return;
    this.armWatchdog();
  }

  /* (Re)arm the inactivity watchdog: if no CLI event arrives within
     WATCHDOG_MS, auto-hide with a hover hint so a genuinely wedged CLI
     doesn't leave the user staring at a perpetual "Pondering…" pill. Each
     heartbeat pushes the deadline out, so this fires only on true silence —
     never on a long-but-progressing turn. Cleared by hide()/setRetrying()
     via clearTimers. */
  private armWatchdog() {
    if (this.watchdogTimer !== null) window.clearTimeout(this.watchdogTimer);
    this.watchdogTimer = window.setTimeout(() => {
      this.watchdogTimer = null;
      this.root.setAttribute("title", "(status timed out — no CLI activity in 120s)");
      this.hide();
    }, StatusIndicator.WATCHDOG_MS);
  }

  /* Suspend the inactivity watchdog without touching the visible spinner.
     Used when a turn is legitimately blocked on something the CLI emits no
     events for — chiefly a pending tool approval, where the CLI sits idle
     waiting for the user to click Allow/Deny. Without this the 120s silence
     ceiling would hide the pill mid-approval even though nothing is wedged,
     contradicting the watchdog's "only genuine silence trips it" contract.
     The word cycle keeps running; setThinking() re-arms the watchdog when the
     turn resumes. No-op unless a thinking spinner is currently showing. */
  suspendWatchdog() {
    if (this.mode !== "thinking") return;
    if (this.watchdogTimer !== null) {
      window.clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  setRetrying(attempt: number, maxRetries: number, retryDelayMs: number) {
    this.mode = "retrying";
    this.clearTimers();
    this.root.removeAttribute("title");
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
    if (this.watchdogTimer !== null) {
      window.clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }
}
