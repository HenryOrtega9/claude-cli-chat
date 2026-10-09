/* node:sqlite loader for the Apple Health and WHOOP stores and their CLIs.

   Two reasons this is a module of its own rather than a top-level import:

   - The repo pins @types/node ^20, which predates node:sqlite, so the slice of
     the API this code uses is typed here by hand instead of through a global
     declaration that would leak into every other build.
   - Node 24 prints "ExperimentalWarning: SQLite is an experimental feature"
     the first time the module is required. In the CLI that line would land in
     every Claude session's tool output; in the daemon it would land in
     /tmp/vault-gateway.err on every boot. The require happens lazily, inside
     a window where exactly that one warning is filtered out, and every other
     warning still reaches the default handler. */

export type SqlValue = string | number | bigint | null | Uint8Array;
export type Row = Record<string, SqlValue>;

export interface StatementSync {
  run(...params: SqlValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
  columns(): Array<{ name: string }>;
}

export interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  close(): void;
}

type SqliteModule = {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSync;
};

let cached: SqliteModule | null = null;

function loadSqlite(): SqliteModule {
  if (cached) return cached;
  const original = process.emitWarning;
  const filtered = function (this: unknown, warning: string | Error, ...rest: unknown[]): void {
    const type = typeof rest[0] === "string"
      ? rest[0]
      : (rest[0] as { type?: string } | undefined)?.type ?? (warning instanceof Error ? warning.name : "");
    const text = warning instanceof Error ? warning.message : String(warning);
    if (type === "ExperimentalWarning" && /sqlite/i.test(text)) return;
    (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require("node:sqlite") as SqliteModule;
  } finally {
    process.emitWarning = original;
  }
  return cached;
}

export function openDatabase(path: string, options: { readOnly?: boolean } = {}): DatabaseSync {
  const { DatabaseSync } = loadSqlite();
  return new DatabaseSync(path, options);
}

/* The `sql` subcommand's guard, shared by both CLIs: strip leading comments
   and whitespace, then demand SELECT or WITH, and a single statement
   (prepare() would silently ignore anything after the first). Returns the
   reason a query is refused, or null. The read-only connection is the real
   guarantee; this only fails early with a clear message. */
export function readQueryProblem(sql: string): string | null {
  const body = sql.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, "");
  if (!/^(select|with)\b/i.test(body)) return "only SELECT and WITH queries are allowed";
  const unquoted = body.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"/g, "''");
  if (/;\s*\S/.test(unquoted.replace(/--[^\n]*/g, ""))) return "one statement at a time";
  return null;
}

/* A row as JSON can carry it: bigints as numbers, blobs as a size note. */
export function jsonableRow(row: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === "bigint" ? Number(v) : v instanceof Uint8Array ? `<${v.length} bytes>` : v;
  return out;
}
