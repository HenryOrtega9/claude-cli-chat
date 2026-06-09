/* Office-format text extractors.

   Claude Code's Read tool rejects binary container formats (.pptx, .docx,
   .xlsx) with a tool_use_error. To let the user pin or @-mention these
   files, we read the bytes via the Obsidian vault adapter, extract a plain
   text representation here, and inline that into the wire text before it
   reaches the CLI. Claude then sees the slide/document/sheet content as if
   it were plain text. */

import type { App } from "obsidian";
import JSZip from "jszip";
import mammoth from "mammoth";

const EXTRACTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  "pptx", "docx", "xlsx",
]);

function getExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "";
  return path.slice(dot + 1).toLowerCase();
}

export function isExtractableOffice(path: string): boolean {
  return EXTRACTABLE_EXTENSIONS.has(getExtension(path));
}

/* Read a vault file as raw bytes. Pinned paths come from the vault, so this
   works for any file the user can pin via the pill bar. */
async function readVaultBinary(app: App, path: string): Promise<ArrayBuffer> {
  return app.vault.adapter.readBinary(path);
}

/* .pptx is a zip with slide XML at ppt/slides/slideN.xml. Each slide's
   visible text lives in <a:t> elements (runs). We pull those out in slide
   order and stitch them into a plain-text dump that preserves slide
   boundaries so Claude can reason about "slide 3" etc. */
async function extractPptxText(buffer: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml$/)![1], 10);
      const nb = parseInt(b.match(/slide(\d+)\.xml$/)![1], 10);
      return na - nb;
    });

  const out: string[] = [];
  for (let i = 0; i < slideFiles.length; i++) {
    const xml = await zip.files[slideFiles[i]].async("string");
    /* Pull every <a:t>…</a:t> run; order in the XML matches reading order.
       The attr part must not end in `/`: a bare `[^>]*` also matches the
       trailing slash of a self-closing `<a:t/>` (empty run), making the
       open-tag branch swallow everything up to the NEXT closing tag and
       dropping real runs. Same guard on every OOXML regex in this file. */
    const runs: string[] = [];
    const re = /<a:t(?:[^>]*[^/>])?>([\s\S]*?)<\/a:t>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) {
      const txt = decodeXmlEntities(m[1]);
      if (txt.trim()) runs.push(txt);
    }
    out.push(`--- Slide ${i + 1} ---`);
    out.push(runs.length > 0 ? runs.join("\n") : "(no text)");
    out.push("");
  }
  return out.join("\n").trimEnd();
}

async function extractDocxText(buffer: ArrayBuffer): Promise<string> {
  /* mammoth's extractRawText preserves paragraph breaks as \n\n and ignores
     styling — good enough for an LLM to read. convertToMarkdown is heavier
     and adds noise mammoth can't always get right (e.g. mis-quoted list
     markers). Raw text is the safer default. */
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value.trimEnd();
}

function decodeXmlEntities(s: string): string {
  /* Decode the four other named entities and numeric/hex character refs
     first, then &amp; LAST. Decoding &amp; first would re-interpret its
     output (e.g. "&amp;lt;" -> "&lt;" -> "<"), corrupting text that
     legitimately encodes a literal escaped sequence. Numeric refs like
     &#10; (in-cell line breaks) and &#x2014; (em-dash) are legal OOXML
     and must be decoded too. */
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

/* Column index from an A1-style ref: A->0, B->1, ..., Z->25, AA->26. */
function colIndexFromRef(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* .xlsx is a zip with strings interned in xl/sharedStrings.xml and cells
   in xl/worksheets/sheetN.xml. Cells with t="s" are indices into the
   shared-strings table; everything else carries its literal value in <v>
   (or inline <is><t>). We render each sheet as TSV so column alignment
   survives the trip to Claude. Sheet names come from xl/workbook.xml. */
async function extractXlsxText(buffer: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);

  /* Shared-strings table: each <si> can have a single <t> or multiple <t>
     runs (rich text). Concat all <t> children for each <si>. */
  const sharedStrings: string[] = [];
  const ssFile = zip.files["xl/sharedStrings.xml"];
  if (ssFile) {
    const xml = await ssFile.async("string");
    /* Excel emits empty entries as self-closing <si/>. The first branch's
       attr group is constrained to not end in `/` so those fall through to
       the explicit second branch instead of lazily swallowing every
       following <si> up to the next </si> — which would shift every
       subsequent shared-string index and mislabel every string cell. The
       self-closing branch still contributes an empty string (m[1] is
       undefined there) to keep indices aligned. */
    const siRe = /<si\b(?:[^>]*[^/>])?>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
    let m: RegExpExecArray | null;
    while ((m = siRe.exec(xml)) !== null) {
      const tRe = /<t(?:[^>]*[^/>])?>([\s\S]*?)<\/t>/g;
      const parts: string[] = [];
      let t: RegExpExecArray | null;
      while ((t = tRe.exec(m[1] ?? "")) !== null) parts.push(decodeXmlEntities(t[1]));
      sharedStrings.push(parts.join(""));
    }
  }

  /* Workbook lists sheets with their display names and sheet-file rIds.
     We don't bother resolving rIds — just match the sheet order to the
     file order via xl/worksheets/sheet{N}.xml, which lines up in
     well-formed xlsx files. */
  const sheetNames: string[] = [];
  const wbFile = zip.files["xl/workbook.xml"];
  if (wbFile) {
    const xml = await wbFile.async("string");
    const re = /<sheet\b[^>]*\sname="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml)) !== null) sheetNames.push(decodeXmlEntities(m[1]));
  }

  const sheetFiles = Object.keys(zip.files)
    .filter(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = parseInt(a.match(/sheet(\d+)\.xml$/)![1], 10);
      const nb = parseInt(b.match(/sheet(\d+)\.xml$/)![1], 10);
      return na - nb;
    });

  const out: string[] = [];
  for (let i = 0; i < sheetFiles.length; i++) {
    const sheetName = sheetNames[i] ?? `Sheet${i + 1}`;
    const xml = await zip.files[sheetFiles[i]].async("string");

    /* Walk rows; build a sparse grid keyed by column index to preserve
       column alignment for cells that span gaps (e.g. only A and C used). */
    /* Self-closing <row/> (an empty row) must not match the open-tag form,
       or it absorbs all following rows up to the next </row>. Empty rows
       carry no cells, so skipping them entirely is correct. */
    const rowRe = /<row\b(?:[^>]*[^/>])?>([\s\S]*?)<\/row>/g;
    const rows: string[][] = [];
    let maxCol = -1;
    let r: RegExpExecArray | null;
    while ((r = rowRe.exec(xml)) !== null) {
      const cells: string[] = [];
      /* Styled-but-empty cells are routinely emitted self-closing
         (<c r="A1" s="5"/>). Constrain the first branch so they hit the
         dedicated self-closing branch instead of stealing the next real
         cell's body (which shifted values and dropped cells silently). */
      const cellRe = /<c\b((?:[^>]*[^/>])?)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
      let c: RegExpExecArray | null;
      while ((c = cellRe.exec(r[1])) !== null) {
        const attrs = c[1] ?? c[3] ?? "";
        const body = c[2] ?? "";
        const refMatch = attrs.match(/\br="([A-Z]+\d+)"/);
        const colIdx = refMatch ? colIndexFromRef(refMatch[1]) : cells.filter(x => x !== undefined).length;
        const typeMatch = attrs.match(/\bt="([^"]+)"/);
        const type = typeMatch?.[1];
        let value = "";
        if (type === "s") {
          const v = body.match(/<v>([\s\S]*?)<\/v>/);
          if (v) value = sharedStrings[parseInt(v[1], 10)] ?? "";
        } else if (type === "inlineStr") {
          const t = body.match(/<t(?:[^>]*[^/>])?>([\s\S]*?)<\/t>/);
          if (t) value = decodeXmlEntities(t[1]);
        } else {
          const v = body.match(/<v>([\s\S]*?)<\/v>/);
          if (v) value = decodeXmlEntities(v[1]);
        }
        while (cells.length <= colIdx) cells.push("");
        cells[colIdx] = value;
        if (colIdx > maxCol) maxCol = colIdx;
      }
      rows.push(cells);
    }

    out.push(`--- Sheet: ${sheetName} ---`);
    if (rows.length === 0) {
      out.push("(empty)");
    } else {
      /* Pad short rows to maxCol so TSV columns line up across the sheet.
         Skip trailing empty rows for compactness. */
      const trimmed = [...rows];
      while (trimmed.length > 0 && trimmed[trimmed.length - 1].every(c => !c)) trimmed.pop();
      for (const row of trimmed) {
        while (row.length <= maxCol) row.push("");
        out.push(row.join("\t"));
      }
    }
    out.push("");
  }

  return out.join("\n").trimEnd();
}

/* Extract a plain-text representation of an office binary file. Throws on
   unsupported extension or read/parse failure — caller decides how to
   surface the error to the user. */
export async function extractOfficeText(app: App, path: string): Promise<string> {
  const ext = getExtension(path);
  const buffer = await readVaultBinary(app, path);
  if (ext === "pptx") return extractPptxText(buffer);
  if (ext === "docx") return extractDocxText(buffer);
  if (ext === "xlsx") return extractXlsxText(buffer);
  throw new Error(`No extractor for .${ext}`);
}
