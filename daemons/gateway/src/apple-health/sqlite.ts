/* node:sqlite loader for the Apple Health store and CLI.

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
