/* Drives the Ulanzi TC001 status display from this plugin only.
   v1 scope: claude-cli-chat owns the display. Terminal-side Claude Code
   does NOT emit state changes; once multi-source merging is designed
   we'll switch to per-source token files (/tmp/claude_state.plugin,
   /tmp/claude_state.terminal) and a priority resolver in animator.py.

   State machine:
     idle              : plugin loaded, no active turn
     thinking          : assistant turn in flight (user just submitted, or
                         permission was just granted and execution resumed)
     needs_permission  : CLI fired a control_request, waiting on the user
     complete          : result event fired; daemon auto-transitions to ready
     ready             : attentive post-complete rest; animator daemon
                         times this out to idle after 60s of inactivity

   Auto-transitions (complete -> ready -> idle) are owned by the animator
   daemon. The plugin only emits explicit user-driven state changes so a
   single component is the source of truth and races between two timers
   cannot leave the device flashing through an intermediate state.

   Side effects per setState():
     1. Write `<epoch_sec> <state>\n` to /tmp/claude_state (animator polls)
     2. POST /api/switch on TC001 (which Awtrix custom app to show), with
        successive pushes serialized through a single in-flight promise so
        rapid state changes never land out of order on the device.
   All HTTP is fail-silent with a tight timeout, so a powered-off TC001
   never blocks plugin event handling. */

import { requestUrl } from "obsidian";
import { writeFileSync } from "node:fs";

export type DisplayState = "idle" | "ready" | "thinking" | "needs_permission" | "complete";

const STATE_TOKEN_FILE = "/tmp/claude_state";
const HTTP_TIMEOUT_MS = 500;
/* Awtrix auto-rotates through registered apps on ATIME (default ~7s), so a
   one-shot /api/switch at state-entry drifts off the chosen app during long
   thinking turns. Re-assert the switch while a holding state is active. 5s
   stays comfortably under the default rotation interval. */
const HEARTBEAT_MS = 5000;
const HELD_STATES: ReadonlySet<DisplayState> = new Set(["thinking", "needs_permission"]);

/* Palette mirrors register_states.sh and animator.py. */
const CORAL = "#D97757";
const AMBER_GOLD = "#FFC33C";
const SAGE_GREEN = "#78D282";

class StateEmitterImpl {
  private enabled = false;
  private ip = "";
  private currentState: DisplayState | null = null;
  /* Serializes /api/switch POSTs. Without this, two setState calls fired
     back-to-back (e.g. complete then thinking) launch concurrent POSTs that
     can land out of order, leaving the device parked on the wrong app. */
  private pushChain: Promise<void> = Promise.resolve();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  configure(enabled: boolean, ip: string): void {
    /* On enable-after-disable, drop the cached state so the next setState
       always re-emits. Otherwise the de-dupe at line 51 can swallow a
       legitimate re-assertion of the same state after the daemon may have
       walked the token file along on its own (complete -> ready -> idle). */
    if (enabled && !this.enabled) this.currentState = null;
    this.enabled = enabled;
    this.ip = ip.trim();
    if (!enabled && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /* Teardown for plugin unload/reload. Clears the heartbeat interval (a raw
     setInterval, so Obsidian's registerInterval cleanup does not cover it) and
     disables emission. Without this, a reload/quit while a held state is active
     leaves the 5s heartbeat firing /api/switch POSTs against a dead instance,
     and reloads stack orphaned intervals. Idempotent. */
  dispose(): void {
    this.enabled = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /* Emit a state change. De-dupes against the last emitted state so callers
     can fire freely on every stream event without flooding the device. */
  setState(state: DisplayState): void {
    if (!this.enabled) return;
    if (this.currentState === state) return;
    this.currentState = state;

    this.writeToken(state);
    this.pushToDevice(state);
    this.updateHeartbeat(state);
  }

  /* For held states (thinking, needs_permission), keep re-asserting the
     /api/switch so Awtrix's ATIME rotation doesn't drift us off the app.
     Transient states (idle/ready/complete) clear the heartbeat — the
     animator daemon's auto-transitions take it from there. */
  private updateHeartbeat(state: DisplayState): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (!HELD_STATES.has(state)) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.currentState) this.pushToDevice(this.currentState);
    }, HEARTBEAT_MS);
  }

  private writeToken(state: DisplayState): void {
    try {
      const line = `${Math.floor(Date.now() / 1000)} ${state}\n`;
      writeFileSync(STATE_TOKEN_FILE, line);
    } catch {
      /* /tmp not writable is non-fatal; daemon just won't pick up. */
    }
  }

  private pushToDevice(state: DisplayState): void {
    if (!this.ip) return;
    /* Matrix-only design (since 2026-05-18): indicator LEDs intentionally
       untouched; the TC001's 3 indicators are physically chained into the
       matrix at r6c31, r7c30, r7c31, so any lit indicator reads as a
       bottom-right matrix pixel. All state differentiation lives in the
       animator daemon's matrix rendering, so this is a single-leg push. */
    const url = `http://${this.ip}/api/switch`;
    this.pushChain = this.pushChain
      .catch(() => {})
      .then(() => this.post(url, { name: state }));
  }

  private async post(url: string, body: Record<string, unknown>): Promise<void> {
    try {
      await Promise.race([
        requestUrl({
          url,
          method: "POST",
          contentType: "application/json",
          body: JSON.stringify(body),
          throw: false,
        }),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), HTTP_TIMEOUT_MS)),
      ]);
    } catch {
      /* Device offline / DNS miss / wrong IP; silently skip. */
    }
  }
}

export const StateEmitter = new StateEmitterImpl();
