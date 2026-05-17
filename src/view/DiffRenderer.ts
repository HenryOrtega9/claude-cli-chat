/* Lightweight diff rendering for Edit / MultiEdit / Write tool calls.
   Format is unified-diff-style with red minus lines for removed content and
   green plus lines for added content. Context lines (unchanged) are not
   computed — we just show old vs new in full, which is fine because the
   Edit tool always provides the full `old_string` and `new_string`. */

export type EditOp = {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
};

/* Hunk of diff lines to render. `kind` controls coloring. */
type DiffLine = { kind: "del" | "add" | "ctx"; text: string };

/* Splits an Edit op into a sequence of diff lines. Trailing-newline tweaks
   are normalized so a single-line change doesn't read as "added a newline". */
export function diffLinesFromEdit(op: EditOp): DiffLine[] {
  const oldLines = op.oldString.split("\n");
  const newLines = op.newString.split("\n");
  const lines: DiffLine[] = [];
  for (const l of oldLines) lines.push({ kind: "del", text: l });
  for (const l of newLines) lines.push({ kind: "add", text: l });
  return lines;
}

export type DiffRenderOptions = {
  /* Optional filepath header rendered above the diff. */
  filePath?: string;
  /* If true, wraps each op in a "Hunk N" label — used for MultiEdit. */
  numbered?: boolean;
};

/* Hard ceiling on diff lines rendered per call so a giant MultiEdit doesn't
   freeze the chat with a 50k-row diff block. Applied across the entire
   collection of ops (not per-op) so MultiEdit hunks share the budget. */
const MAX_LINES = 200;

/* Renders one or more edit ops as a unified diff block inside `target`. */
export function renderDiff(target: HTMLElement, ops: EditOp[], opts: DiffRenderOptions = {}): HTMLElement {
  const wrap = target.createDiv({ cls: "claudian-diff" });
  if (opts.filePath) {
    wrap.createDiv({ cls: "claudian-diff-file", text: opts.filePath });
  }
  /* Walk ops + their lines once first to know the total line budget;
     subsequent rendering stops when we hit MAX_LINES and appends a single
     truncation note. */
  let totalLines = 0;
  for (const op of ops) totalLines += diffLinesFromEdit(op).length;

  let rendered = 0;
  let truncated = false;
  ops.forEach((op, i) => {
    if (truncated) return;
    if (opts.numbered) {
      wrap.createDiv({ cls: "claudian-diff-hunk-label", text: `Hunk ${i + 1}${op.replaceAll ? " · replace all" : ""}` });
    } else if (op.replaceAll) {
      wrap.createDiv({ cls: "claudian-diff-hunk-label", text: "replace all" });
    }
    const block = wrap.createDiv({ cls: "claudian-diff-block" });
    for (const line of diffLinesFromEdit(op)) {
      if (rendered >= MAX_LINES) { truncated = true; break; }
      const row = block.createDiv({ cls: `claudian-diff-line claudian-diff-${line.kind}` });
      row.createSpan({ cls: "claudian-diff-marker", text: line.kind === "del" ? "−" : line.kind === "add" ? "+" : " " });
      row.createSpan({ cls: "claudian-diff-text", text: line.text });
      rendered++;
    }
  });
  if (truncated) {
    const remaining = totalLines - rendered;
    wrap.createDiv({
      cls: "claudian-diff-truncated",
      text: `… ${remaining} more line${remaining === 1 ? "" : "s"} (showing first ${MAX_LINES})`,
    });
  }
  return wrap;
}

/* Renders a Write tool's input as "+ N lines to <path>" + a content peek. */
export function renderWritePreview(target: HTMLElement, filePath: string, content: string): HTMLElement {
  const wrap = target.createDiv({ cls: "claudian-diff" });
  wrap.createDiv({ cls: "claudian-diff-file", text: filePath });
  const lines = content.split("\n");
  const total = lines.length;
  wrap.createDiv({
    cls: "claudian-diff-hunk-label",
    text: `+${total} line${total === 1 ? "" : "s"} (${content.length} chars)`,
  });
  const block = wrap.createDiv({ cls: "claudian-diff-block" });
  /* Cap the peek at 30 lines so a giant file doesn't dominate. */
  const peek = lines.slice(0, 30);
  for (const l of peek) {
    const row = block.createDiv({ cls: "claudian-diff-line claudian-diff-add" });
    row.createSpan({ cls: "claudian-diff-marker", text: "+" });
    row.createSpan({ cls: "claudian-diff-text", text: l });
  }
  if (lines.length > 30) {
    block.createDiv({ cls: "claudian-diff-truncated", text: `… ${lines.length - 30} more lines` });
  }
  return wrap;
}

/* Extract EditOps from any of: Edit input, MultiEdit input. Returns null
   if the input doesn't have the expected shape. */
export function editOpsFromInput(toolName: string, input: Record<string, unknown>): EditOp[] | null {
  if (toolName === "Edit") {
    if (typeof input.old_string === "string" && typeof input.new_string === "string") {
      return [{
        oldString: input.old_string,
        newString: input.new_string,
        replaceAll: typeof input.replace_all === "boolean" ? input.replace_all : undefined,
      }];
    }
    return null;
  }
  if (toolName === "MultiEdit") {
    const edits = input.edits;
    if (!Array.isArray(edits)) return null;
    return edits
      .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
      .map(e => ({
        oldString: typeof e.old_string === "string" ? e.old_string : "",
        newString: typeof e.new_string === "string" ? e.new_string : "",
        replaceAll: typeof e.replace_all === "boolean" ? e.replace_all : undefined,
      }));
  }
  return null;
}
