/* Node-backed implementations of the optional PluginHost capabilities.

   ONLY the two node hosts may import this file: src/main.ts (the Obsidian
   plugin) and app/src/host.ts (the Electron shell). Shared code reaches these
   through `PluginHost` so the same view layer can run in a plain browser,
   where every one of them is absent.

   Each function is a verbatim lift of the code TabController / the subagent
   modals used to run inline — same arguments, same order, same error
   swallowing — so routing through the host changes nothing on the desktop. */

import { rm } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { JsonlTailer } from "../claude/JsonlTailer";
import { RemoteControlSession, projectDirFor, sessionFilePathFor } from "../claude/RemoteControlSession";
import { SubagentSessionTracker } from "../claude/SubagentSessionTracker";
import type { SubprocessManager } from "../claude/SubprocessManager";
import type {
  JsonlTailerHandle,
  RemoteControlRequest,
  SubagentFileResult,
  SubagentTrackerHandle,
  SubagentTrackerRequest,
} from "./host";
import type { RemoteControlSessionLike } from "./engine";

/* Delete every on-disk file the CLI wrote for an incognito tab's sessions:
   the per-session `<id>.jsonl` (which holds the ai-title) and the `<id>/`
   subdirectory (subagent transcripts). Best-effort and idempotent — rm with
   `force` never throws on a missing path. Only the caller's own session ids
   are ever passed, so this never touches another tab's files in the shared
   project dir. */
export function removeSessionFiles(cwd: string, sessionIds: string[]): Promise<void> {
  const work: Promise<unknown>[] = [];
  for (const id of sessionIds) {
    work.push(rm(sessionFilePathFor(cwd, id), { force: true }).catch(() => {}));
    work.push(rm(`${projectDirFor(cwd)}/${id}`, { force: true, recursive: true }).catch(() => {}));
  }
  return Promise.all(work).then(() => undefined);
}

export function createJsonlTailer(path: string): JsonlTailerHandle {
  return new JsonlTailer(path);
}

export function createSubagentTracker(
  subprocessManager: SubprocessManager,
  opts: SubagentTrackerRequest,
): SubagentTrackerHandle {
  return new SubagentSessionTracker({ ...opts, subprocessManager });
}

export function createRemoteControlSession(opts: RemoteControlRequest): RemoteControlSessionLike {
  return new RemoteControlSession(opts);
}

/* Writes a subagent definition (.md with YAML frontmatter) into the
   user-global or project agents dir. Refuses to clobber an existing file —
   the caller turns each failure kind into its own notice. */
export function writeSubagentFile(
  vaultPath: string,
  opts: { scope: "user" | "project"; name: string; contents: string },
): SubagentFileResult {
  let dir: string;
  if (opts.scope === "user") {
    dir = join(homedir(), ".claude", "agents");
  } else {
    if (!vaultPath) return { ok: false, kind: "no_vault" };
    dir = join(vaultPath, ".claude", "agents");
  }
  const filePath = join(dir, `${opts.name}.md`);
  if (existsSync(filePath)) return { ok: false, kind: "exists" };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, opts.contents, "utf8");
  } catch (err) {
    console.error("[claude-cli-chat] failed to write subagent file", err);
    return { ok: false, kind: "write_failed", message: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true };
}

/* macOS `open <path>` defers to the file's default app — usually a markdown
   editor; `open -R` reveals it in Finder. Both hosts are macOS-only so the
   bare `open` is safe. Throws are left to the caller. */
export function openPathExternally(path: string, mode: "open" | "reveal"): void {
  const args = mode === "reveal" ? ["-R", path] : [path];
  spawn("open", args, { stdio: "ignore", detached: true }).unref();
}
