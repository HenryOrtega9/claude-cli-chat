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
};

export type Attachment = {
  /* MIME type, e.g. "image/png". */
  mediaType: string;
  /* Base64 (no data: prefix). */
  data: string;
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
  /* Discovered slash commands + skills from the most recent system/init
     event. Refreshed on every (re)spawn. Used to populate the slash-command
     suggestion popup. Not persisted — re-derived on next subprocess spawn. */
  availableSlashCommands?: string[];
  availableSkills?: string[];
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

export function makeTabState(): TabState {
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
  };
}

export function makeMessageId(): string {
  return makeId("msg");
}
