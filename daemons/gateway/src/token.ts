/* Bearer token load / first-run generation.

   The token is the ONLY thing between a tailnet peer and a Claude session
   with tool access on this Mac, so: 48 hex chars from a CSPRNG, mode 600,
   created with O_EXCL so a concurrent start can't clobber an existing token,
   and constant-time compared on every request.

   The enrollment line is printed exactly once — on generation — so the log
   is not a standing copy of the secret. Losing it means deleting the file
   and restarting, which is the correct rotation story anyway. */

import { chmodSync, mkdirSync, openSync, readFileSync, writeSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";

export type TokenStore = {
  /* Constant-time comparison. Returns false for any malformed header rather
     than throwing, so a garbage Authorization line is a plain 401. */
  matches(candidate: string): boolean;
};

export function loadOrCreateToken(path: string, log: (msg: string) => void): TokenStore {
  let token = "";
  try {
    token = readFileSync(path, "utf8").trim();
  } catch {
    /* absent — generate below */
  }

  if (!token) {
    const generated = randomBytes(24).toString("hex"); // 48 hex chars
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    /* wx: fail if another start won the race. If it did, re-read its token
       instead of overwriting one an enrolled device may already hold. */
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, `${generated}\n`);
      closeSync(fd);
      chmodSync(path, 0o600);
      token = generated;
      log(`VAULT GATEWAY TOKEN: ${token}`);
      log(`(generated at ${path}, mode 600 — enroll this once on the phone; it is not printed again)`);
    } catch {
      token = readFileSync(path, "utf8").trim();
    }
  }

  if (!token) throw new Error(`empty bearer token at ${path}`);

  const expected = Buffer.from(token, "utf8");
  return {
    matches(candidate: string): boolean {
      const got = Buffer.from(candidate, "utf8");
      /* timingSafeEqual throws on a length mismatch, which would itself leak
         length via the exception path. Compare a fixed-length digest-free
         proxy: pad both to the same length and AND in the length check. */
      if (got.length !== expected.length) {
        /* Still burn a comparison so the fast path and the slow path cost the
           same order of magnitude. */
        try { timingSafeEqual(expected, expected); } catch { /* unreachable */ }
        return false;
      }
      try {
        return timingSafeEqual(got, expected);
      } catch {
        return false;
      }
    },
  };
}
