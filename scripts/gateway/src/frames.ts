/* Wire frames, shared by the WebSocket stream and the `/tabs/:id/events`
   replay endpoint. Contract: docs/ios-gateway/CONTRACTS.md § WebSocket.

   `seq` is per tab and monotonic from 1. Frames that aren't about a tab
   (`hello`, `catalog`, `pong`) carry `tab: null` and `seq: 0`, so a client
   can key its resume cursor purely on (tab, seq) without special cases. */

export type FrameType =
  | "hello"
  | "event"
  | "tab_status"
  | "approval_request"
  | "approval_resolved"
  | "turn_done"
  | "catalog"
  | "resync"
  | "pong"
  | "error";

export type Frame = {
  v: 1;
  seq: number;
  tab: string | null;
  t: FrameType;
  payload: Record<string, unknown>;
};

export function makeFrame(t: FrameType, tab: string | null, seq: number, payload: Record<string, unknown>): Frame {
  return { v: 1, seq, tab, t, payload };
}
