/* Typed schemas for the stream-json events emitted by `claude --output-format stream-json`.
   Derived from Anthropic Agent SDK source bundled in Claudian (main.js lines 16071-25500)
   and from runtime observation of the local Claude Code CLI (v2.1.141). */

export type TextBlock = { type: "text"; text: string };

export type ImageBlock = {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
};

export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ThinkingBlock = {
  type: "thinking";
  thinking: string;
  signature?: string;
};

export type RedactedThinkingBlock = {
  type: "redacted_thinking";
  data: string;
};

/* Inputs we *send* — text + image only. */
export type ContentBlock = TextBlock | ImageBlock;

/* What the model can *return* — text, tool_use, and the two thinking
   variants. Used for assistant message content and the streaming envelope's
   content_block_start. */
export type AssistantContentBlock = TextBlock | ToolUseBlock | ThinkingBlock | RedactedThinkingBlock;

/** Top-level event types emitted on stdout. */
export type StreamEvent =
  | SystemInitEvent
  | SystemStatusEvent
  | SystemApiRetryEvent
  | UserEchoEvent
  | AssistantEvent
  | StreamEventEvent
  | ToolUseEvent
  | ToolResultEvent
  | ResultEvent
  | UsageEvent
  | RateLimitEvent
  | ErrorEvent
  | ControlRequestEvent
  | UnknownEvent;

export type SystemInitEvent = {
  type: "system";
  subtype: "init";
  session_id: string;
  model: string;
  cwd?: string;
  tools?: string[];
  /* The slash commands the CLI has discovered for this session. Includes
     CLI built-ins (clear, compact, init, review, ...) and every skill from
     every loaded plugin / user / project source. Surfaced in the slash-
     command suggestion popup so users can discover them inline. */
  slash_commands?: string[];
  /* Subset of slash_commands that map to a skill (vs. a CLI built-in).
     Same names appear in both arrays — separated so the dropdown can label
     them differently. */
  skills?: string[];
  /* The permission mode the CLI ended up in. Useful when the user passed
     --permission-mode and we need to mirror its accepted value. */
  permissionMode?: string;
  metadata?: Record<string, unknown>;
};

/** Lifecycle status events like "requesting", "thinking", etc. */
export type SystemStatusEvent = {
  type: "system";
  subtype: "status";
  status: string;
  session_id?: string;
  uuid?: string;
};

/** Emitted when the CLI retries a transient API failure (e.g. 529 overloaded).
   `attempt` is 1-indexed, `retry_delay_ms` is how long before the next attempt fires. */
export type SystemApiRetryEvent = {
  type: "system";
  subtype: "api_retry";
  attempt: number;
  max_retries: number;
  retry_delay_ms: number;
  error?: string;
  session_id?: string;
  uuid?: string;
};

export type UserEchoEvent = {
  type: "user";
  uuid?: string;
  session_id?: string;
  message: { role: "user"; content: ContentBlock[] };
};

export type AssistantEvent = {
  type: "assistant";
  uuid?: string;
  session_id?: string;
  message: {
    role: "assistant";
    model?: string;
    content: AssistantContentBlock[];
    /* Per-API-call usage snapshot. The Anthropic Messages API attaches usage
       to each message; this is the correct source for "current context size"
       because it reflects ONE call. The `result` event's usage field is
       cumulative across all calls in a multi-pass turn (tool round-trips)
       and over-counts shared context. */
    usage?: UsageSnapshot;
  };
};

/** Incremental streaming wrapper. Only emitted with `--include-partial-messages`.
   Wraps the standard Anthropic Messages API streaming events with an outer
   `stream_event` envelope. Use the inner `event.type` to dispatch. */
export type StreamEventEvent = {
  type: "stream_event";
  session_id?: string;
  parent_tool_use_id?: string | null;
  uuid?: string;
  ttft_ms?: number;
  event:
    | { type: "message_start"; message: { id: string; model?: string; role: "assistant"; content: AssistantContentBlock[] } }
    | { type: "content_block_start"; index: number; content_block: AssistantContentBlock }
    | {
        type: "content_block_delta";
        index: number;
        delta:
          | { type: "text_delta"; text: string }
          | { type: "input_json_delta"; partial_json: string }
          | { type: "thinking_delta"; thinking: string }
          | { type: "signature_delta"; signature: string };
      }
    | { type: "content_block_stop"; index: number }
    | { type: "message_delta"; delta: { stop_reason?: string }; usage?: UsageSnapshot }
    | { type: "message_stop" };
};

export type ToolUseEvent = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  uuid?: string;
};

export type ToolResultEvent = {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
};

export type ResultEvent = {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution" | "error_budget_exhausted" | string;
  is_error: boolean;
  /* Result may be a plain string summary or a structured assistant message,
     depending on whether tool use occurred. Observed both empirically. */
  result?: string | { role: "assistant"; content: ContentBlock[] };
  usage?: UsageSnapshot;
  modelUsage?: Record<string, UsageSnapshot>;
  total_cost_usd?: number;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  stop_reason?: string;
  terminal_reason?: string;
  session_id?: string;
};

/** Rate-limit telemetry. Emitted around the time the request is sent. */
export type RateLimitEvent = {
  type: "rate_limit_event";
  rate_limit_info: {
    status: "allowed" | "warning" | "blocked" | string;
    resetsAt?: number;
    rateLimitType?: "five_hour" | "seven_day" | string;
    overageStatus?: "allowed" | "blocked" | string;
    overageResetsAt?: number;
    isUsingOverage?: boolean;
  };
  session_id?: string;
  uuid?: string;
};

export type UsageEvent = {
  type: "usage";
  usage: UsageSnapshot;
};

/* Token usage snapshot. Claude Code's stream-json wire format uses
   snake_case fields (mirroring the Anthropic Messages API); the Agent SDK
   normalizes the same data into camelCase. Accept both so the plugin works
   regardless of which path emits the event. */
export type UsageSnapshot = {
  model?: string;
  /* Anthropic API native (snake_case) — what the CLI actually emits. */
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /* Agent SDK normalized (camelCase) — kept for cross-compat. */
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  /* Optional plugin-side annotations. */
  contextWindow?: number;
  contextTokens?: number;
  percentage?: number;
};

export type ErrorEvent = {
  type: "error";
  subtype?: string;
  message?: string;
  error?: string;
};

/** Emitted when the CLI wants approval for a tool use. Sent with `--permission-prompt-tool stdio`. */
export type ControlRequestEvent = {
  type: "control_request";
  request_id: string;
  request: {
    subtype: "can_use_tool" | string;
    tool_name: string;
    tool_use_id?: string;
    input?: Record<string, unknown>;
    title?: string;
    display_name?: string;
    description?: string;
    permission_suggestions?: string[];
    blocked_path?: string | null;
    decision_reason?: string | null;
  };
};

export type UnknownEvent = {
  type: string;
  [key: string]: unknown;
};

/* ---------- Outbound (stdin) JSON shapes ---------- */

/** Sent on stdin to deliver a user message. */
export type OutboundUserMessage = {
  type: "user";
  session_id?: string;
  message: { role: "user"; content: ContentBlock[] };
  parent_tool_use_id?: null;
};

/** Sent on stdin in reply to a control_request. The inner `response` shape
   mirrors the Agent SDK's `CanUseToolResponse` — `behavior: "allow"` requires
   `updatedInput` (the tool input to run with, usually the original), and
   `behavior: "deny"` may include a `message` shown to the model. */
export type OutboundControlResponse = {
  type: "control_response";
  response: {
    subtype: "success" | "error";
    request_id: string;
    response:
      | { behavior: "allow"; updatedInput: Record<string, unknown> }
      | { behavior: "deny"; message?: string; interrupt?: boolean };
  };
};

export type OutboundJson = OutboundUserMessage | OutboundControlResponse;
