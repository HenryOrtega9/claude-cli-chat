/* Where the CLI keeps a session's transcript.

   Pure path math, split out of RemoteControlSession so that callers which only
   need to know whether a session exists on disk (the vault gateway's resume
   check) don't drag the PTY implementation into their bundle. */

/* Computes Claude Code's project directory under ~/.claude/projects. The
   algorithm replaces every non-alphanumeric character in the cwd with a
   single dash. Verified empirically against existing entries. */
export function projectDirFor(cwd: string): string {
  const home = process.env.HOME ?? "";
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return `${home}/.claude/projects/${slug}`;
}

export function sessionFilePathFor(cwd: string, sessionId: string): string {
  return `${projectDirFor(cwd)}/${sessionId}.jsonl`;
}
