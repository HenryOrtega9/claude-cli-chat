import { setIcon } from "obsidian";
import type { PendingApproval } from "./state";
import { editOpsFromInput, renderDiff, renderWritePreview } from "./DiffRenderer";

export type ApprovalDecision = { allowed: boolean; reason?: string };

export type ApprovalCallbacks = {
  onDecide: (requestId: string, decision: ApprovalDecision) => void;
};

type AskOption = { label: string; description?: string };
type AskQuestion = { question: string; header?: string; multiSelect: boolean; options: AskOption[] };
type AskQuestionState = {
  question: AskQuestion;
  selected: Set<number>;
  otherChecked: boolean;
  otherText: string;
};

function parseAskUserQuestions(input: Record<string, unknown>): AskQuestion[] {
  const raw = input.questions;
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== "object") continue;
    const obj = q as Record<string, unknown>;
    const question = typeof obj.question === "string" ? obj.question : "";
    if (!question) continue;
    const optsRaw = Array.isArray(obj.options) ? obj.options : [];
    const options: AskOption[] = [];
    for (const o of optsRaw) {
      if (!o || typeof o !== "object") continue;
      const oo = o as Record<string, unknown>;
      if (typeof oo.label !== "string") continue;
      options.push({
        label: oo.label,
        description: typeof oo.description === "string" ? oo.description : undefined,
      });
    }
    out.push({
      question,
      header: typeof obj.header === "string" ? obj.header : undefined,
      multiSelect: obj.multiSelect === true,
      options,
    });
  }
  return out;
}

function formatAskUserAnswers(state: AskQuestionState[]): string {
  const lines: string[] = ["The user answered AskUserQuestion as follows:"];
  for (const s of state) {
    const picks: string[] = [];
    for (const idx of s.selected) {
      const opt = s.question.options[idx];
      if (opt) picks.push(opt.label);
    }
    if (s.otherChecked) {
      const text = s.otherText.trim();
      picks.push(text ? `Other: ${text}` : "Other");
    }
    const answer = picks.length > 0 ? picks.join(", ") : "(no selection)";
    lines.push(`- ${s.question.question} -> ${answer}`);
  }
  return lines.join("\n");
}

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
       the generic input preview for everything else. AskUserQuestion takes
       its own picker UI path below. */
    const input = (approval.input ?? {}) as Record<string, unknown>;
    let renderedSpecial = false;
    if (approval.toolName === "Edit" || approval.toolName === "MultiEdit") {
      const ops = editOpsFromInput(approval.toolName, input);
      if (ops && ops.length > 0) {
        renderDiff(card, ops, {
          filePath: typeof input.file_path === "string" ? input.file_path : undefined,
          numbered: approval.toolName === "MultiEdit" && ops.length > 1,
        });
        renderedSpecial = true;
      }
    } else if (approval.toolName === "Write" && typeof input.file_path === "string" && typeof input.content === "string") {
      renderWritePreview(card, input.file_path, input.content);
      renderedSpecial = true;
    } else if (approval.toolName === "AskUserQuestion") {
      const questions = parseAskUserQuestions(input);
      if (questions.length > 0) {
        this.renderAskUserQuestion(card, approval.requestId, questions);
        this.cards.set(approval.requestId, card);
        return;
      }
    }
    if (!renderedSpecial) {
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

  /* AskUserQuestion picker: radios for single-select, checkboxes for multi,
     plus an "Other" free-text input per question. On submit we DENY the tool
     call with a reason containing the formatted answers — the model reads the
     reason and treats it as the user's response, which avoids the headless
     CLI trying (and failing) to execute the tool itself in --print mode. */
  private renderAskUserQuestion(card: HTMLElement, requestId: string, questions: AskQuestion[]) {
    const form = card.createDiv({ cls: "claudian-askuser-form" });
    const state: AskQuestionState[] = questions.map(q => ({
      question: q,
      selected: new Set<number>(),
      otherChecked: false,
      otherText: "",
    }));

    questions.forEach((q, qIdx) => {
      const block = form.createDiv({ cls: "claudian-askuser-question" });
      block.createDiv({ cls: "claudian-askuser-prompt", text: q.question });
      const inputType = q.multiSelect ? "checkbox" : "radio";
      const groupName = `askuser-${requestId}-${qIdx}`;

      q.options.forEach((opt, optIdx) => {
        const row = block.createEl("label", { cls: "claudian-askuser-option" });
        const input = row.createEl("input");
        input.type = inputType;
        input.name = groupName;
        input.value = String(optIdx);
        input.addEventListener("change", () => {
          if (q.multiSelect) {
            if (input.checked) state[qIdx].selected.add(optIdx);
            else state[qIdx].selected.delete(optIdx);
          } else {
            state[qIdx].selected.clear();
            state[qIdx].selected.add(optIdx);
            /* Single-select: picking a listed option must drop any prior
               "Other" choice. The browser visually unchecks the Other radio
               (shared group name) but fires no change event on it, so reset
               the Other state here to keep the two mutually exclusive. */
            state[qIdx].otherChecked = false;
            state[qIdx].otherText = "";
            otherInput.checked = false;
            otherField.value = "";
          }
        });
        const text = row.createDiv({ cls: "claudian-askuser-option-text" });
        text.createDiv({ cls: "claudian-askuser-option-label", text: opt.label });
        if (opt.description) {
          text.createDiv({ cls: "claudian-askuser-option-desc", text: opt.description });
        }
      });

      /* "Other" is implicit on AskUserQuestion — always offer a free-text
         escape hatch so the user isn't boxed into the listed options. */
      const otherRow = block.createEl("label", { cls: "claudian-askuser-option" });
      const otherInput = otherRow.createEl("input");
      otherInput.type = inputType;
      otherInput.name = groupName;
      const otherText = otherRow.createDiv({ cls: "claudian-askuser-option-text" });
      otherText.createDiv({ cls: "claudian-askuser-option-label", text: "Other" });
      const otherField = otherText.createEl("input", { cls: "claudian-askuser-other-input" });
      otherField.type = "text";
      otherField.placeholder = "Type your answer";
      otherInput.addEventListener("change", () => {
        if (q.multiSelect) {
          state[qIdx].otherChecked = otherInput.checked;
        } else {
          state[qIdx].otherChecked = true;
          state[qIdx].selected.clear();
        }
        if (otherInput.checked) otherField.focus();
      });
      otherField.addEventListener("input", () => {
        state[qIdx].otherText = otherField.value;
        if (!otherInput.checked) {
          otherInput.checked = true;
          otherInput.dispatchEvent(new Event("change"));
        }
      });
      otherField.addEventListener("click", e => e.preventDefault());
    });

    const actions = card.createDiv({ cls: "claudian-ask-approval-actions" });
    const cancelBtn = actions.createEl("button", {
      cls: "claudian-approval-btn claudian-approval-btn-deny",
      text: "Cancel",
    });
    cancelBtn.addEventListener("click", () => {
      this.callbacks.onDecide(requestId, { allowed: false, reason: "User cancelled the question." });
      this.dismiss(requestId);
    });
    const submitBtn = actions.createEl("button", {
      cls: "claudian-approval-btn claudian-approval-btn-allow",
      text: "Submit",
    });
    submitBtn.addEventListener("click", () => {
      const reason = formatAskUserAnswers(state);
      this.callbacks.onDecide(requestId, { allowed: false, reason });
      this.dismiss(requestId);
    });
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
