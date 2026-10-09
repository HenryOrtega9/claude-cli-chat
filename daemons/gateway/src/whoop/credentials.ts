/* The WHOOP credentials file: ~/.config/whoop/credentials.json (mode 600, its
   directory 700), overridable by WHOOP_CREDENTIALS_FILE.

   Two writers share it: `whoop-auth` (client id/secret, the initial code
   exchange, logout) and the daemon (token refreshes). WHOOP refresh tokens
   rotate and are single use, so a lost write or two refreshes racing with the
   same token means the user has to log in again. Hence:
   - every write is a temp file plus rename, so a reader never sees a torn
     blob;
   - every read-modify-write runs under an O_EXCL lock file next to the
     credentials (credentials.lock), stale after 30 s so a crashed holder
     cannot wedge it;
   - the refresher re-reads the file inside the lock and adopts a token pair
     someone else already rotated instead of spending its stale one. */

import { promises as fs, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export type WhoopCredentials = {
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  access_token: string | null;
  refresh_token: string | null;
  /* ISO instant the access token stops working. */
  expires_at: string | null;
  scope: string | null;
  obtained_at: string | null;
};

export class CredentialsError extends Error {}

const LOCK_STALE_MS = 30_000;
/* Longer than the stale window, so a waiter always outlives a dead holder. */
const LOCK_WAIT_MS = 35_000;

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/* null when the file does not exist. A file that exists but is not a JSON
   object throws CredentialsError: that needs a human, not a silent
   "not configured". */
export async function loadCredentials(path: string): Promise<WhoopCredentials | null> {
  let text: string;
  try {
    text = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CredentialsError(`cannot read ${path}: ${(err as Error).message}`);
  }
  return parseCredentials(text, path);
}

/* loadCredentials for the daemon's constructor, which must know the auth
   state before its first (async) poll. */
export function loadCredentialsSync(path: string): WhoopCredentials | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new CredentialsError(`cannot read ${path}: ${(err as Error).message}`);
  }
  return parseCredentials(text, path);
}

function parseCredentials(text: string, path: string): WhoopCredentials {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CredentialsError(`${path} is not valid JSON`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new CredentialsError(`${path} is not a JSON object`);
  const o = raw as Record<string, unknown>;
  return {
    client_id: str(o.client_id) ?? "",
    client_secret: str(o.client_secret) ?? "",
    redirect_uri: str(o.redirect_uri) ?? "",
    access_token: str(o.access_token),
    refresh_token: str(o.refresh_token),
    expires_at: str(o.expires_at),
    scope: str(o.scope),
    obtained_at: str(o.obtained_at),
  };
}

export function hasTokens(c: WhoopCredentials | null): c is WhoopCredentials & { access_token: string; refresh_token: string } {
  return !!c && !!c.client_id && !!c.client_secret && !!c.access_token && !!c.refresh_token;
}

export async function saveCredentials(path: string, creds: WhoopCredentials): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    /* The create mode is filtered through the umask; make it exact. */
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/* Identity of the file on disk. Every save is a rename, so the inode changes
   on each write; mtime and size cover an editor writing in place. null when
   the file is absent. */
export function credentialsSignature(path: string): string | null {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

export function lockPathFor(path: string): string {
  return `${path.replace(/\.json$/, "")}.lock`;
}

export async function withCredentialsLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lock = lockPathFor(path);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await fs.open(lock, "wx", 0o600);
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const st = await fs.stat(lock).catch(() => null);
    if (st && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
      /* Rename aside rather than unlink: of two waiters reclaiming the same
         stale lock, only one rename succeeds, so the loser cannot delete the
         fresh lock the winner is about to create. */
      const aside = `${lock}.stale.${process.pid}.${randomBytes(3).toString("hex")}`;
      if (await fs.rename(lock, aside).then(() => true, () => false)) await fs.rm(aside, { force: true });
      continue;
    }
    /* A plain Error, not CredentialsError: contention is transient. */
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock}`);
    await new Promise(r => setTimeout(r, 40 + Math.floor(Math.random() * 80)));
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lock, { force: true }).catch(() => undefined);
  }
}

/* Read-modify-write under the lock. `mutate` gets the current file (null when
   absent) and returns what to write. */
export async function updateCredentials(
  path: string,
  mutate: (current: WhoopCredentials | null) => WhoopCredentials,
): Promise<WhoopCredentials> {
  return withCredentialsLock(path, async () => {
    const next = mutate(await loadCredentials(path));
    await saveCredentials(path, next);
    return next;
  });
}

export function emptyCredentials(): WhoopCredentials {
  return {
    client_id: "", client_secret: "", redirect_uri: "",
    access_token: null, refresh_token: null, expires_at: null, scope: null, obtained_at: null,
  };
}
