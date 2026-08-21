import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { autodetectClaudePath } from "../settings-autodetect";

export type RemoteStatus = "starting" | "waiting" | "ready" | "exited" | "error";

export type RemoteControlOptions = {
  cwd: string;
  sessionName?: string;
  claudePath?: string;
  /* Optional handle to the SubprocessManager so the session-file poll can
     coordinate "claimed" JSONL paths across parallel RC spawns. When
     omitted, the poll falls back to plain mtime ranking. */
  claimedSessionFiles?: {
    claim(path: string): boolean;
    isClaimed(path: string): boolean;
  };
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

/* The pairing URL the CLI prints. Single-session mode emits the
   `/code/session_<id>` form; the multi-session server emits the
   `/code?environment=env_<id>` form. We spawn single-session mode below, but
   match both so a future CLI spawn-mode change can't silently break pairing. */
const URL_PATTERN = /https:\/\/claude\.ai\/code(?:\/session_[A-Za-z0-9]+|\?environment=env_[A-Za-z0-9]+)/;
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
# Forward-declare pid so the signal handler can reference it before the
# pty.fork() returns. Installing the handlers BEFORE the fork means a
# SIGTERM arriving between fork() and the handler installation can't kill
# the parent without forwarding to the child.
pid = -1
def _term(signum, frame):
    if pid > 0:
        try: os.kill(pid, signal.SIGTERM)
        except OSError: pass
signal.signal(signal.SIGTERM, _term)
signal.signal(signal.SIGHUP, _term)
pid, fd = pty.fork()
if pid == 0:
    # Child: exec the target command. Wrap in try/except so an ENOENT or
    # permission error writes a clean diagnostic to stderr and exits with
    # 127 (shell-convention "command not found") instead of dumping a
    # Python traceback onto the controlling tty.
    try:
        os.execvp(cmd[0], cmd)
    except Exception as e:
        try: os.write(2, ("pty_proxy: failed to exec %s: %s\\n" % (cmd[0], e)).encode())
        except Exception: pass
        os._exit(127)
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

/* Wraps the `claude remote-control` server subcommand in a PTY (the inline
   Python pty.fork() proxy above). The CLI emits an ANSI-laden interactive UI;
   we strip it, auto-confirm the first-launch trust prompt, and watch for the
   pairing URL.

   Why the subcommand and not the `--remote-control` flag: the interactive
   `claude --remote-control` flag ENABLES remote control but never PRINTS a
   pairing URL to the terminal (it only shows "Remote Control active"), so the
   URL scrape could never fire and the card hung on "Waiting for pairing"
   forever. The `remote-control` subcommand in single-session mode
   (`--spawn=session`, "exits when the session ends") prints the
   `https://claude.ai/code/session_<id>` URL directly. Trade-off: the
   subcommand does NOT accept `--resume`, so it starts a fresh remote session
   rather than carrying over an existing local conversation.

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
  /* 60s budget for the CLI to print its pairing URL. If it never appears,
     surface an error and dispose. Cleared when the URL is captured. */
  private urlTimeout: ReturnType<typeof setTimeout> | null = null;
  /* True only when the child's 'error' event fired (spawn failure — no
     process to kill, no 'exit' event ever). Status "error" alone can't
     distinguish that from the URL-discovery timeout, where the child is
     alive and MUST still be SIGTERMed by dispose(). */
  private spawnFailed = false;
  /* Session id parsed from the CLI's stdout (welcome banner), if it prints
     one. Used to disambiguate the session file under parallel spawns. */
  private discoveredSessionId: string | null = null;
  private claimedSessionFiles?: RemoteControlOptions["claimedSessionFiles"];
  /* Cap on stdoutBuffer once the URL is captured: anything past this point
     is only useful for debugging. Keeping the buffer unbounded would leak
     memory for long-running RC sessions. */
  private static readonly STDOUT_BUFFER_CAP = 64 * 1024;

  constructor(opts: RemoteControlOptions) {
    this.cwd = opts.cwd;
    this.spawnTime = Date.now();
    this.claimedSessionFiles = opts.claimedSessionFiles;

    const claude = opts.claudePath || autodetectClaudePath() || "claude";
    /* `remote-control` is a subcommand (no leading dashes). `--spawn=session`
       selects classic single-session mode, which also skips the interactive
       "[1/2] spawn mode" prompt the default multi-session server shows on
       first run. The session name is passed via `--name` (the subcommand
       rejects a bare positional name). */
    const pyArgs = ["-c", PTY_PROXY_SCRIPT, claude, "remote-control", "--spawn=session"];
    if (opts.sessionName) pyArgs.push("--name", opts.sessionName);

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
    /* Absorb async stream errors on all three stdio pipes. EIO/EPIPE after
       the PTY proxy dies abnormally (or a concurrent dispose tears the
       streams down mid-callback) emits 'error' on the stream object itself.
       The process-level 'error' handler below only covers spawn failures,
       and an unhandled stream 'error' crashes the renderer. stdin matters
       most: the trust-prompt auto-confirm write below has no per-write
       callback chain like InputWriter's. */
    this.child.stdin.on("error", err => console.warn(`[claude-cli-chat] RC stdin error:`, err));
    this.child.stdout.on("error", err => console.warn(`[claude-cli-chat] RC stdout error:`, err));
    this.child.stderr.on("error", err => console.warn(`[claude-cli-chat] RC stderr error:`, err));

    this.child.on("error", err => {
      console.error(`[claude-cli-chat] RC error:`, err);
      this.spawnFailed = true;
      this.setStatus("error");
      /* A spawn failure emits 'error' and never 'exit', so the exit-path
         teardown never runs here. Mirror it: stop the session-file poll and
         clear the URL timeout so neither keeps firing on a dead session. */
      this.stopSessionFilePoll();
      this.clearUrlTimeout();
      for (const cb of this.errorListeners) cb(err);
    });

    this.child.on("exit", code => {
      console.log(`[claude-cli-chat] RC exit code=${code}`);
      this.setStatus("exited");
      this.stopSessionFilePoll();
      this.clearUrlTimeout();
      for (const cb of this.exitListeners) cb(code);
    });

    /* URL discovery deadline. If the CLI hasn't printed a pairing URL in
       60s something is wrong (hung trust prompt, missing network, CLI
       version that uses a different welcome format). Surface an error and
       dispose so the UI can fall back gracefully instead of spinning
       forever. */
    this.urlTimeout = setTimeout(() => {
      if (this.url) return;
      const err = new Error(
        `RemoteControlSession: timed out waiting for pairing URL after 60s. ` +
        `Last stdout (${this.stdoutBuffer.length} bytes): ${this.stdoutBuffer.slice(-400)}`,
      );
      console.error(`[claude-cli-chat] RC url-discovery timeout`);
      this.setStatus("error");
      for (const cb of this.errorListeners) cb(err);
      void this.dispose();
    }, 60000);

    /* The server subcommand creates its own fresh session, so we can't know
       the JSONL path upfront — poll the project dir for the newest file
       appearing post-spawn. */
    this.startSessionFilePoll();
  }

  onUrl(cb: UrlListener) { this.urlListeners.push(cb); }
  onStatus(cb: StatusListener) { this.statusListeners.push(cb); }
  onSessionFile(cb: SessionFileListener) { this.sessionFileListeners.push(cb); }
  onError(cb: ErrorListener) { this.errorListeners.push(cb); }
  onExit(cb: ExitListener) { this.exitListeners.push(cb); }

  async dispose(): Promise<void> {
    this.stopSessionFilePoll();
    this.clearUrlTimeout();
    if (this.status === "exited") return;
    /* spawnFailed means the proxy never spawned (e.g. python3 missing) — no
       'exit' event will ever fire, so waiting on it would burn the full
       1.5s timeout per dead session (multiplied on plugin unload's
       killAll). Same guard for a child that already exited before the
       status flip landed. Status "error" alone is NOT sufficient here:
       the URL-discovery timeout sets it while the child is still alive,
       and that child must be killed or it leaks a live remote session. */
    if (this.spawnFailed || this.child.exitCode !== null || this.child.signalCode !== null) return;
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        try { this.child.kill("SIGKILL"); } catch { /* ignore */ }
        resolve();
      }, 1500);
      this.child.once("exit", () => { clearTimeout(timeout); resolve(); });
      try { this.child.kill("SIGTERM"); } catch { /* ignore */ }
    });
  }

  private clearUrlTimeout() {
    if (this.urlTimeout) {
      clearTimeout(this.urlTimeout);
      this.urlTimeout = null;
    }
  }

  private handleStdout(chunk: string) {
    /* Once we have the URL and have captured any session-id banner, the
       buffer's only use is debugging the URL-timeout error. Cap it with
       FIFO truncation so a long-running RC session can't leak memory. */
    if (this.url) {
      this.stdoutBuffer += stripAnsi(chunk);
      if (this.stdoutBuffer.length > RemoteControlSession.STDOUT_BUFFER_CAP) {
        this.stdoutBuffer = this.stdoutBuffer.slice(-RemoteControlSession.STDOUT_BUFFER_CAP);
      }
      /* Still try to capture a session id if it appears post-URL. */
      this.tryCaptureSessionId();
      return;
    }

    this.stdoutBuffer += stripAnsi(chunk);

    /* Auto-confirm trust prompt by sending Enter. The CLI pre-selects "Yes,
       I trust this folder" so a bare newline accepts. Only fires once. */
    if (!this.trustConfirmed && TRUST_PROMPT_PATTERN.test(this.stdoutBuffer)) {
      this.trustConfirmed = true;
      console.log(`[claude-cli-chat] RC auto-confirming trust prompt`);
      /* A bare try/catch can't intercept the ASYNC 'error' a broken pipe
         emits (proxy exited between the stdout chunk and this handler
         running). Guard on writability and hand write() a callback so the
         failure is delivered there (and to the stdin 'error' listener)
         instead of as an uncaught exception. */
      if (this.child.stdin.writable) {
        this.child.stdin.write("\r", () => { /* errors land in the stdin 'error' handler */ });
      }
    }

    this.tryCaptureSessionId();

    const match = this.stdoutBuffer.match(URL_PATTERN);
    if (match) {
      this.url = match[0];
      this.setStatus("ready");
      this.clearUrlTimeout();
      console.log(`[claude-cli-chat] RC paired url=${this.url}`);
      for (const cb of this.urlListeners) cb(this.url);
    } else if (
      this.status === "starting" &&
      /remote control|connecting|single session|spawn mode|launching|mobile app/i.test(this.stdoutBuffer)
    ) {
      this.setStatus("waiting");
    }
  }

  /* The CLI welcome banner sometimes prints a line like "Session: <uuid>"
     or "session_id: <uuid>". When present, this is the most reliable way
     to map the spawn to its JSONL file under parallel-spawn races. We try
     several known formats; if none match the poll falls back to mtime. */
  private tryCaptureSessionId() {
    if (this.discoveredSessionId) return;
    const patterns = [
      /(?:^|\s)Session(?:\s*ID)?:\s*([a-f0-9-]{8,})/im,
      /session_id["':\s]+([a-f0-9-]{8,})/im,
    ];
    for (const p of patterns) {
      const m = this.stdoutBuffer.match(p);
      if (m) {
        this.discoveredSessionId = m[1];
        console.log(`[claude-cli-chat] RC discovered sessionId from stdout: ${m[1]}`);
        return;
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
       discovery.

       Disambiguation strategy under parallel RC spawns:
         1. If we've parsed a session id out of the CLI's stdout banner,
            trust that and look up the file directly. Most reliable.
         2. Otherwise fall back to mtime ranking, but:
            (a) tighten the spawn-time window to +/-300ms so we don't
                accidentally grab a file the OTHER session just created.
            (b) prefer files NOT already claimed by another instance via
                the SubprocessManager-level claimed registry. */
    const SPAWN_WINDOW_MS = 300;
    let attempts = 0;
    this.sessionFilePoll = setInterval(() => {
      attempts++;
      if (attempts > 60 || this.sessionFile) {
        this.stopSessionFilePoll();
        return;
      }

      /* Path 1: direct lookup if we parsed a session id from stdout. */
      if (this.discoveredSessionId) {
        const candidate = sessionFilePathFor(this.cwd, this.discoveredSessionId);
        if (existsSync(candidate)) {
          this.adoptSessionFile(candidate);
          return;
        }
      }

      if (!existsSync(dir)) return;
      try {
        const files = readdirSync(dir).filter(f => f.endsWith(".jsonl"));
        let newest: { path: string; created: number } | null = null;
        let newestUnclaimed: { path: string; created: number } | null = null;
        for (const file of files) {
          const fullPath = join(dir, file);
          try {
            const st = statSync(fullPath);
            /* Window on BIRTHTIME, not mtime: a pre-existing session file
               that another local tab is actively appending to has
               mtime ≈ now on every tick, so an mtime window would adopt
               that tab's conversation and permanently mirror the wrong
               chat. Creation time pins the check to files that actually
               appeared post-spawn (macOS/APFS birthtime is real). */
            const created = st.birthtimeMs;
            if (created < this.spawnTime - SPAWN_WINDOW_MS) continue;
            if (created > this.spawnTime + 30000) continue;
            /* Title-gen subprocesses run in the same cwd and leave fresh
               one-line ai-title JSONLs inside our window; adopting one
               leaves the remote tab dark forever. */
            if (isAiTitleResidue(fullPath)) continue;
            if (!newest || created > newest.created) newest = { path: fullPath, created };
            const claimed = this.claimedSessionFiles?.isClaimed(fullPath) ?? false;
            if (!claimed && (!newestUnclaimed || created > newestUnclaimed.created)) {
              newestUnclaimed = { path: fullPath, created };
            }
          } catch { /* ignore */ }
        }
        /* Prefer the newest UNCLAIMED file; only fall back to claimed if
           nothing else fits the window. */
        const pick = newestUnclaimed ?? newest;
        if (pick) {
          this.adoptSessionFile(pick.path);
        }
      } catch { /* ignore */ }
    }, 500);
  }

  /* Common claim-and-notify path for both discovery routes. */
  private adoptSessionFile(path: string) {
    if (this.claimedSessionFiles) {
      const ok = this.claimedSessionFiles.claim(path);
      /* If another instance has already claimed this exact path, skip
         silently and let the poll keep trying. */
      if (!ok) return;
    }
    this.sessionFile = path;
    this.stopSessionFilePoll();
    console.log(`[claude-cli-chat] RC session file detected: ${path}`);
    for (const cb of this.sessionFileListeners) cb(path);
  }

  private stopSessionFilePoll() {
    if (this.sessionFilePoll) {
      clearInterval(this.sessionFilePoll);
      this.sessionFilePoll = null;
    }
  }
}

/* Sniffs the head of a candidate JSONL for an `ai-title` record. Title-gen
   and incognito spawns leave one-line residue files (wire-format gotcha #6)
   whose only record is the title; a real RC session file starts with real
   records. Bounded read (4KB) so an already-large file costs nothing. */
function isAiTitleResidue(path: string): boolean {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, buf.length, 0);
      if (n <= 0) return false;
      const firstLine = buf.toString("utf8", 0, n).split("\n", 1)[0];
      return firstLine.includes('"ai-title"');
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
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
