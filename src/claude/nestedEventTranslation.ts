/* Translation from raw stream-json events belonging to a SUBAGENT into the
   NestedSubagentEvent shape the agent card / drill-in renders.

   Two producers feed this: SubagentSessionTracker (records tailed off the
   subagent's own session JSONL) and TabController's live-stream diversion
   (events on the parent's stdout tagged with parent_tool_use_id). Both see
   the same wire shapes, so the translation lives here as a pure function and
   the caller owns the dedupe set (one per subagent). */

import type {
  StreamEvent,
  AssistantEvent,
  ToolUseEvent,
  ToolResultEvent,
  ContentBlock,
} from "./Events";
import type { NestedSubagentEvent, ToolCall } from "../view/state";

/* Status/result patch for an already-appended nested tool_use row. */
export type NestedToolUseUpdate = {
  id: string;
  status: ToolCall["status"];
  result?: string;
  isError?: boolean;
};

export type NestedTranslation = {
  events: NestedSubagentEvent[];
  toolUseUpdates?: NestedToolUseUpdate[];
};

const EMPTY: NestedTranslation = { events: [] };

/* `seenToolIds` is caller-owned and mutated here: the same nested tool_use
   reaches us twice on both producers (JsonlTailer emits an assistant record
   AND a synthesized tool_use event for it; the live stream emits the
   assistant message plus, on some CLI versions, a standalone tool_use), so
   the first sighting wins and the second is dropped. */
export function translateNestedEvent(e: StreamEvent, seenToolIds: Set<string>): NestedTranslation {
  const events: NestedSubagentEvent[] = [];
  const toolUseUpdates: NestedToolUseUpdate[] = [];

  if (e.type === "assistant") {
    const ae = e as AssistantEvent;
    for (const block of ae.message.content) {
      if (block.type === "text" && block.text) {
        events.push({ kind: "text", text: block.text });
      } else if (block.type === "thinking" && block.thinking) {
        events.push({ kind: "thinking", text: block.thinking });
      } else if (block.type === "tool_use") {
        /* Wire gotcha #2: tool_use blocks live INSIDE content[], not as a
           top-level event. The live stream never emits them any other way. */
        if (seenToolIds.has(block.id)) continue;
        seenToolIds.add(block.id);
        events.push({
          kind: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input ?? {},
          status: "running",
        });
      }
    }
  } else if (e.type === "tool_use") {
    const tu = e as ToolUseEvent;
    if (!seenToolIds.has(tu.id)) {
      seenToolIds.add(tu.id);
      events.push({
        kind: "tool_use",
        id: tu.id,
        name: tu.name,
        input: tu.input,
        status: "running",
      });
    }
  } else if (e.type === "tool_result") {
    const tr = e as ToolResultEvent;
    toolUseUpdates.push(toolUseUpdate(tr.tool_use_id, flatten(tr.content), tr.is_error));
  } else if (e.type === "user") {
    /* Wire gotcha #3: tool_result blocks ride inside synthetic user
       envelopes. Plain text blocks in the same envelope are the prompt echo
       / injected context and are dropped. */
    const blocks = (e as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(blocks)) return EMPTY;
    for (const raw of blocks) {
      if (!raw || typeof raw !== "object") continue;
      const block = raw as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      toolUseUpdates.push(toolUseUpdate(block.tool_use_id, flatten(block.content), block.is_error));
    }
  }
  /* Everything else (system, result, usage, stream_event, …) describes the
     session envelope rather than the subagent's visible work. */

  if (events.length === 0 && toolUseUpdates.length === 0) return EMPTY;
  return {
    events,
    toolUseUpdates: toolUseUpdates.length > 0 ? toolUseUpdates : undefined,
  };
}

function toolUseUpdate(id: string, result: string, isError?: boolean): NestedToolUseUpdate {
  return {
    id,
    status: isError ? "errored" : "completed",
    result,
    isError: !!isError,
  };
}

/* tool_result content is either a plain string or an array of blocks. */
function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ContentBlock[])
    .map(b => (b && b.type === "text" ? b.text : `[${(b as { type?: string })?.type ?? "unknown"} block]`))
    .join("");
}
