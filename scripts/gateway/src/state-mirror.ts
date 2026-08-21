/* TC001 state mirror, iOS lane.

   Same `"<epoch_sec> <state>\n"` token format as src/claude/StateEmitter, but
   written to /tmp/claude_state.ios rather than /tmp/claude_state. That
   separation is the whole point: the plugin owns the shared file today, and
   two writers on one path would fight over the display. The animator's
   multi-source resolver (planned) reads per-source token files, and this is
   the gateway's source file.

   The daemon also never touches ~/.claude/settings.json — unlike the watch
   bridge, it has no slash commands to guard.

   The state reported is the AGGREGATE across tabs, because the device shows
   one thing: any pending approval wins (someone is waiting on you), then any
   busy tab, then rest. */

import { writeFileSync } from "node:fs";

export type MirrorState = "idle" | "ready" | "thinking" | "needs_permission" | "complete";

export class StateMirror {
  private current: MirrorState | null = null;

  constructor(private readonly path: string) {}

  set(state: MirrorState): void {
    if (this.current === state) return;
    this.current = state;
    try {
      writeFileSync(this.path, `${Math.floor(Date.now() / 1000)} ${state}\n`);
    } catch {
      /* /tmp unwritable is non-fatal — the display just doesn't update. */
    }
  }

  reflect(tabs: Array<{ busy: boolean; hasPendingApprovals: boolean }>): void {
    if (tabs.some(t => t.hasPendingApprovals)) this.set("needs_permission");
    else if (tabs.some(t => t.busy)) this.set("thinking");
    else this.set("ready");
  }
}
