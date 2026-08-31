import { platform } from "../platform";
import type { ChatMessage, ToolCall } from "./state";
import { formatAgentDuration, latestActivityLine, subagentStatusLabel } from "./nestedEventRender";

/* One card per assistant message that spawned subagents. Every Task/Agent tool
   of that message renders as a row inside it, keyed by tool id, so a parallel
   run reads as one block instead of N tool rows interleaved with the parent's
   own Reads. Clicking a row hands the tool id back to TabController, which
   opens the full-pane drill-in view. */

export type AgentRowStatus = "spawning" | "running" | "completed" | "failed";

/* SubagentSessionTracker's nestedStatus when we have it; otherwise derive from
   the tool's own status so hosts without the tracker capability (iOS/remote)
   still get a meaningful pill. */
export function deriveAgentStatus(tool: ToolCall): AgentRowStatus {
  if (tool.nestedStatus) return tool.nestedStatus;
  if (tool.isError || tool.status === "errored" || tool.status === "denied") return "failed";
  if (tool.status === "completed") return "completed";
  if (tool.status === "running" || tool.status === "approved") return "running";
  return "spawning";
}

function fallbackStatusLabel(status: AgentRowStatus): string {
  switch (status) {
    case "spawning": return "Spawning…";
    case "running": return "Running";
    case "completed": return "Completed";
    case "failed": return "Failed";
  }
}

export class AgentGroupRenderer {
  private groupEls = new Map<string, HTMLElement>();
  private rowEls = new Map<string, HTMLElement>();
  private rowStateKeys = new Map<string, string>();
  private onAgentClick: ((toolId: string) => void) | null = null;

  setClickCallback(cb: (toolId: string) => void) {
    this.onAgentClick = cb;
  }

  /* Creates the card on first sight (at `insertBeforeEl`, or appended — the
     caller walks msg.toolCalls in order, so appending lands it at the first
     spawn's position), then refreshes the header and every row. */
  upsertGroup(
    bubbleRoot: HTMLElement,
    msg: ChatMessage,
    spawnTools: ToolCall[],
    insertBeforeEl: HTMLElement | null
  ): HTMLElement {
    let group = this.groupEls.get(msg.id);
    if (!group || !group.isConnected) {
      group = createDiv({ cls: "claudian-agent-group" });
      if (insertBeforeEl && insertBeforeEl.parentElement === bubbleRoot) {
        bubbleRoot.insertBefore(group, insertBeforeEl);
      } else {
        bubbleRoot.appendChild(group);
      }
      group.createDiv({ cls: "claudian-agent-group-header" });
      this.groupEls.set(msg.id, group);
    }

    for (const tool of spawnTools) this.upsertRow(group, tool);

    const headerEl = group.querySelector(".claudian-agent-group-header") as HTMLElement | null;
    if (headerEl) headerEl.setText(this.headerText(spawnTools));
    return group;
  }

  private headerText(spawnTools: ToolCall[]): string {
    let running = 0;
    let done = 0;
    let failed = 0;
    for (const tool of spawnTools) {
      const status = deriveAgentStatus(tool);
      if (status === "completed") done++;
      else if (status === "failed") failed++;
      else running++;
    }
    const n = spawnTools.length;
    const parts = [`${n} agent${n === 1 ? "" : "s"}`];
    if (running > 0) parts.push(`${running} running`);
    if (done > 0) parts.push(`${done} done`);
    if (failed > 0) parts.push(`${failed} failed`);
    return parts.join(" · ");
  }

  private upsertRow(group: HTMLElement, tool: ToolCall) {
    let row = this.rowEls.get(tool.id);
    if (!row || !row.isConnected) {
      row = group.createDiv({
        cls: "claudian-agent-row",
        attr: { "data-tool-id": tool.id, role: "button", tabindex: "0" },
      });
      const icon = row.createSpan({ cls: "claudian-agent-row-icon" });
      platform.setIcon(icon, "bot");
      row.createSpan({ cls: "claudian-agent-row-name" });
      row.createSpan({ cls: "claudian-agent-row-desc" });
      row.createSpan({ cls: "claudian-agent-row-status" });
      row.createDiv({ cls: "claudian-agent-row-activity" });
      row.createDiv({ cls: "claudian-agent-row-meta" });
      this.rowEls.set(tool.id, row);
      /* A recreated row starts with an empty pill, so a leftover key from the
         detached one would gate the rebuild below and leave it unstyled. */
      this.rowStateKeys.delete(tool.id);

      const open = () => this.onAgentClick?.(tool.id);
      row.addEventListener("click", open);
      row.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
    }

    /* Streaming spawns arrive with an empty input at content_block_start and
       fill in as input_json_delta parses, so every field is optional here. */
    const input = (tool.input ?? {}) as { subagent_type?: string; description?: string };
    const name = typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "agent";
    const description = typeof input.description === "string" ? input.description : "";

    const nameEl = row.querySelector(".claudian-agent-row-name") as HTMLElement | null;
    if (nameEl) nameEl.setText(name);
    const descEl = row.querySelector(".claudian-agent-row-desc") as HTMLElement | null;
    if (descEl) {
      descEl.setText(description);
      descEl.toggleClass("is-empty", description === "");
    }
    row.setAttr("aria-label", description ? `Agent ${name}: ${description}` : `Agent ${name}`);

    const status = deriveAgentStatus(tool);
    /* Same guard as MessageRenderer.upsertTool: only touch the pill when the
       tool actually transitioned, since this re-runs on every streaming delta
       of the owning message. */
    const stateKey = `${status}|${tool.isError ? 1 : 0}`;
    if (this.rowStateKeys.get(tool.id) !== stateKey) {
      this.rowStateKeys.set(tool.id, stateKey);
      row.setAttribute("data-state", stateKey);
      const statusEl = row.querySelector(".claudian-agent-row-status") as HTMLElement | null;
      if (statusEl) {
        statusEl.className = `claudian-agent-row-status is-${status}`;
        statusEl.setText(fallbackStatusLabel(status));
      }
    }
    /* Duration lands after the state key settled on "completed", so the label
       text (which carries it) is refreshed every pass regardless. */
    const statusEl = row.querySelector(".claudian-agent-row-status") as HTMLElement | null;
    if (statusEl) statusEl.setText(subagentStatusLabel(tool) || fallbackStatusLabel(status));

    const isLive = status === "spawning" || status === "running";
    const activityEl = row.querySelector(".claudian-agent-row-activity") as HTMLElement | null;
    if (activityEl) {
      const activity = isLive ? latestActivityLine(tool) : null;
      activityEl.setText(activity ?? "");
      activityEl.toggleClass("is-empty", !activity);
    }

    const metaEl = row.querySelector(".claudian-agent-row-meta") as HTMLElement | null;
    if (metaEl) {
      const steps = (tool.nestedEvents?.length ?? 0) + (tool.nestedTruncatedCount ?? 0);
      const bits: string[] = [];
      if (steps > 0) bits.push(`${steps} step${steps === 1 ? "" : "s"}`);
      if (tool.nestedDurationMs !== undefined) bits.push(formatAgentDuration(tool.nestedDurationMs));
      metaEl.setText(bits.join(" · "));
      metaEl.toggleClass("is-empty", bits.length === 0);
    }
  }

  removeForMessage(msgId: string) {
    const group = this.groupEls.get(msgId);
    if (!group) return;
    for (const [toolId, rowEl] of Array.from(this.rowEls)) {
      if (group.contains(rowEl)) {
        this.rowEls.delete(toolId);
        this.rowStateKeys.delete(toolId);
      }
    }
    group.remove();
    this.groupEls.delete(msgId);
  }

  /* DOM is wiped by the owning renderer's container.empty(); just drop the
     bookkeeping. The click callback survives — it's wired once at construction. */
  reset() {
    this.groupEls.clear();
    this.rowEls.clear();
    this.rowStateKeys.clear();
  }
}
