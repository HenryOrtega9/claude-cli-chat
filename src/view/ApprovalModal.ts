import { setIcon } from "obsidian";
import type { PendingApproval } from "./state";
import { editOpsFromInput, renderDiff, renderWritePreview } from "./DiffRenderer";

export type ApprovalDecision = { allowed: boolean; reason?: string };

export type ApprovalCallbacks = {
  onDecide: (requestId: string, decision: ApprovalDecision) => void;
};

/* Inline approval card shown above the input box when Claude requests
   tool permission. Multiple cards stack if there are concurrent requests. */
export class ApprovalArea {
  private root: HTMLElement;
  private cards = new Map<string, HTMLElement>();
  /* Request IDs that were dismissed (via dismissAll or a direct dismiss) before
     their show() ever landed. The SDK can emit the approval event and the
     "request resolved" event close together; on a session cancel we may want
     to drop the card before it's mounted. show() consults this set and skips. */
  private preDismissed = new Set<string>();

  constructor(parent: HTMLElement, private callbacks: ApprovalCallbacks) {
    this.root = parent.createDiv({ cls: "claudian-approval-area" });
  }

  show(approval: PendingApproval) {
    if (this.cards.has(approval.requestId)) return;
    /* If dismissAll/dismiss was called for this id before show landed,
       respect that intent and don't mount the card at all. Clear the entry
       so a future genuine approval for the same id can still surface. */
    if (this.preDismissed.has(approval.requestId)) {
      this.preDismissed.delete(approval.requestId);
      return;
    }
    const card = this.root.createDiv({ cls: "claudian-ask-approval-info" });

    const toolRow = card.createDiv({ cls: "claudian-ask-approval-tool" });
    const iconEl = toolRow.createSpan({ cls: "claudian-ask-approval-icon" });
    setIcon(iconEl, this.iconForTool(approval.toolName));
    toolRow.createSpan({ cls: "claudian-ask-approval-tool-name", text: approval.toolName });

    if (approval.decisionReason) {
      card.createDiv({ cls: "claudian-ask-approval-reason", text: approval.decisionReason });
    }
    if (approval.blockedPath) {
      card.createDiv({ cls: "claudian-ask-approval-blocked-path", text: approval.blockedPath });
    }
    if (approval.description) {
      card.createDiv({ cls: "claudian-ask-approval-desc", text: approval.description });
    }
    /* For edit-shaped tools, show the diff prominently so the user sees
       exactly what's about to change before clicking Allow. Falls back to
       the generic input preview for everything else. */
    const input = (approval.input ?? {}) as Record<string, unknown>;
    let renderedDiff = false;
    if (approval.toolName === "Edit" || approval.toolName === "MultiEdit") {
      const ops = editOpsFromInput(approval.toolName, input);
      if (ops && ops.length > 0) {
        renderDiff(card, ops, {
          filePath: typeof input.file_path === "string" ? input.file_path : undefined,
          numbered: approval.toolName === "MultiEdit" && ops.length > 1,
        });
        renderedDiff = true;
      }
    } else if (approval.toolName === "Write" && typeof input.file_path === "string" && typeof input.content === "string") {
      renderWritePreview(card, input.file_path, input.content);
      renderedDiff = true;
    }
    if (!renderedDiff) {
      const inputPreview = this.previewInput(approval);
      if (inputPreview) {
        card.createDiv({ cls: "claudian-ask-approval-desc", text: inputPreview });
      }
    }

    const actions = card.createDiv({ cls: "claudian-ask-approval-actions" });
    const denyBtn = actions.createEl("button", {
      cls: "claudian-approval-btn claudian-approval-btn-deny",
      text: "Deny",
    });
    denyBtn.addEventListener("click", () => {
      this.callbacks.onDecide(approval.requestId, { allowed: false });
      this.dismiss(approval.requestId);
    });
    const allowBtn = actions.createEl("button", {
      cls: "claudian-approval-btn claudian-approval-btn-allow",
      text: "Allow",
    });
    allowBtn.addEventListener("click", () => {
      this.callbacks.onDecide(approval.requestId, { allowed: true });
      this.dismiss(approval.requestId);
    });

    this.cards.set(approval.requestId, card);
  }

  dismiss(requestId: string) {
    const card = this.cards.get(requestId);
    if (!card) {
      /* Auto-dismiss for a card that never made it onto the DOM yet. Stash
         the id so the eventual show() can no-op cleanly. Bounded growth in
         practice: each entry is consumed by show() or by dismissAll(). */
      this.preDismissed.add(requestId);
      return;
    }
    card.remove();
    this.cards.delete(requestId);
  }

  clear() {
    this.cards.forEach(card => card.remove());
    this.cards.clear();
  }

  /* Remove every visible card. CONTRACT (consumed by Agent C / TabController):
     call on session cancel / tab exit to drop any pending UI without firing
     onDecide. The optional reason is reserved for a future "(cancelled: …)"
     toast — current implementation just tears the cards down silently.
     Also clears the preDismissed set so a fresh session starts clean. */
  dismissAll(_reason?: string): void {
    for (const card of this.cards.values()) card.remove();
    this.cards.clear();
    this.preDismissed.clear();
  }

  private iconForTool(name: string): string {
    switch (name) {
      case "Bash": return "terminal-square";
      case "Write": return "file-plus";
      case "Edit": return "file-edit";
      case "Read": return "file-text";
      default: return "wrench";
    }
  }

  private previewInput(approval: PendingApproval): string | null {
    const input = approval.input ?? {};
    if (approval.toolName === "Bash" && typeof input.command === "string") return `$ ${input.command}`;
    if (typeof input.path === "string") return input.path;
    if (typeof input.file_path === "string") return input.file_path;
    try {
      const compact = JSON.stringify(input);
      if (compact && compact !== "{}") return compact.length > 240 ? compact.slice(0, 240) + "..." : compact;
    } catch {
      /* ignore */
    }
    return null;
  }
}
