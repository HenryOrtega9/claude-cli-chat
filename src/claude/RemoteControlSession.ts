import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { autodetectClaudePath } from "../settings";

export type RemoteStatus = "starting" | "waiting" | "ready" | "exited" | "error";

export type RemoteControlOptions = {
  cwd: string;
  sessionId?: string;
  sessionName?: string;
  claudePath?: string;
};

type UrlListener = (url: string) => void;
type StatusListener = (status: RemoteStatus) => void;
type SessionFileListener = (path: string) => void;
type ErrorListener = (err: Error) => void;
type ExitListener = (code: number | null) => void;

/* Strips ANSI escape sequences from a chunk of terminal output. Covers CSI
   sequences (`\x1b[...m`), OSC titles (`\x1b]...\x07`), and lone control bytes
   the PTY emits during cursor positioning. */
function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[()][AB012]/g, "")
    .replace(/\r/g, "");
}

const URL_PATTERN = /https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/;
const TRUST_PROMPT_PATTERN = /trust this folder|Yes, I trust this folder/i;

/* Inline Python PTY proxy. macOS `script -q /dev/null <cmd>` is the textbook
   way to wrap a process in a PTY, but it requires its own stdin to be a TTY
   (it calls tcgetattr on fd 0 to inherit terminal settings). When invoked
   from Node child_process.spawn with piped stdio, fd 0 is a socket, so
   `script` errors out with "Operation not supported on socket".

   Python's `pty.fork()` allocates a fresh PTY pair without inheriting the
   caller's terminal, so it works fine over pipes. We embed the proxy here
   to avoid shipping a separate .py file with the plugin. */
const PTY_PROXY_SCRIPT = `
import pty, os, sys, select, fcntl, signal
cmd = sys.argv[1:]
if not cmd: sys.exit(2)
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)
def _term(signum, frame):
    try: os.kill(pid, signal.SIGTERM)
    except OSError: pass
signal.signal(signal.SIGTERM, _term)
signal.signal(signal.SIGHUP, _term)
fcntl.fcntl(0, fcntl.F_SETFL, os.O_NONBLOCK)
fcntl.fcntl(fd, fcntl.F_SETFL, os.O_NONBLOCK)
try:
    while True:
        try:
            rlist, _, _ = select.select([0, fd], [], [], 0.1)
        except (OSError, InterruptedError):
            continue
        if 0 in rlist:
            try:
                data = os.read(0, 4096)
                if data: os.write(fd, data)
            except (BlockingIOError, OSError): pass
        if fd in rlist:
            try:
                data = os.read(fd, 4096)
                if not data: break
                os.write(1, data)
            except (BlockingIOError, OSError): pass
        done, st = os.waitpid(pid, os.WNOHANG)
        if done:
            sys.exit(os.WEXITSTATUS(st) if os.WIFEXITED(st) else 1)
except KeyboardInterrupt:
    try: os.kill(pid, signal.SIGTERM)
    except OSError: pass
`;

/* Wraps `claude --remote-control` in a PTY via macOS `script -q /dev/null`.
   The CLI emits an ANSI-laden interactive UI; we strip it, auto-confirm the
   first-launch trust prompt, and watch for the pairing URL.

   Sibling JsonlTailer is responsible for surfacing the actual conversation;
   this class only owns the spawn lifecycle and URL discovery. */
export class RemoteControlSession {
  status: RemoteStatus = "starting";
  url: string | null = null;
  sessionFile: string | null = null;

  private child: ChildProcessWithoutNullStreams;
  private spawnTime: number;
  private cwd: string;
  private stdoutBuffer = "";
  private trustConfirmed = false;
  private urlListeners: UrlListener[] = [];
  private statusListeners: StatusListener[] = [];
  private sessionFileListeners: SessionFileListener[] = [];
  private errorListeners: ErrorListener[] = [];
  private exitListeners: ExitListener[] = [];
  private sessionFilePoll: ReturnType<typeof setInterval> | null = null;

  constructor(opts: RemoteControlOptions) {
    this.cwd = opts.cwd;
    this.spawnTime = Date.now();

    const claude = opts.claudePath || autodetectClaudePath() || "claude";
    const pyArgs = ["-c", PTY_PROXY_SCRIPT, claude, "--remote-control"];
    if (opts.sessionName) pyArgs.push(opts.sessionName);
    if (opts.sessionId) pyArgs.push("--resume", opts.sessionId);

    /* eslint-disable no-console */
    console.log(`[claude-cli-chat] RC spawn`, { claude, sessionName: opts.sessionName, cwd: opts.cwd });

    this.child = spawn("/usr/bin/python3", pyArgs, {
      cwd: opts.cwd,
      env: { ...process.env, TERM: "xterm-256color" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", chunk => this.handleStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", chunk => console.warn(`[claude-cli-chat] RC stderr:`, chunk));

    this.child.on("error", err => {
      console.error(`[claude-cli-chat] RC error:`, err);
      this.setStatus("error");
      for (const cb of this.errorListeners) cb(err);
    });

    this.child.on("exit", code => {
      console.log(`[claude-cli-chat] RC exit code=${code}`);
      this.setStatus("exited");
      this.stopSessionFilePoll();
      for (const cb of this.exitListeners) cb(code);
    });

    /* If an explicit sessionId was provided, we know the JSONL path upfront.
       Otherwise poll the project dir for a newer file appearing post-spawn. */
    if (opts.sessionId) {
      const path = sessionFilePathFor(this.cwd, opts.sessionId);
      if (existsSync(path)) {
        this.sessionFile = path;
        for (const cb of this.sessionFileListeners) cb(path);
      }
    } else {
      this.startSessionFilePoll();
    }
  }

  onUrl(cb: UrlListener) { this.urlListeners.push(cb); }
  onStatus(cb: StatusListener) { this.statusListeners.push(cb); }
  onSessionFile(cb: SessionFileListener) { this.sessionFileListeners.push(cb); }
  onError(cb: ErrorListener) { this.errorListeners.push(cb); }
  onExit(cb: ExitListener) { this.exitListeners.push(cb); }

  async dispose(): Promise<void> {
    this.stopSessionFilePoll();
    if (this.status === "exited") return;
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        try { this.child.kill("SIGKILL"); } catch { /* ignore */ }
        resolve();
      }, 1500);
      this.child.once("exit", () => { clearTimeout(timeout); resolve(); });
      try { this.child.kill("SIGTERM"); } catch { /* ignore */ }
    });
  }

  private handleStdout(chunk: string) {
    this.stdoutBuffer += stripAnsi(chunk);

    /* Auto-confirm trust prompt by sending Enter. The CLI pre-selects "Yes,
       I trust this folder" so a bare newline accepts. Only fires once. */
    if (!this.trustConfirmed && TRUST_PROMPT_PATTERN.test(this.stdoutBuffer)) {
      this.trustConfirmed = true;
      console.log(`[claude-cli-chat] RC auto-confirming trust prompt`);
      try { this.child.stdin.write("\r"); } catch { /* ignore */ }
    }

    if (!this.url) {
      const match = this.stdoutBuffer.match(URL_PATTERN);
      if (match) {
        this.url = match[0];
        this.setStatus("ready");
        console.log(`[claude-cli-chat] RC paired url=${this.url}`);
        for (const cb of this.urlListeners) cb(this.url);
      } else if (this.status === "starting" && /remote control|connecting/i.test(this.stdoutBuffer)) {
        this.setStatus("waiting");
      }
    }
  }

  private setStatus(status: RemoteStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const cb of this.statusListeners) cb(status);
  }

  private startSessionFilePoll() {
    const dir = projectDirFor(this.cwd);
    /* Poll every 500ms for up to 30s for a new .jsonl file. Inotify would be
       cleaner but adds complexity; polling is sufficient for one-time
       discovery. */
    let attempts = 0;
    this.sessionFilePoll = setInterval(() => {
      attempts++;
      if (attempts > 60 || this.sessionFile) {
        this.stopSessionFilePoll();
        return;
      }
      if (!existsSync(dir)) return;
      try {
        const files = readdirSync(dir).filter(f => f.endsWith(".jsonl"));
        let newest: { path: string; mtime: number } | null = null;
        for (const file of files) {
          const fullPath = join(dir, file);
          try {
            const st = statSync(fullPath);
            const mtime = st.mtimeMs;
            if (mtime >= this.spawnTime - 1000 && (!newest || mtime > newest.mtime)) {
              newest = { path: fullPath, mtime };
            }
          } catch { /* ignore */ }
        }
        if (newest) {
          this.sessionFile = newest.path;
          this.stopSessionFilePoll();
          console.log(`[claude-cli-chat] RC session file detected: ${newest.path}`);
          for (const cb of this.sessionFileListeners) cb(newest.path);
        }
      } catch { /* ignore */ }
    }, 500);
  }

  private stopSessionFilePoll() {
    if (this.sessionFilePoll) {
      clearInterval(this.sessionFilePoll);
      this.sessionFilePoll = null;
    }
  }
}

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
