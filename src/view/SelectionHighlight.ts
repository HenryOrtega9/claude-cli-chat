import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/* Keeps the selection that is pinned to the chat composer visibly
   highlighted in its editor after focus moves to the chat input.

   The editor's blue highlight is the document's native selection, and a
   document has only one: clicking the chat textarea moves it there, so the
   editor's highlight vanishes even though the selection chip still holds the
   text. This field paints the same range as a mark decoration instead. CSS
   shows it only while the editor is unfocused, so it never doubles up on the
   live selection while the user is still selecting.

   One range per editor, last writer wins. Every chat tab runs its own
   SelectionTracker over the same editors, and they all report the same
   selection, so a shared range matches what the visible tab's chip shows. */

const setKept = StateEffect.define<{ from: number; to: number } | null>();

const keptMark = Decoration.mark({ class: "claudian-kept-selection" });

const keptField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    /* Map through edits first so the highlight tracks the text when the note
       changes under it (e.g. Claude editing the file mid-turn). */
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setKept)) continue;
      const r = e.value;
      deco = r && r.to > r.from ? Decoration.set([keptMark.range(r.from, r.to)]) : Decoration.none;
    }
    return deco;
  },
  provide: f => EditorView.decorations.from(f),
});

export const selectionHighlightExtension: Extension = keptField;

/* Clamps to the current doc so a stale range from a tracker can never throw
   a RangeError inside dispatch. */
export function setKeptSelection(view: EditorView, from: number, to: number): void {
  const len = view.state.doc.length;
  const a = Math.max(0, Math.min(from, len));
  const b = Math.max(0, Math.min(to, len));
  view.dispatch({ effects: setKept.of({ from: Math.min(a, b), to: Math.max(a, b) }) });
}

export function clearKeptSelection(view: EditorView): void {
  /* No-op when the field isn't installed or already empty: skips a pointless
     transaction on every cursor move. */
  const deco = view.state.field(keptField, false);
  if (!deco || deco.size === 0) return;
  view.dispatch({ effects: setKept.of(null) });
}
