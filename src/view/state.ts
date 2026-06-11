/* In-memory state types shared across the chat view's sub-components.
   Phase D will persist most of this to disk; for now it lives in the view. */

export type MessageRole = "user" | "assistant";

export type ToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: "pending" | "approved" | "denied" | "running" | "completed" | "errored";
  result?: string;
  isError?: boolean;
  /* When this tool is a Task tool call (subagent spawn), the nested fields
     mirror what the subagent itself is doing — tailed live from its session
     JSONL. Absent for non-Task tools and for Task tools whose nested session
     was never discovered (e.g. the CLI declined to persist the session). */
  nestedEvents?: NestedSubagentEvent[];
  /* Resolved once the SubagentSessionTracker matches the nested JSONL. */
  nestedSessionId?: string;
  nestedStatus?: "spawning" | "running" | "completed" | "failed";
  nestedDurationMs?: number;
  /* Set when the nestedEvents buffer hit its cap (200 entries) and earlier
     events were dropped. UI surfaces this as a "[+N earlier events]" hint. */
  nestedTruncatedCount?: number;
};

/* One synthesized event from the subagent's session JSONL. The discriminator
   is `kind`; each variant carries the minimum data the timeline renderer
   needs. tool_use rows track their own status because we may see the
   tool_result for a nested call before the subagent's session JSONL has
   finished flushing all preceding entries. */
export type NestedSubagentEvent =
  | { kind: "text"; text: string }
  | {
      kind: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
      status: ToolCall["status"];
      result?: string;
      isError?: boolean;
    }
  | { kind: "thinking"; text: string };

/* Upper bound on nestedEvents length per Task tool. Prevents a single
   long-running subagent from bloating the tab's persisted JSON. The UI
   prepends a "+N earlier events" placeholder once this cap kicks in. */
export const NESTED_EVENTS_CAP = 200;

/* Attachments cover three shapes the composer can ship with a turn. Older
   persisted tabs lack `kind` entirely — treat missing kind as "image" so
   loading still works.

   - image: rides as an ImageBlock (base64 `data`).
   - pdf:   rides as a DocumentBlock (base64 `data`, filename used as title).
   - text:  not a block at all — the content is inlined into wireText as a
            fenced <file path="…"> envelope, same pattern as office extraction. */
export type Attachment = {
  kind?: "image" | "pdf" | "text";
  /* MIME type. For text fallbacks may be "text/plain" or the best-guess. */
  mediaType: string;
  /* Base64 (no data: prefix). Set for image/pdf. */
  data?: string;
  /* Raw UTF-8 text. Set for text. */
  content?: string;
  /* Original filename. Set for pdf/text; optional for image (paste has none). */
  filename?: string;
};

/* Metadata about an editor selection that was attached when the user sent
   this message. Rendered as a small "Selected from X · lines Y-Z" flag
   above the bubble; the bubble itself only shows what the user typed. */
export type SelectionContext = {
  filePath: string;
  startLine: number;
  endLine: number;
};

export type ChatMessage = {
  id: string;
  role: MessageRole;
  /* Accumulating text content. Streaming deltas append here. */
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
  attachments?: Attachment[];
  selectionContext?: SelectionContext;
  /* Vault-relative paths of notes/folders that were pinned in the file-pill
     bar when this message was sent, shipped to Claude as @-context (or inlined
     for office binaries). Rendered as small note pills above the user bubble
     so it's obvious at a glance that the turn carried extra context. Wire-only
     otherwise — the bubble text shows just what the user typed. Absent when
     nothing was attached. */
  attachedNotePaths?: string[];
  /* True while we are still receiving partial deltas for this message. */
  streaming?: boolean;
  /* Wall-clock time the model took to produce this pass, measured from
     turn start (submit) or the previous pass's completion. Only set on
     finalized assistant messages. */
  durationMs?: number;
  /* Extended-thinking trace from the model (only present when the model
     emits `thinking` content blocks; primarily Opus on max/xhigh effort). */
  thinking?: string;
  /* True while thinking deltas are still arriving. Drives the live
     pulsing indicator in the collapsed thinking section. */
  thinkingStreaming?: boolean;
};

export type TabState = {
  id: string;
  /* Claude Code session UUID. Set after the first `system` event,
     or carried in from a resumed conversation. */
  sessionId: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  /* Pending approval requests, keyed by request_id, awaiting user click. */
  pendingApprovals: Map<string, PendingApproval>;
  /* True from Send until the result event fires. Used to disable input. */
  busy: boolean;
  /* Per-tab overrides. Strings (not the typed unions) so persisted state
     from older versions stays loadable. Empty/undefined falls back to
     plugin.settings defaults. */
  model?: string;
  effort?: string;
  permissionMode?: string;
  /* ID of the applied environment snippet (looked up at spawn time so the
     snippet's `systemPromptAddendum` survives edits made after applying). */
  envSnippetId?: string;
  /* File paths pinned by the user for inclusion as @-context on every
     submit. Active-file pill toggles entries in this list. Per-tab so each
     conversation can pin its own context set. */
  pinnedFilePaths?: string[];
  /* Subset of pinnedFilePaths flagged as "sticky" — these survive submit
     instead of being auto-dropped. Default-on auto-drop saves the file
     content from re-shipping on every follow-up turn (it's already in the
     conversation history from the first turn it was attached). Shift+click
     toggles a pin's sticky state. Legacy state (field undefined) treats
     all existing pins as sticky to preserve old behavior on upgrade. */
  stickyPinnedFilePaths?: string[];
  /* Discovered slash commands + skills from the most recent system/init
     event. Refreshed on every (re)spawn. Used to populate the slash-command
     suggestion popup. Not persisted — re-derived on next subprocess spawn. */
  /* Incognito ("temporary chat") flag. Runtime-only — NEVER written to the
     persisted StoredTab, so an incognito tab leaves nothing in the vault and
     vanishes on reload. Chosen before the first message; once a session
     spawns the choice is locked. When set, the CLI is launched with
     --no-session-persistence so it writes no ~/.claude session JSONL either,
     and all vault writes for this tab are skipped. */
  incognito?: boolean;
  availableSlashCommands?: string[];
  availableSkills?: string[];
  /* MCP tools the CLI announced in the most recent system/init event,
     grouped by server name. Derived from the `tools` field by filtering
     `mcp__<server>__<tool>` entries and parsing out the server segment.
     Powers the cost-surface pill's tool count + the hover popup's
     per-server tool listing. Re-derived on every (re)spawn, never
     persisted. */
  mcpToolsByServer?: Record<string, string[]>;
};

export type PendingApproval = {
  requestId: string;
  toolName: string;
  toolUseId?: string;
  input?: Record<string, unknown>;
  description?: string;
  decisionReason?: string | null;
  blockedPath?: string | null;
};

/* 128-bit ids via crypto.randomUUID where available (Node 19+, all modern
   browsers — Obsidian's runtime ships with this). Falls back to the legacy
   ~20-bit Math.random scheme if the API is missing, since this code lands in
   an Obsidian plugin that has to start regardless. */
function makeId(prefix: string): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return `${prefix}-${cryptoObj.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export function makeTabState(opts?: { incognito?: boolean }): TabState {
  const now = Date.now();
  return {
    id: makeId("tab"),
    sessionId: null,
    title: "New chat",
    createdAt: now,
    updatedAt: now,
    messages: [],
    pendingApprovals: new Map(),
    busy: false,
    incognito: opts?.incognito || undefined,
  };
}

export function makeMessageId(): string {
  return makeId("msg");
}
