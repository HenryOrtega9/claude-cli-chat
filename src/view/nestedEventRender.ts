import { platform } from "../platform";
import type { NestedSubagentEvent, ToolCall } from "./state";
import { truncateToolResult } from "./state";

/* Shared rendering helpers for subagent (Task/Agent) runs. Extracted from
   MessageRenderer so the compact group card and the full-pane drill-in view
   agree on subjects, activity lines, status wording, and icon vocabulary. */

/* Upper bound on the pretty-printed input JSON shown in a detail row. The raw
   value already lives in the persisted tab state; this is a DOM-size guard. */
const MAX_DETAIL_INPUT_CHARS = 4000;

/* Lucide icon per tool name. MessageRenderer delegates here so the main tool
   rows and the nested rows can't drift apart. */
export function iconForToolName(name: string): string {
  switch (name) {
    case "Bash": return "terminal-square";
    case "Read": return "file-text";
    case "Write": return "file-plus";
    case "Edit": return "file-edit";
    case "Grep": return "search";
    case "Glob": return "search";
    case "WebFetch": return "globe";
    case "WebSearch": return "globe";
    case "Task": return "users";
    case "Agent": return "users";
    case "TodoWrite": return "list-checks";
    case "Skill": return "zap";
    default: return "wrench";
  }
}

function statusIconFor(status: ToolCall["status"], isError?: boolean): string | null {
  if (isError) return "x";
  switch (status) {
    case "pending": return "shield-off";
    case "approved": return "shield-check";
    case "denied": return "shield-off";
    case "running": return "loader-circle";
    case "completed": return "check";
    case "errored": return "x";
  }
}

function statusAriaLabel(status: ToolCall["status"], isError?: boolean): string {
  if (isError) return "Error";
  switch (status) {
    case "pending": return "Awaiting approval";
    case "approved": return "Approved";
    case "denied": return "Denied";
    case "running": return "Running";
    case "completed": return "Completed";
    case "errored": return "Error";
  }
}

export function formatAgentDuration(ms: number): string {
  if (ms < 1000) return "<1s";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/* Best-effort subject string for a nested tool row — a short identifier
   (file_path / pattern / command). Empty string when nothing fits. */
export function nestedToolSubject(evt: Extract<NestedSubagentEvent, { kind: "tool_use" }>): string {
  const input = evt.input as { file_path?: string; path?: string; command?: string; pattern?: string; subagent_type?: string };
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  if (typeof input.command === "string") return input.command.length > 80 ? input.command.slice(0, 80) + "…" : input.command;
  if (typeof input.pattern === "string") return input.pattern;
  if (typeof input.subagent_type === "string") return input.subagent_type;
  return "";
}

/* One-line summary of the subagent's most recent step (tool name + subject, or
   the first line of a text/thinking delta), truncated so the caller's row stays
   compact. Null when there is nothing live to show. */
export function latestActivityLine(tool: ToolCall): string | null {
  const events = tool.nestedEvents;
  if (!events || events.length === 0) return null;
  const last = events[events.length - 1];
  const oneLine = (s: string, n = 72) => {
    const flat = s.replace(/\s+/g, " ").trim();
    return flat.length > n ? flat.slice(0, n - 1) + "…" : flat;
  };
  if (last.kind === "text" || last.kind === "thinking") {
    const text = oneLine(last.text);
    return text || null;
  }
  if (last.kind === "tool_use") {
    const subject = nestedToolSubject(last);
    const base = subject !== "" ? `${last.name} ${subject}` : last.name;
    const tail = last.status === "running" ? "…" : "";
    return oneLine(base) + tail;
  }
  return null;
}

export function subagentStatusLabel(tool: ToolCall): string {
  const dur = tool.nestedDurationMs;
  const durStr = dur !== undefined ? ` · ${formatAgentDuration(dur)}` : "";
  switch (tool.nestedStatus) {
    case "spawning": return "Spawning subagent…";
    case "running":  return `Running${durStr}`;
    case "completed": return `Completed${durStr}`;
    case "failed":   return `Failed${durStr}`;
    default: return "";
  }
}

function detailInputJson(input: Record<string, unknown>): string {
  try {
    const pretty = JSON.stringify(input, null, 2);
    if (!pretty || pretty === "{}") return "";
    return pretty.length > MAX_DETAIL_INPUT_CHARS
      ? `${pretty.slice(0, MAX_DETAIL_INPUT_CHARS)}\n… truncated`
      : pretty;
  } catch {
    return "";
  }
}

/* Appends one transcript event to `parent` and returns the row element. For
   tool_use rows the returned element is updatable in place via
   updateDetailToolEvent (the drill-in view mutates status/result as the
   subagent's JSONL catches up). */
export function renderDetailEvent(parent: HTMLElement, evt: NestedSubagentEvent): HTMLElement {
  const row = parent.createDiv({ cls: "claudian-agent-detail-event" });
  if (evt.kind === "text") {
    row.createDiv({ cls: "claudian-agent-detail-event-text", text: evt.text });
    return row;
  }
  if (evt.kind === "thinking") {
    row.createDiv({ cls: "claudian-agent-detail-event-thinking", text: evt.text });
    return row;
  }

  const toolEl = row.createDiv({
    cls: "claudian-agent-detail-event-tool",
    attr: { "data-event-id": evt.id },
  });
  const header = toolEl.createDiv({
    cls: "claudian-agent-detail-event-tool-header",
    attr: { role: "button", tabindex: "0" },
  });
  const icon = header.createSpan({ cls: "claudian-agent-detail-event-tool-icon" });
  platform.setIcon(icon, iconForToolName(evt.name));
  header.createSpan({ cls: "claudian-agent-detail-event-tool-name", text: evt.name });
  header.createSpan({ cls: "claudian-agent-detail-event-tool-subject" });
  header.createSpan({ cls: "claudian-agent-detail-event-tool-status" });
  toolEl.createDiv({ cls: "claudian-agent-detail-event-tool-body" });

  const toggle = () => toolEl.toggleClass("is-expanded", !toolEl.hasClass("is-expanded"));
  header.addEventListener("click", toggle);
  header.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });

  updateDetailToolEvent(row, evt);
  return row;
}

/* In-place refresh of a tool_use row previously produced by renderDetailEvent.
   Status-icon and body rebuilds are gated on state keys so a per-delta refresh
   of a long transcript doesn't re-run createElementNS for every row. */
export function updateDetailToolEvent(
  rowEl: HTMLElement,
  evt: Extract<NestedSubagentEvent, { kind: "tool_use" }>
): void {
  const toolEl = rowEl.querySelector(".claudian-agent-detail-event-tool") as HTMLElement | null;
  if (!toolEl) return;

  const subjectEl = toolEl.querySelector(".claudian-agent-detail-event-tool-subject") as HTMLElement | null;
  if (subjectEl) {
    const subject = nestedToolSubject(evt);
    subjectEl.setText(subject);
    subjectEl.toggleClass("is-empty", subject === "");
  }

  const stateKey = `${evt.status}|${evt.isError ? "err" : ""}`;
  if (toolEl.getAttribute("data-state") !== stateKey) {
    toolEl.setAttribute("data-state", stateKey);
    const statusEl = toolEl.querySelector(".claudian-agent-detail-event-tool-status") as HTMLElement | null;
    if (statusEl) {
      statusEl.empty();
      statusEl.className = evt.isError
        ? `claudian-agent-detail-event-tool-status status-${evt.status} is-error`
        : `claudian-agent-detail-event-tool-status status-${evt.status}`;
      const iconName = statusIconFor(evt.status, evt.isError);
      if (iconName) platform.setIcon(statusEl, iconName);
      statusEl.setAttr("aria-label", statusAriaLabel(evt.status, evt.isError));
    }
  }

  const bodyEl = toolEl.querySelector(".claudian-agent-detail-event-tool-body") as HTMLElement | null;
  if (!bodyEl) return;
  const inputJson = detailInputJson(evt.input);
  const bodyKey = `${inputJson.length}|${evt.result?.length ?? -1}|${evt.isError ? 1 : 0}`;
  if (bodyEl.getAttribute("data-body-key") === bodyKey) return;
  bodyEl.setAttribute("data-body-key", bodyKey);
  bodyEl.empty();
  if (inputJson) {
    bodyEl.createDiv({ cls: "claudian-agent-detail-event-tool-input", text: inputJson });
  }
  if (evt.result) {
    bodyEl.createDiv({
      cls: evt.isError
        ? "claudian-agent-detail-event-tool-result is-error"
        : "claudian-agent-detail-event-tool-result",
      text: truncateToolResult(evt.result),
    });
  }
}
