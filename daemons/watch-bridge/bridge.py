#!/usr/bin/env python3
"""Apple Watch -> Claude Code vault chat bridge.

Keeps one INTERACTIVE `claude` session (no --print, so usage bills against
the Max subscription caps) alive inside a PTY, cwd'd to the Second Brain
vault, and exposes it over a small bearer-authed HTTP API for an Apple Watch
Shortcut to call over Tailscale.

Reply content never comes from the PTY: the session's JSONL transcript under
~/.claude/projects/<slug>/ is the source of truth, and end-of-turn is signaled
by a Stop hook (stop_hook.py, injected via --settings) touching
/tmp/watch-bridge/stop_signal.json. PTY output is only used for the trust
prompt, banner session-id capture, and liveness.

API (all routes require `Authorization: Bearer <token>`):
  POST /chat   {"message": str} -> 200 {reply, session_id, elapsed_ms, partial:false}
                                   202 {..., partial:true} if the reply budget expires
                                   409 turn in flight / 503 not ready
  GET  /last   -> last completed reply (same shape as 200)
  GET  /wait?since=<unix_ts>&timeout=<s> -> long-poll: blocks until a turn
                 completes at/after `since` (bridge clock), then returns it
                 (same shape as /last). 202 {partial:true} on timeout. Used by
                 the watch app's background URLSession to fire a local
                 notification when a turn finishes after the app is closed.
  GET  /suggest?after_seq=N&timeout=<s> -> long-poll for the suggested next
                 user message generated after each completed turn. Blocks (default
                 25s, clamp 1..60) until a suggestion exists whose turn_seq > N,
                 then 200 {suggestion: str|null, turn_seq: int}; 202
                 {suggestion: null, turn_seq: <current>, error: "wait_timeout"} on
                 timeout. /last and /wait also carry "suggestion" when one for the
                 same turn_seq is already ready, so the watch can skip a round trip.
  POST /command {"command": str} -> 200 {ok}. Fire-and-forget slash command
                 (allowlist: /model, /effort). These run locally in the CLI
                 and produce no assistant turn, so they bypass the turn
                 machinery entirely. Sticky: replayed after respawns.
  POST /reset  -> kill + respawn the claude child (fresh session)
  GET  /health -> {state, session_id, session_file, child_pid, uptime_s}
  GET  /sessions -> {sessions: [{id, kind, name, cwd, attach, pid,
                 last_activity, preview}]}. Only explicitly activated Remote
                 Control sessions (`claude remote-control --spawn=session`),
                 each mapped to its JSONL transcript via the authoritative
                 ~/.claude/sessions/<pid>.json index (birthtime heuristic only
                 as a fallback for sessions that predate it). Plain terminal claude
                 sessions, the plugin's `claude --print` chat subprocesses, and
                 the bridge's own child are all excluded. attach:
                 "tmux:<target>" (injectable via send-keys, e.g. vault-cc) or
                 null (view-only).
  GET  /sessions/<id>/messages?limit=N -> {session, messages: [{uuid, role,
                 text, ts}]}. Tail of the transcript, text turns only.
  POST /sessions/<id>/send {"message": str} -> 200 {ok}. Fire-and-forget
                 inject; poll messages for the reply. 409 view_only if the
                 session has no input route.
  GET  /usage  -> Anthropic OAuth usage buckets (five_hour, seven_day,
                 seven_day_sonnet, seven_day_omelette, ...), proxied with the
                 ClaudeUsageBar credentials file and cached 60s.

Config (env):
  WATCH_BRIDGE_PORT            default 8787
  WATCH_BRIDGE_BIND            default: auto-resolve Tailscale IPv4 (retries 60s)
  WATCH_BRIDGE_VAULT           REQUIRED: directory the claude session runs in
  WATCH_BRIDGE_CLAUDE          default: `claude` resolved from an enriched PATH
  WATCH_BRIDGE_REPLY_BUDGET_S  default 90
  WATCH_BRIDGE_SUGGEST         "0" disables next-message suggestions (default on)
  Token file: ~/.config/watch-bridge/token (chmod 600)

Trust model: the child claude runs with --dangerously-skip-permissions, so
every tool call it makes executes without interactive approval. The bearer
token is therefore the ONLY thing standing between a tailnet peer and
unprompted command execution on this machine. Guard the token file like an
SSH key, keep the tailnet ACLs tight, and never bind beyond the Tailscale
interface.

State changes mirror to /tmp/claude_state (same token format as the plugin's
StateEmitter) so the TC001 animator reflects watch activity for free.
"""
import calendar
import fcntl
import hmac
import json
import os
import pty
import re
import select
import shutil
import signal
import socket
import struct
import subprocess
import sys
import termios
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ---------------------------------------------------------------- config

HOME = os.path.expanduser("~")
TOKEN_PATH = HOME + "/.config/watch-bridge/token"
SIGNAL_PATH = "/tmp/watch-bridge/stop_signal.json"
STATE_TOKEN_PATH = "/tmp/claude_state"
STOP_HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stop_hook.py")
TAILSCALE_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"

PORT = int(os.environ.get("WATCH_BRIDGE_PORT", "8787"))
BIND = os.environ.get("WATCH_BRIDGE_BIND", "")
VAULT = os.environ.get("WATCH_BRIDGE_VAULT", "")
REPLY_BUDGET_S = float(os.environ.get("WATCH_BRIDGE_REPLY_BUDGET_S", "90"))
IDLE_FALLBACK_S = 15.0
JSONL_AUTO_RESET_BYTES = 4 * 1024 * 1024
SETTLE_S = 3.0

SUGGEST_ENABLED = os.environ.get("WATCH_BRIDGE_SUGGEST", "1") != "0"
SUGGEST_MODEL = "claude-haiku-4-5-20251001"
SUGGEST_TIMEOUT_S = 20
SUGGEST_MAX_OUTPUT_CHARS = 600

APPEND_SYSTEM_PROMPT = (
    "Replies are spoken aloud on a watch. "
    "Default to under 80 words unless asked for detail."
)

ANSI_RES = [
    re.compile(r"\x1b\[[0-9;?]*[A-Za-z]"),
    re.compile(r"\x1b\][^\x07]*\x07"),
    re.compile(r"\x1b[()][AB012]"),
]
SESSION_ID_RES = [
    re.compile(r"(?:^|\s)Session(?:\s*ID)?:\s*([a-f0-9-]{8,})", re.I | re.M),
    re.compile(r"session_id[\"':\s]+([a-f0-9-]{8,})", re.I | re.M),
]
# The TUI positions text with cursor-movement sequences, so ANSI-stripped
# output often loses the spaces between words; match space-agnostically.
TRUST_PROMPT_RE = re.compile(r"trust\s*this\s*folder", re.I)
BYPASS_PROMPT_RE = re.compile(r"Bypass\s*Permissions\s*mode", re.I)
# Switching model OR effort mid-conversation prompts a confirmation, because
# the cached history must be re-read ("...the full history gets re-read on
# your next message. 1. Yes, switch to X / 2. No, go back"). Auto-accept
# option 1. The cached-history warning is the shared, reliable marker.
SWITCH_PROMPT_RE = re.compile(r"history\s*gets?\s*re-?read", re.I)
SWITCH_ACCEPT_RE = re.compile(r"1\.\s*Yes", re.I)


def log(msg):
    print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}", flush=True)


def strip_ansi(s):
    for r in ANSI_RES:
        s = r.sub("", s)
    return s.replace("\r", "")


def enriched_path():
    extra = [HOME + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
    cur = os.environ.get("PATH", "").split(":")
    return ":".join(extra + [p for p in cur if p and p not in extra])


def resolve_claude():
    explicit = os.environ.get("WATCH_BRIDGE_CLAUDE")
    if explicit:
        return explicit
    found = shutil.which("claude", path=enriched_path())
    if not found:
        log("FATAL: claude binary not found on enriched PATH")
        sys.exit(1)
    return found


def read_token():
    try:
        with open(TOKEN_PATH) as f:
            tok = f.read().strip()
        if not tok:
            raise ValueError("empty")
        return tok
    except Exception as e:
        log(f"FATAL: cannot read bearer token at {TOKEN_PATH}: {e}")
        log("Create it with: mkdir -p ~/.config/watch-bridge && "
            "openssl rand -hex 24 > ~/.config/watch-bridge/token && "
            "chmod 600 ~/.config/watch-bridge/token")
        sys.exit(1)


TAILNET_IP_RE = re.compile(
    r"^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$"
)  # CGNAT 100.64.0.0/10, the Tailscale address range


def _tailnet_ip_from_interfaces():
    """The Tailscale CLI can't reach the GUI from a launchd session (CLIError 3
    on stdout with exit 0), so parse the utun interface address instead."""
    try:
        out = subprocess.run(["/sbin/ifconfig"], capture_output=True, text=True, timeout=5)
        for m in re.finditer(r"inet (100\.\d+\.\d+\.\d+)", out.stdout):
            if TAILNET_IP_RE.match(m.group(1)):
                return m.group(1)
    except Exception:
        pass
    return None


def resolve_bind():
    if BIND:
        return BIND
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            out = subprocess.run(
                [TAILSCALE_CLI, "ip", "-4"], capture_output=True, text=True, timeout=5
            )
            ip = out.stdout.strip().splitlines()[0].strip() if out.stdout.strip() else ""
            if out.returncode == 0 and TAILNET_IP_RE.match(ip):
                return ip
        except Exception:
            pass
        ip = _tailnet_ip_from_interfaces()
        if ip:
            return ip
        time.sleep(2)
    log("FATAL: could not resolve Tailscale IPv4 after 60s (is Tailscale running?). "
        "Set WATCH_BRIDGE_BIND to override.")
    sys.exit(1)


def session_index_for(pid):
    """Authoritative pid -> session metadata from ~/.claude/sessions/<pid>.json,
    written by claude >= 2.1.178 for every live session. Returns the parsed
    dict only when it describes this pid (guards a stale file from a reused
    pid); None when absent."""
    try:
        with open(f"{HOME}/.claude/sessions/{pid}.json") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return None
    return data if data.get("pid") == pid else None


def project_dir_for(cwd):
    slug = re.sub(r"[^a-zA-Z0-9]", "-", cwd)
    return f"{HOME}/.claude/projects/{slug}"


def emit_state(state):
    """Token-file half of the plugin's StateEmitter; the animator daemon
    owns the TC001 device and the complete->ready->idle walk."""
    try:
        with open(STATE_TOKEN_PATH, "w") as f:
            f.write(f"{int(time.time())} {state}\n")
    except OSError:
        pass


# ---------------------------------------------------------------- claude session


class ClaudeSession:
    """Owns one interactive claude child in a PTY."""

    def __init__(self, claude_path):
        self.claude_path = claude_path
        self.lock = threading.Lock()
        # Serializes the whole paste+settle+CR write sequence in send() (and
        # the CR write in nudge_submit()) so two writers can never interleave
        # their bytes into the composer. self.lock only ever guards short
        # metadata snapshots and must stay separate from this.
        self.write_lock = threading.Lock()
        self.pid = -1
        self.fd = -1
        self.spawn_epoch = 0.0
        self.session_id = None
        self.session_file = None
        self.alive = False
        self.stdout_tail = ""  # rolling ANSI-stripped buffer, liveness/debug only
        self.first_send_epoch = None
        self._trust_confirmed = False
        self._bypass_confirmed = False
        self._switch_accept_epoch = 0.0  # debounce model-switch dialog redraws
        self._gen = 0  # respawn generation, lets stale reader threads exit

    def spawn(self):
        with self.lock:
            self._gen += 1
            gen = self._gen
            self.session_id = None
            self.session_file = None
            self.stdout_tail = ""
            self.first_send_epoch = None
            self._trust_confirmed = False
            self._bypass_confirmed = False
            self.spawn_epoch = time.time()

            settings = json.dumps({
                "hooks": {"Stop": [{"hooks": [
                    {"type": "command", "command": f"{sys.executable} {STOP_HOOK}"}
                ]}]}
            })
            argv = [
                self.claude_path,
                "--dangerously-skip-permissions",
                "--settings", settings,
                "--append-system-prompt", APPEND_SYSTEM_PROMPT,
            ]
            pid, fd = pty.fork()
            if pid == 0:
                try:
                    os.chdir(VAULT)
                    os.environ["TERM"] = "xterm-256color"
                    os.environ["PATH"] = enriched_path()
                    os.environ["CLAUDE_CODE_ENTRYPOINT"] = "watch-bridge"
                    os.execvp(argv[0], argv)
                except Exception as e:
                    try:
                        os.write(2, f"watch-bridge: exec failed: {e}\n".encode())
                    except OSError:
                        pass
                    os._exit(127)
            self.pid = pid
            self.fd = fd
            self.alive = True
            try:
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
            except OSError:
                pass
            fcntl.fcntl(fd, fcntl.F_SETFL, os.O_NONBLOCK)
            log(f"spawned claude pid={pid} cwd={VAULT}")
        threading.Thread(target=self._reader, args=(gen, fd, pid), daemon=True).start()
        threading.Thread(target=self._discover_session_file, args=(gen,), daemon=True).start()

    def _reader(self, gen, fd, pid):
        """Drain PTY output: trust-prompt confirm, banner session-id capture,
        child-exit detection. Output is never parsed for reply content."""
        while True:
            if gen != self._gen:
                break  # stale reader: fall through to unconditional cleanup
            try:
                # select() returns as soon as data is available regardless of
                # this timeout, so PTY-output responsiveness is unaffected;
                # only the idle waitpid/gen-staleness poll cadence slows,
                # which the exit path already tolerates (the 5s reap loop
                # below).
                rlist, _, _ = select.select([fd], [], [], 1.0)
            except (OSError, ValueError):
                break
            if fd in rlist:
                try:
                    data = os.read(fd, 4096)
                    if not data:
                        break
                    self._handle_output(data.decode("utf-8", "replace"), fd)
                except BlockingIOError:
                    pass
                except OSError:
                    break
            try:
                done, _ = os.waitpid(pid, os.WNOHANG)
                if done:
                    break
            except ChildProcessError:
                break
        # Only the shared-state mutation + log are gen-guarded; a stale reader
        # must not clear self.alive (the new child is the live one).
        if gen == self._gen:
            self.alive = False
            log(f"claude child pid={pid} exited")
        # Always close THIS reader's own fd and reap THIS reader's own child,
        # regardless of generation: a slow-dying child reaches EOF here after a
        # respawn has already bumped self._gen, so a gen-gated close/reap would
        # leak the old PTY master fd and leave a zombie.
        # Invalidate the shared handle first (only if it still points at what
        # we're closing — a respawn may already have overwritten it with a
        # new fd/pid, in which case leave those alone). Without this, a
        # number the kernel later reuses for an unrelated HTTP client socket
        # can silently receive a write meant for the PTY.
        with self.lock:
            if self.fd == fd:
                self.fd = -1
            if self.pid == pid:
                self.pid = -1
        try:
            os.close(fd)
        except OSError:
            pass
        for _ in range(50):  # ~5s: PTY EOF can precede the child being reapable
            try:
                done, _ = os.waitpid(pid, os.WNOHANG)
                if done:
                    break
            except ChildProcessError:
                break
            time.sleep(0.1)

    def _handle_output(self, chunk, fd):
        # Append unconditionally and only truncate once a high-water mark is
        # crossed, instead of reslicing a ~64KB string on every 4KB chunk.
        # Same steady-state cap (65536), amortized instead of per-chunk.
        self.stdout_tail += strip_ansi(chunk)
        if len(self.stdout_tail) > 98304:
            self.stdout_tail = self.stdout_tail[-65536:]
        if not self._bypass_confirmed and BYPASS_PROMPT_RE.search(self.stdout_tail):
            # the dialog defaults to "1. No, exit"; select "2. Yes, I accept"
            self._bypass_confirmed = True
            log("accepting bypass-permissions dialog")
            try:
                os.write(fd, b"2")
                time.sleep(0.15)
                os.write(fd, b"\r")
            except OSError:
                pass
        # The dialog clears as soon as we answer, but the screen redraws a few
        # times while it's up; debounce so we send a single "1" per dialog.
        if (SWITCH_PROMPT_RE.search(self.stdout_tail[-1500:])
                and SWITCH_ACCEPT_RE.search(self.stdout_tail[-1500:])
                and time.time() - self._switch_accept_epoch > 3):
            self._switch_accept_epoch = time.time()
            log("auto-accepting model-switch confirmation")
            try:
                os.write(fd, b"1")
                time.sleep(0.15)
                os.write(fd, b"\r")
            except OSError:
                pass
            # Consume the matched text: without this, the "history gets
            # re-read" / "1. Yes" markers can survive well past the 3s
            # debounce inside the rolling 1500-char window (ANSI-stripped
            # repaints add only a few hundred visible chars), so the next
            # spinner frame or status tick re-satisfies the condition and
            # writes a stray "1"+CR into what is now an empty composer.
            self.stdout_tail = ""
        if not self._trust_confirmed and TRUST_PROMPT_RE.search(self.stdout_tail):
            self._trust_confirmed = True
            log("auto-confirming trust prompt")
            try:
                os.write(fd, b"\r")
            except OSError:
                pass
        if not self.session_id:
            for r in SESSION_ID_RES:
                m = r.search(self.stdout_tail)
                if m:
                    self.session_id = m.group(1)
                    log(f"session id from banner: {self.session_id}")
                    break

    def _discover_session_file(self, gen):
        """Direct lookup by banner session id first; else mtime-ranked newest
        *.jsonl in the project slug dir. An idle interactive claude creates NO
        session file until the first user message, so this loop runs until the
        first send happens and a file appears (or the session is respawned).
        The mtime lower bound is keyed to the first send to avoid adopting a
        concurrent plugin session's file in the same project slug."""
        proj = project_dir_for(VAULT)
        while gen == self._gen:
            # Prefer the CLI's own pid -> sessionId index over any guessing.
            # Without it, the birthtime fallback below adopted a concurrent
            # plugin/desktop transcript in the same project slug (seen live
            # 2026-08-20: /health pointed at a 20-day-old plugin chat).
            if not self.session_id and self.pid > 0:
                idx = session_index_for(self.pid)
                sid = idx.get("sessionId") if idx else None
                if sid:
                    self.session_id = sid
                    log(f"session id from ~/.claude/sessions/{self.pid}.json: {sid}")
            if self.session_id:
                candidate = os.path.join(proj, f"{self.session_id}.jsonl")
                if os.path.exists(candidate):
                    self._adopt(candidate)
                    return
                # Known id, file not written yet (idle session): keep waiting
                # rather than falling through to the heuristic.
                time.sleep(0.5)
                continue
            floor = (
                self.first_send_epoch - 0.5
                if self.first_send_epoch is not None
                else self.spawn_epoch - 0.3
            )
            try:
                best = None
                for name in os.listdir(proj):
                    if not name.endswith(".jsonl"):
                        continue
                    full = os.path.join(proj, name)
                    st = os.stat(full)
                    # Creation time, not mtime: a dying previous child writes
                    # a closing record to ITS file right as the new one
                    # spawns, which put an old file inside the mtime window
                    # and hijacked reply extraction for the whole session.
                    birth = getattr(st, "st_birthtime", st.st_mtime)
                    if birth < floor:
                        continue
                    if best is None or birth > best[1]:
                        best = (full, birth)
                if best:
                    if not self.session_id:
                        log("session file via mtime fallback (no banner id)")
                    self._adopt(best[0])
                    return
            except OSError:
                pass
            time.sleep(0.5)

    def _adopt(self, path):
        self.session_file = path
        if not self.session_id:
            self.session_id = os.path.basename(path)[:-len(".jsonl")]
        log(f"session file: {path}")

    def ready(self):
        # No session-file requirement: the file only exists after the first
        # message is sent into the session.
        return self.alive and time.time() - self.spawn_epoch > SETTLE_S

    def current_gen(self):
        """Snapshot the current spawn generation under the lock. Callers that
        schedule a DEFERRED write (e.g. the /command submit-nudge timer) capture
        this and pass it to nudge_submit() so a respawn in the meantime turns
        the write into a no-op instead of injecting bytes into a different
        child's startup TUI."""
        with self.lock:
            return self._gen

    def send(self, text):
        """Bracketed paste so dictated newlines don't submit early, settle,
        then CR to submit."""
        if not self.ready():
            raise RuntimeError("session not ready")
        if self.first_send_epoch is None:
            self.first_send_epoch = time.time()
        # Snapshot fd+generation together under the lock (respawn() swaps
        # self.fd under this same lock). Re-check the generation before the
        # submit CR so a respawn during the 0.2s settle can't land the CR in a
        # freshly spawned child and inject a stray submit into its startup TUI.
        with self.lock:
            fd, gen = self.fd, self._gen
        # Hold write_lock across the whole paste+settle+CR sequence: without
        # it, a concurrent writer (another /chat, a /command, a sticky
        # replay) can interleave its own paste between this paste and this
        # CR, and the single CR then submits the concatenation as one turn.
        with self.write_lock:
            os.write(fd, b"\x1b[200~" + text.encode() + b"\x1b[201~")
            time.sleep(0.2)
            with self.lock:
                if self._gen != gen:
                    return  # respawned mid-send; don't submit into the new child
            os.write(fd, b"\r")

    def nudge_submit(self, expected_gen=None):
        """Extra CR a moment after a send: a TUI mid-redraw can eat the
        submit CR, leaving the text sitting in the composer (where the NEXT
        send would concatenate onto it). If the original CR landed this is an
        empty-composer no-op; if it was eaten, this submits the command.

        expected_gen guards a DEFERRED nudge (the /command timer fires 0.8s
        later, outside any turn lock): if a respawn swapped the child in the
        meantime, skip the write so the CR can't inject into the new child."""
        with self.lock:
            fd, gen = self.fd, self._gen
        if expected_gen is not None and gen != expected_gen:
            return
        with self.write_lock:
            try:
                os.write(fd, b"\r")
            except OSError:
                pass

    def respawn(self):
        with self.lock:
            pid = self.pid
            old_fd = self.fd  # capture so cleanup doesn't race the stale reader
            if self.alive and pid > 0:
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass
        deadline = time.time() + 1.5
        while time.time() < deadline and self.alive:
            time.sleep(0.05)
        if self.alive and pid > 0:
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
            time.sleep(0.2)
        self.spawn()
        # Defense-in-depth: free the old child's fd + reap it even if its reader
        # thread is wedged. spawn() returns a fresh fd (different int), so guard
        # against double-closing the new fd before touching the old one.
        if old_fd >= 0 and old_fd != self.fd:
            try:
                os.close(old_fd)
            except OSError:
                pass
        if pid > 0:
            try:
                os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                pass


# ---------------------------------------------------------------- transcript tailer


class TranscriptTailer:
    """Polls the session JSONL (250ms), incremental byte-offset reads with
    truncation reset and partial-line stitching. Keeps assistant text records
    plus a last-activity clock; tool records only bump the clock."""

    def __init__(self, session):
        self.session = session
        self.lock = threading.Lock()
        self._reset("")
        threading.Thread(target=self._loop, daemon=True).start()

    def _reset(self, path):
        self.path = path
        self.offset = 0
        self.partial = ""
        self.seen_uuids = set()
        self.records = []  # (index, kind, text) kind: "assistant_text"|"other"
        self.last_activity = 0.0

    def _loop(self):
        while True:
            try:
                path = self.session.session_file
                with self.lock:
                    if path != self.path:
                        self._reset(path or "")
                if path:
                    self._read_new(path)
            except OSError:
                pass
            except Exception as e:
                # A malformed record (e.g. a JSONL line that parses but isn't
                # an object) must not kill this thread permanently: nothing
                # supervises or restarts it, and every subsequent turn would
                # see a frozen tailer, burn the 45s never-landed abort, and
                # return an empty reply.
                log(f"tailer: unexpected error, continuing: {e}")
            time.sleep(0.25)

    def _read_new(self, path):
        size = os.stat(path).st_size
        with self.lock:
            if size < self.offset:
                old = self.path
                self._reset(old)
            if size == self.offset:
                return
            with open(path, "rb") as f:
                f.seek(self.offset)
                data = f.read(size - self.offset)
            self.offset = size
            buf = self.partial + data.decode("utf-8", "replace")
            lines = buf.split("\n")
            self.partial = lines.pop()
            for line in lines:
                self._handle_line(line)

    def _handle_line(self, line):
        line = line.strip()
        if not line:
            return
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            return
        if not isinstance(rec, dict):
            return  # valid JSON but not an object (e.g. a truncated/racy write)
        uuid = rec.get("uuid")
        if isinstance(uuid, str):
            if uuid in self.seen_uuids:
                return
            self.seen_uuids.add(uuid)
        self.last_activity = time.time()
        kind, text = "other", ""
        if rec.get("type") == "assistant":
            msg = rec.get("message") or {}
            content = msg.get("content")
            if isinstance(content, list):
                parts = [
                    b.get("text", "")
                    for b in content
                    if isinstance(b, dict) and b.get("type") == "text" and b.get("text")
                ]
                if parts:
                    kind, text = "assistant_text", "\n".join(parts)
        self.records.append((len(self.records), kind, text))

    def mark(self):
        with self.lock:
            return len(self.records)

    def assistant_since(self, mark):
        with self.lock:
            return any(k == "assistant_text" for (_, k, _) in self.records[mark:])

    def reply_since(self, mark):
        """Text of the LAST assistant text message after the mark (skips
        tool-call wrapper messages and thinking, which never produce text
        blocks here)."""
        with self.lock:
            texts = [t for (i, k, t) in self.records[mark:] if k == "assistant_text"]
        return texts[-1] if texts else None

    def caught_up(self):
        """True once every byte currently in the session file has been
        ingested (offset and record parsing share the lock, so an offset at
        EOF means the records list is complete too)."""
        with self.lock:
            path, off = self.path, self.offset
        if not path:
            return True
        try:
            return off >= os.stat(path).st_size
        except OSError:
            return True

    def idle_complete(self, mark):
        with self.lock:
            if not self.records[mark:]:
                return False
            silent = time.time() - self.last_activity
            last_kind = self.records[-1][1]
        return silent >= IDLE_FALLBACK_S and last_kind == "assistant_text"


# ---------------------------------------------------------------- suggestions

# Ported verbatim from the plugin's src/claude/ReplySuggester.ts so the watch
# chip and the composer ghost text read the same. Phrased emphatically so
# Haiku writes AS the user rather than answering the assistant's reply itself
# — the transcript is data, and the only valid output is the next thing the
# human would type.
SUGGEST_SYSTEM_PROMPT = (
    "You write the USER's next message in an ongoing chat between a user and an AI assistant. "
    "Your input is the user's last message and the assistant's reply to it. "
    "Output ONE short follow-up the user would plausibly send next, written in the user's own first-person voice: "
    "for example accepting an offer the assistant made, asking it to continue or go deeper, requesting a concrete next step, or asking a natural clarifying question. "
    "If the assistant ended with a question or an offer, answer or accept it directly. "
    "Never reply as the assistant, never answer the user's question, never explain or comment. "
    "At most 15 words. Reply with ONLY the message text — no quotes, no preamble, no label."
)

SUGGEST_LABEL_RE = re.compile(
    r"^(my next message|next message|user|me|suggestion)\s*:\s*", re.I
)
SUGGEST_BULLET_RE = re.compile(r"^[-*•]\s+")
SUGGEST_PARA_RE = re.compile(r"\n\s*\n")
SUGGEST_ASSISTANT_VOICE_RE = re.compile(
    r"^(here('s| is| are)|i('d| would) be (happy|glad)|as an ai|great question|i can help|i'll help)\b",
    re.I,
)


def clean_suggestion(raw):
    """Port of ReplySuggester.cleanSuggestion. Trim, strip wrapping quotes and
    stray labels, collapse whitespace, and reject anything that reads like the
    assistant talking rather than the user."""
    text = (raw or "").strip()
    if not text:
        return None
    # Keep only the first paragraph — a model that "helpfully" lists three
    # options has already broken the contract, and the first is the best.
    text = SUGGEST_PARA_RE.split(text)[0].strip()
    text = SUGGEST_LABEL_RE.sub("", text)
    text = SUGGEST_BULLET_RE.sub("", text)
    if ((text.startswith('"') and text.endswith('"'))
            or (text.startswith("'") and text.endswith("'"))
            or (text.startswith("“") and text.endswith("”"))):
        text = text[1:-1].strip()
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return None
    if len(text.split()) > 30 or len(text) > 200:
        return None
    # Assistant-voice tells: "I'd be happy to", "Here's", "As an AI". Plain
    # acceptances ("Sure, go ahead") are exactly what a user types back to an
    # offer, so they stay.
    if SUGGEST_ASSISTANT_VOICE_RE.match(text):
        return None
    return text


def build_suggest_prompt(user_message, reply_text):
    """Same truncation split as ReplySuggester: the user side rarely needs more
    than its opening; the assistant side is the opposite — offers and questions
    cluster at the END of a reply, so keep the tail with a little of the head."""
    user = user_message.strip()
    reply = reply_text.strip()
    user_snippet = user[:600] + "…" if len(user) > 600 else user
    reply_snippet = reply
    if len(reply) > 1800:
        reply_snippet = reply[:500] + "\n…\n" + reply[-1300:]
    return (
        "Below is the latest exchange in my chat with an AI assistant. "
        "Write the next message I would send, in my voice. Output only that message.\n"
        "\n"
        "<exchange>\n"
        f"[my message]\n{user_snippet}\n"
        "\n"
        f"[the assistant's reply]\n{reply_snippet}\n"
        "</exchange>\n"
        "\n"
        "My next message:"
    )


def run_suggest_pass(claude_path, user_message, reply_text):
    """One-shot Haiku `claude --print` side pass, mirroring the plugin's
    QuickPrompt spawn trimming (system prompt override skips CLAUDE.md /
    memory / skill discovery, empty tool catalog, no slash commands, user
    settings only, no session persistence). Returns the cleaned suggestion or
    None on any failure. NOTE: --print bills the subscription caps like the
    interactive session does, so this stays one small Haiku call per turn."""
    prompt = build_suggest_prompt(user_message, reply_text)
    env = dict(os.environ)
    env["PATH"] = enriched_path()
    env["CLAUDE_CODE_ENTRYPOINT"] = "watch-bridge-suggest"
    argv = [
        claude_path,
        "--print",
        "--model", SUGGEST_MODEL,
        "--system-prompt", SUGGEST_SYSTEM_PROMPT,
        "--tools", "",
        "--disable-slash-commands",
        "--setting-sources", "user",
        "--no-session-persistence",
        prompt,
    ]
    t0 = time.time()
    try:
        proc = subprocess.run(
            argv, cwd=VAULT, env=env, timeout=SUGGEST_TIMEOUT_S,
            capture_output=True, text=True,
        )
    except subprocess.TimeoutExpired:
        log(f"suggest: TIMEOUT after {SUGGEST_TIMEOUT_S}s")
        return None
    except OSError as e:
        log(f"suggest: spawn failed: {e}")
        return None
    elapsed = int((time.time() - t0) * 1000)
    if proc.returncode != 0:
        log(f"suggest: failed in {elapsed}ms (exit {proc.returncode}): "
            f"{(proc.stderr or '')[:200]}")
        return None
    cleaned = clean_suggestion((proc.stdout or "")[:SUGGEST_MAX_OUTPUT_CHARS])
    log(f"suggest: done in {elapsed}ms -> {cleaned!r}")
    return cleaned


# ---------------------------------------------------------------- turn manager


class TurnManager:
    def __init__(self, session, tailer):
        self.session = session
        self.tailer = tailer
        self.busy = threading.Lock()
        self.last_reply = None
        self.last_session_id = None
        self.last_completed_at = 0.0  # bridge clock, deprecated GET /wait fallback
        self.turn_seq = 0  # monotonic completion counter; the reliable GET /wait key
        # Suggested next user message for the most recent good reply:
        # {"turn_seq": int, "suggestion": str|None}. Generated off-turn by a
        # Haiku side pass, so it lags the reply by a second or two and may
        # never arrive at all (disabled, failed, or rejected by the cleaner).
        self.last_suggestion = None
        self._suggest_gate = threading.Lock()   # at most one pass in flight
        self._suggest_meta = threading.Lock()   # guards _suggest_target
        self._suggest_target = -1               # seq whose result is still wanted

    def run_turn(self, message, budget_s):
        """Returns (status_code, payload). 409 if a turn is in flight; 202 with
        a partial if the budget expires (the turn keeps running and lands in
        last_reply for GET /last)."""
        if not self.busy.acquire(blocking=False):
            return 409, {"error": "turn_in_flight"}
        try:
            if not self.session.ready():
                self.busy.release()
                return 503, {"error": "session_not_ready"}
            self._maybe_auto_reset()
            self._drop_suggestion()
            try:
                os.remove(SIGNAL_PATH)
            except OSError:
                pass
            start = time.time()
            mark = self.tailer.mark()
            emit_state("thinking")
            try:
                self.session.send(message)
            except (OSError, RuntimeError) as e:
                self.busy.release()
                emit_state("ready")
                return 503, {"error": f"send_failed: {e}"}
            # Snapshot the generation this message was sent into so the 10s
            # wedge nudge (below) can be routed through the same gen-guarded
            # path as every other write instead of hitting self.session.fd
            # directly, which can be a stale/recycled descriptor by then.
            turn_gen = self.session.current_gen()

            done = threading.Event()
            result = {}

            def wait_for_completion():
                try:
                    nudged = False
                    aborted_reason = None
                    while True:
                        if self._stop_signaled(start) or self.tailer.idle_complete(mark):
                            break
                        if not self.session.alive:
                            aborted_reason = "session_dead"
                            break
                        waited = time.time() - start
                        landed = self.tailer.mark() > mark
                        if not nudged and waited > 10 and not self.tailer.assistant_since(mark):
                            # The submit CR can get swallowed if the TUI was
                            # mid-redraw (seen after /model switches). An
                            # empty-composer CR is a no-op, so nudging during
                            # a slow-but-real turn is harmless.
                            nudged = True
                            log("turn: no assistant text 10s after send, re-sending CR")
                            self.session.nudge_submit(expected_gen=turn_gen)
                        if not landed and waited > 45:
                            log("turn: message never landed in transcript, aborting turn")
                            aborted_reason = "never_landed"
                            break
                        if waited > budget_s * 4:
                            log("turn: absolute ceiling reached, aborting turn")
                            aborted_reason = "ceiling"
                            break
                        time.sleep(0.25)
                    # the stop hook can fire before the tailer's next 250ms
                    # poll ingests the final assistant record; wait until the
                    # tailer is at EOF so we extract the LAST message, not an
                    # earlier preamble
                    grace = time.time() + 3
                    while time.time() < grace and not self.tailer.caught_up():
                        time.sleep(0.1)
                    time.sleep(0.3)
                    reply = self.tailer.reply_since(mark) or ""
                    result["reply"] = reply
                    if aborted_reason and not reply:
                        # A dead child / never-landed message / absolute
                        # ceiling with no assistant text is a failed turn, not
                        # a completed one: don't stamp last_reply/
                        # last_completed_at/turn_seq over the last GOOD reply,
                        # or /last and a background /wait hand the watch an
                        # empty "reply" it renders as a real (blank) answer.
                        result["aborted"] = aborted_reason
                        log(f"turn: aborted ({aborted_reason}), not recording as completed")
                        emit_state("ready")
                    else:
                        self.last_reply = {
                            "reply": reply,
                            "session_id": self.session.session_id,
                            "elapsed_ms": int((time.time() - start) * 1000),
                            "partial": False,
                        }
                        self.last_completed_at = time.time()
                        self.turn_seq += 1
                        self.last_reply["turn_seq"] = self.turn_seq
                        # Fire-and-forget: the turn response never waits on it.
                        self._kick_suggestion(self.turn_seq, message, reply)
                        emit_state("complete")
                finally:
                    done.set()
                    self.busy.release()

            threading.Thread(target=wait_for_completion, daemon=True).start()
            if done.wait(timeout=budget_s):
                if result.get("aborted"):
                    return 503, {"error": "turn_aborted", "reason": result["aborted"]}
                return 200, dict(self.last_reply)
            partial = self.tailer.reply_since(mark)
            return 202, {
                "reply": partial or "Still working. Ask again in a moment.",
                "session_id": self.session.session_id,
                "elapsed_ms": int((time.time() - start) * 1000),
                "partial": True,
            }
        except Exception:
            try:
                self.busy.release()
            except RuntimeError:
                pass
            raise

    # ---- suggestions

    def _drop_suggestion(self):
        """Forget the current suggestion and disown any pass still running, so
        a late result for a superseded turn is discarded instead of stamped
        over the new one. Called when a turn starts and on /reset."""
        with self._suggest_meta:
            self._suggest_target = -1
        self.last_suggestion = None

    def _kick_suggestion(self, seq, user_message, reply_text):
        if not SUGGEST_ENABLED:
            return
        if not (user_message or "").strip() or not (reply_text or "").strip():
            return
        with self._suggest_meta:
            self._suggest_target = seq
        threading.Thread(
            target=self._suggest_worker,
            args=(seq, user_message, reply_text),
            daemon=True,
        ).start()

    def _suggest_worker(self, seq, user_message, reply_text):
        # The gate serializes passes; the target check drops a result whose
        # turn is no longer the current one (a newer turn supersedes it).
        with self._suggest_gate:
            with self._suggest_meta:
                if self._suggest_target != seq:
                    return
            try:
                suggestion = run_suggest_pass(
                    self.session.claude_path, user_message, reply_text
                )
            except Exception as e:  # never let a side pass take down the daemon
                log(f"suggest: unexpected error: {e}")
                suggestion = None
            with self._suggest_meta:
                if self._suggest_target != seq:
                    log(f"suggest: dropping stale result for turn {seq}")
                    return
                self.last_suggestion = {"turn_seq": seq, "suggestion": suggestion}

    def suggestion_for(self, seq):
        """The suggestion text for `seq` if one is ready, else None."""
        snap = self.last_suggestion
        if snap and snap.get("turn_seq") == seq:
            return snap.get("suggestion")
        return None

    def _stop_signaled(self, turn_start):
        try:
            return os.stat(SIGNAL_PATH).st_mtime >= turn_start
        except OSError:
            return False

    def _maybe_auto_reset(self):
        """Between turns only: respawn if the transcript has grown too large."""
        f = self.session.session_file
        try:
            if f and os.stat(f).st_size > JSONL_AUTO_RESET_BYTES:
                log("transcript over size threshold, auto-resetting session")
                self.session.respawn()
                deadline = time.time() + 30
                while time.time() < deadline and not self.session.ready():
                    time.sleep(0.25)
        except OSError:
            pass

    def reset(self):
        if not self.busy.acquire(blocking=False):
            return 409, {"error": "turn_in_flight"}
        try:
            self.session.respawn()
            self._drop_suggestion()
            return 200, {"ok": True, "session_id": None}
        finally:
            self.busy.release()


# ---------------------------------------------------------------- session directory


TMUX = "/opt/homebrew/bin/tmux"


def _run(argv, timeout=5):
    try:
        return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        return None


def extract_messages(path, limit=30, tail_bytes=262144):
    """Last `limit` user/assistant text messages from a session JSONL. Reads
    only the file tail (`tail_bytes`) so huge transcripts stay cheap. Tool
    results, meta records, and harness-injected user content are skipped.
    Widens to the full 256KB tail if a smaller `tail_bytes` window (e.g. the
    session-list preview path) came up short of `limit` messages."""
    try:
        size = os.stat(path).st_size
    except OSError:
        return []
    msgs = []
    try:
        with open(path, "rb") as f:
            if size > tail_bytes:
                f.seek(size - tail_bytes)
                f.readline()  # drop the partial line at the seek point
            data = f.read()
    except OSError:
        return []
    for line in data.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(rec, dict):
            continue
        if rec.get("isMeta"):
            continue
        rtype = rec.get("type")
        msg = rec.get("message") or {}
        content = msg.get("content")
        text = ""
        if rtype == "user":
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                if any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
                    continue
                text = "\n".join(
                    b.get("text", "") for b in content
                    if isinstance(b, dict) and b.get("type") == "text" and b.get("text")
                )
            text = text.strip()
            if not text or text.startswith(("<command-", "<local-command", "Caveat:", "<system-reminder")):
                continue
            role = "user"
        elif rtype == "assistant":
            if isinstance(content, list):
                text = "\n".join(
                    b.get("text", "") for b in content
                    if isinstance(b, dict) and b.get("type") == "text" and b.get("text")
                ).strip()
            if not text:
                continue
            role = "assistant"
        else:
            continue
        msgs.append({
            "uuid": rec.get("uuid"),
            "role": role,
            "text": text,
            "ts": rec.get("timestamp"),
        })
    msgs = msgs[-limit:]
    if len(msgs) < limit and tail_bytes < min(size, 262144):
        return extract_messages(path, limit, 262144)
    return msgs


class SessionDirectory:
    """Discovers activated Remote Control `claude` sessions on this Mac
    (`claude remote-control --spawn=session`) and maps each to its session
    JSONL, so the watch can list and read them. Plain terminal sessions and
    the plugin's own `claude --print` chat subprocesses are deliberately NOT
    listed — the Sessions tab is for Remote Control only. Input routing: a
    remote-control claude running inside a tmux pane is attachable via `tmux
    send-keys`; otherwise it is view-only."""

    # Above SessionsView's 3s poll period so a normal poll is a cache hit.
    CACHE_S = 15.0
    # A cache hit still missing its transcript (a just-spawned session with
    # no JSONL yet) gets a tighter TTL so the file is picked up promptly
    # without forcing every other poll into a full rescan.
    PENDING_FILE_CACHE_S = 5.0
    # Fallback-mapping guard: a session writes its transcript within seconds of
    # spawning, so a JSONL born much later than the process belongs to a
    # different session in the same cwd. Used only when no ~/.claude/sessions
    # index exists for the pid.
    SPAWN_WINDOW_S = 180.0

    def __init__(self, session, turns):
        self.session = session
        self.turns = turns
        self.lock = threading.Lock()
        self._refresh_lock = threading.Lock()  # single-flights refresh()
        self._cached_at = 0.0
        self._sessions = []
        self._by_id = {}

    def _ps_table(self):
        out = _run(["ps", "-axo", "pid=,ppid=,command="])
        rows = []
        if not out or out.returncode != 0:
            return rows
        for line in out.stdout.splitlines():
            parts = line.strip().split(None, 2)
            if len(parts) < 3:
                continue
            try:
                rows.append((int(parts[0]), int(parts[1]), parts[2]))
            except ValueError:
                continue
        return rows

    def _tmux_pane_map(self):
        """pane_pid -> tmux target usable with send-keys."""
        out = _run([TMUX, "list-panes", "-a", "-F",
                    "#{session_name}:#{window_index}.#{pane_index}\t#{pane_pid}"])
        panes = {}
        if not out or out.returncode != 0:
            return panes
        for line in out.stdout.splitlines():
            try:
                target, pid = line.rsplit("\t", 1)
                panes[int(pid)] = target
            except ValueError:
                continue
        return panes

    def _cwd_of(self, pid):
        out = _run(["lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"], timeout=10)
        if not out:
            return None
        for line in out.stdout.splitlines():
            if line.startswith("n"):
                return line[1:]
        return None

    def _start_epoch(self, pid):
        out = _run(["ps", "-p", str(pid), "-o", "lstart="])
        if not out or not out.stdout.strip():
            return None
        try:
            return time.mktime(time.strptime(out.stdout.strip(), "%a %b %d %H:%M:%S %Y"))
        except ValueError:
            return None

    def _session_index(self, pid):
        """See module-level session_index_for()."""
        return session_index_for(pid)

    def _session_file_for(self, cwd, start_epoch, exclude=None):
        """Fallback mapping for sessions with no ~/.claude/sessions/<pid>.json
        index (claude < 2.1.178). Newest JSONL in the project slug born after
        the process started; the same heuristic the plugin uses. Reliable only
        when a session is mapped soon after spawn — for a long-lived session
        sharing its cwd with others it can pick a newer, unrelated transcript,
        which is why the index is preferred whenever it exists."""
        proj = project_dir_for(cwd)
        floor = (start_epoch or 0) - 5
        # Upper bound: reject files born well after the process started — they
        # belong to a later session in the same cwd. Skipped when the start
        # time is unknown (no bound we can trust).
        ceil = (start_epoch + self.SPAWN_WINDOW_S) if start_epoch else None
        best = None
        try:
            for name in os.listdir(proj):
                if not name.endswith(".jsonl"):
                    continue
                full = os.path.join(proj, name)
                if exclude and full == exclude:
                    continue
                st = os.stat(full)
                birth = getattr(st, "st_birthtime", st.st_mtime)
                if birth < floor:
                    continue
                if ceil is not None and birth > ceil:
                    continue
                if best is None or birth > best[1]:
                    best = (full, birth)
        except OSError:
            return None
        return best[0] if best else None

    def refresh(self):
        rows = self._ps_table()
        ppid_of = {pid: ppid for pid, ppid, _ in rows}
        panes = self._tmux_pane_map()

        def tmux_target(pid):
            seen = set()
            while pid > 1 and pid not in seen:
                seen.add(pid)
                if pid in panes:
                    return panes[pid]
                pid = ppid_of.get(pid, 0)
            return None

        own_file = self.session.session_file
        sessions = []
        for pid, _, command in rows:
            argv = command.split()
            if not argv or os.path.basename(argv[0]) != "claude":
                continue
            if pid == self.session.pid:
                # The bridge's own session is the watch app's main Chat tab;
                # listing it in /sessions would just duplicate that history.
                continue
            # Only surface explicitly activated Remote Control sessions, i.e.
            # claude-cli-chat's `claude remote-control --spawn=session`. Plain
            # terminal `claude` sessions and the plugin's own `claude --print`
            # chat subprocesses are intentionally excluded — the watch's
            # Sessions tab is for Remote Control, not every claude on the Mac.
            # Filtering here (before the expensive lsof/lstart probes below)
            # also keeps refresh() cheap when many claude processes are open.
            if "remote-control" not in command:
                continue
            # Map the process to its transcript. Prefer the authoritative
            # ~/.claude/sessions/<pid>.json index (exact sessionId + cwd); it is
            # the ONLY reliable mapping for a long-lived session that shares its
            # cwd with other claude sessions. The birthtime heuristic is a
            # fallback for older sessions that predate the index — and it
            # mis-maps in exactly that shared-cwd case (it would pick whichever
            # JSONL was born most recently, e.g. an unrelated plugin chat).
            idx = self._session_index(pid)
            if idx and idx.get("sessionId") and idx.get("cwd"):
                cwd = idx["cwd"]
                file = os.path.join(project_dir_for(cwd), idx["sessionId"] + ".jsonl")
                if not os.path.exists(file):
                    file = None  # transcript not written yet; resolves next refresh
            else:
                cwd = self._cwd_of(pid)
                if not cwd:
                    continue
                start = self._start_epoch(pid)
                file = self._session_file_for(cwd, start, exclude=own_file)
            target = tmux_target(pid)
            kind = "remote-control"
            # Prefer the session's configured name. The plugin spawns the
            # subcommand form (`--name <label>`); the legacy `--remote-control
            # <label>` flag form is still honored. Either way fall back to the
            # cwd basename when no explicit name was given (the common case,
            # where the proxy defaults the label to the hostname).
            name = os.path.basename(cwd)
            m = re.search(r"--name\s+(.+)$", command) \
                or re.search(r"--remote-control\s+(.+)$", command)
            if m:
                name = m.group(1).strip().strip("'\"")
            sessions.append({
                "id": os.path.basename(file)[:-len(".jsonl")] if file else f"pid-{pid}",
                "kind": kind,
                "name": name,
                "cwd": cwd,
                "file": file,
                "attach": f"tmux:{target}" if target else None,
                "pid": pid,
            })
        for s in sessions:
            s["last_activity"] = None
            s["preview"] = ""
            if s["file"]:
                try:
                    s["last_activity"] = int(os.stat(s["file"]).st_mtime)
                except OSError:
                    pass
                tail = extract_messages(s["file"], limit=1, tail_bytes=16384)
                if tail:
                    s["preview"] = tail[-1]["text"][:120]
        with self.lock:
            self._cached_at = time.time()
            self._sessions = sessions
            self._by_id = {s["id"]: s for s in sessions}
        return sessions

    def _refresh_once(self):
        """Single-flight refresh(): concurrent callers (the app plus the
        widget timeline refresh) await one in-progress scan instead of each
        launching their own ps/tmux/lsof sweep."""
        if self._refresh_lock.acquire(blocking=False):
            try:
                return self.refresh()
            finally:
                self._refresh_lock.release()
        with self._refresh_lock:  # blocks until the in-flight scan finishes
            with self.lock:
                return list(self._sessions)

    def list_sessions(self):
        with self.lock:
            fresh = time.time() - self._cached_at < self.CACHE_S
            cached = list(self._sessions)
        return cached if fresh else self._refresh_once()

    def resolve(self, sid):
        with self.lock:
            age = time.time() - self._cached_at
            hit = self._by_id.get(sid)
        ttl = self.PENDING_FILE_CACHE_S if (hit and not hit.get("file")) else self.CACHE_S
        if hit and age < ttl:
            return hit
        self._refresh_once()
        with self.lock:
            found = self._by_id.get(sid)
            if found:
                return found
            # The id graduates from pid-<n> to the session uuid once the
            # transcript appears; keep resolving the old handle by pid.
            if sid.startswith("pid-"):
                try:
                    pid = int(sid[len("pid-"):])
                except ValueError:
                    return hit
                for s in self._sessions:
                    if s["pid"] == pid:
                        return s
            return hit

    @staticmethod
    def public(s):
        return {k: v for k, v in s.items() if k != "file"}

    def messages(self, sid, limit):
        s = self.resolve(sid)
        if not s:
            return 404, {"error": "session_not_found"}
        if not s["file"]:
            return 200, {"session": self.public(s), "messages": []}
        return 200, {"session": self.public(s), "messages": extract_messages(s["file"], limit)}

    def send(self, sid, message):
        s = self.resolve(sid)
        if not s:
            return 404, {"error": "session_not_found"}
        attach = s.get("attach")
        if attach == "bridge":
            if self.turns.busy.locked():
                return 409, {"error": "turn_in_flight"}
            try:
                self.session.send(message)
            except (OSError, RuntimeError) as e:
                return 503, {"error": f"send_failed: {e}"}
            return 200, {"ok": True}
        if attach and attach.startswith("tmux:"):
            target = attach[len("tmux:"):]
            # Bracketed paste so embedded newlines don't submit early, then CR.
            paste = _run([TMUX, "send-keys", "-t", target, "-l",
                          "\x1b[200~" + message + "\x1b[201~"])
            if not paste or paste.returncode != 0:
                err = (paste.stderr.strip() if paste else "tmux unavailable")
                return 503, {"error": f"send_failed: {err}"}
            time.sleep(0.3)
            _run([TMUX, "send-keys", "-t", target, "Enter"])
            return 200, {"ok": True}
        return 409, {"error": "view_only"}


# ---------------------------------------------------------------- usage limits


def _https_context():
    """The framework Python install has no root CA bundle wired into ssl's
    defaults, so load certifi's or the system bundle explicitly."""
    import ssl
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    if os.path.exists("/etc/ssl/cert.pem"):
        return ssl.create_default_context(cafile="/etc/ssl/cert.pem")
    return ssl.create_default_context()


class UsageFetcher:
    """Proxies Anthropic's OAuth usage endpoint for the watch, reusing the
    ClaudeUsageBar credentials file (and keeping it fresh for both apps, since
    refreshed tokens are written back to the same file)."""

    CRED_PATH = HOME + "/.config/claude-usage-bar/credentials.json"
    USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
    TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
    CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
    CACHE_S = 60.0

    FAIL_CACHE_S = 30.0

    def __init__(self):
        self.lock = threading.Lock()  # protects cache + failure state only
        self._fetch_lock = threading.Lock()  # single-flights the actual network I/O
        self._cached_at = 0.0
        self._cached = None
        self._last_error = None
        self._last_error_at = 0.0
        self._last_refresh_fail_log = 0.0
        self._ctx = _https_context()

    def fetch(self):
        with self.lock:
            hit = self._fresh_hit_locked()
            if hit is not None:
                return hit
        # Network I/O happens outside self.lock; _fetch_lock coalesces
        # concurrent callers (both widget kinds refresh around the same time)
        # onto one in-flight request instead of each holding a lock across
        # up to 45s of urlopen calls.
        with self._fetch_lock:
            with self.lock:
                hit = self._fresh_hit_locked()
                if hit is not None:
                    return hit
            code, payload = self._do_fetch()
            with self.lock:
                if code == 200:
                    self._cached_at = time.time()
                    self._cached = payload
                    self._last_error = None
                else:
                    self._last_error = payload
                    self._last_error_at = time.time()
                    if self._cached is not None:
                        return 200, dict(self._cached, stale=True)
                return code, payload

    def _fresh_hit_locked(self):
        """Called with self.lock held. Returns a (code, payload) to serve
        immediately, or None if a real fetch is needed."""
        if self._cached is not None and time.time() - self._cached_at < self.CACHE_S:
            return 200, self._cached
        if self._last_error is not None and time.time() - self._last_error_at < self.FAIL_CACHE_S:
            if self._cached is not None:
                return 200, dict(self._cached, stale=True)
            return 503, self._last_error
        return None

    def _do_fetch(self):
        creds = self._load_creds()
        if not creds or not creds.get("accessToken"):
            return 503, {"error": "usage_credentials_missing"}
        if self._needs_refresh(creds):
            # Proactive refresh: the existing access token still works, so a
            # failure here is noise, not a user-visible problem. Rate-limit it.
            creds = self._refresh(creds, quiet=True) or creds
        code, payload = self._get_usage(creds["accessToken"])
        if code == 401:
            creds = self._refresh(creds)
            if not creds:
                return 503, {"error": "usage_auth_expired"}
            code, payload = self._get_usage(creds["accessToken"])
        return code, payload

    def _load_creds(self):
        try:
            with open(self.CRED_PATH) as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return None

    @staticmethod
    def _parse_expiry(value):
        if not isinstance(value, str):
            return 0
        for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%fZ"):
            try:
                # calendar.timegm treats the struct as UTC (the value is
                # explicitly a "Z" stamp); time.mktime treats it as LOCAL time
                # and, combined with a non-DST `- time.timezone` correction,
                # is off by an hour for roughly eight months of the year.
                return calendar.timegm(time.strptime(value, fmt))
            except ValueError:
                continue
        return 0

    def _needs_refresh(self, creds):
        return self._parse_expiry(creds.get("expiresAt")) <= time.time() + 60

    def _get_usage(self, token):
        req = urllib.request.Request(self.USAGE_URL, headers={
            "Authorization": f"Bearer {token}",
            "anthropic-beta": "oauth-2025-04-20",
        })
        try:
            with urllib.request.urlopen(req, timeout=15, context=self._ctx) as resp:
                return resp.status, json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            return e.code, {"error": f"usage_http_{e.code}"}
        except (OSError, json.JSONDecodeError, ValueError) as e:
            return 502, {"error": f"usage_fetch_failed: {e}"}

    def _refresh(self, creds, quiet=False):
        """quiet=True is for the proactive (not-yet-expired) refresh path: the
        existing access token still works there, so a failure is noise, not a
        user-visible problem, and is rate-limited to at most once an hour so a
        genuine auth expiry (quiet=False, from the reactive 401 path) stays
        distinguishable from it in the log."""
        refresh_token = creds.get("refreshToken")
        if not refresh_token:
            return None
        body = {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": self.CLIENT_ID,
        }
        scopes = creds.get("scopes") or []
        if scopes:
            body["scope"] = " ".join(scopes)
        req = urllib.request.Request(
            self.TOKEN_URL,
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=15, context=self._ctx) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
        except (OSError, urllib.error.HTTPError, json.JSONDecodeError, ValueError) as e:
            if quiet:
                now = time.time()
                if now - self._last_refresh_fail_log > 3600:
                    self._last_refresh_fail_log = now
                    log(f"usage token proactive refresh failed (access token still valid): {e}")
            else:
                log(f"usage token refresh failed: {e}")
            return None
        access = data.get("access_token")
        if not access:
            return None
        expires_in = data.get("expires_in") or 3600
        new_scope = data.get("scope")
        updated_fields = {
            "accessToken": access,
            "refreshToken": data.get("refresh_token") or refresh_token,
            "expiresAt": time.strftime(
                "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + float(expires_in))
            ),
            "scopes": new_scope.split() if isinstance(new_scope, str) and new_scope else scopes,
        }
        # Merge onto the current on-disk file rather than overwriting it:
        # ClaudeUsageBar shares this file and persists other keys (account
        # metadata, etc.) that a from-scratch write would silently destroy.
        merged = self._load_creds() or {}
        merged.update(updated_fields)
        try:
            tmp = self.CRED_PATH + ".watch-bridge.tmp"
            with open(tmp, "w") as f:
                json.dump(merged, f, indent=2)
                f.write("\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.CRED_PATH)
            log("usage token refreshed")
        except OSError as e:
            log(f"usage credentials save failed: {e}")
        return merged


# ---------------------------------------------------------------- http


COMMAND_ALLOWLIST = ("/model", "/effort")

# /model and /effort also persist themselves into ~/.claude/settings.json as
# the global default for new sessions. The watch picker must stay
# session-scoped, so snapshot those keys before the command and restore them
# a few seconds after the CLI has written its update.
SETTINGS_PATH = HOME + "/.claude/settings.json"
PERSISTED_COMMAND_KEYS = ("model", "effortLevel")
_MISSING = object()


def settings_snapshot():
    try:
        with open(SETTINGS_PATH) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return None
    return {k: data.get(k, _MISSING) for k in PERSISTED_COMMAND_KEYS}


def settings_restore(snap):
    if snap is None:
        return
    try:
        with open(SETTINGS_PATH) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return
    changed = False
    for k, v in snap.items():
        if v is _MISSING:
            if k in data:
                del data[k]
                changed = True
        elif data.get(k) != v:
            data[k] = v
            changed = True
    if not changed:
        return
    try:
        tmp = SETTINGS_PATH + ".watch-bridge.tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
            f.write("\n")
        os.replace(tmp, SETTINGS_PATH)
        log("restored persisted model/effort defaults after slash command")
    except OSError as e:
        log(f"settings restore failed: {e}")


class SettingsGuard:
    """Keeps the watch's /model and /effort session-scoped: those commands also
    persist into settings.json as the global default. We snapshot the GENUINE
    pre-command baseline ONCE per burst (the "Apply" button fires /model then
    /effort ~1s apart) and restore it after the burst settles. Re-snapshotting
    per command would capture the first command's own persisted change as the
    baseline, re-polluting the global default — the bug this class exists to
    avoid."""

    SETTLE_S = 4.0

    def __init__(self):
        self.lock = threading.Lock()
        self.baseline = None
        self.timer = None

    def guard(self):
        with self.lock:
            if self.timer is None:
                # idle: capture the true baseline before any command lands
                self.baseline = settings_snapshot()
            else:
                self.timer.cancel()  # extend the window past this command
            self.timer = threading.Timer(self.SETTLE_S, self._fire)
            self.timer.daemon = True
            self.timer.start()

    def _fire(self):
        with self.lock:
            snap = self.baseline
            self.baseline = None
            self.timer = None
        settings_restore(snap)


class StickyCommands:
    """Last /model and /effort sent, replayed into each fresh claude child so
    the watch's picker choice survives respawns (auto-reset, watchdog, /reset)."""

    def __init__(self, session, guard):
        self.session = session
        self.guard = guard
        self.lock = threading.Lock()
        self.commands = {}  # "/model" -> full command string
        self._replayed_gen = session._gen
        threading.Thread(target=self._loop, daemon=True).start()

    def remember(self, command):
        with self.lock:
            self.commands[command.split()[0]] = command

    def _loop(self):
        while True:
            time.sleep(1)
            gen = self.session._gen
            if gen == self._replayed_gen or not self.session.ready():
                continue
            self._replayed_gen = gen
            with self.lock:
                pending = list(self.commands.values())
            if not pending:
                continue
            # The TUI right after ready() is the riskiest redraw window; give
            # it a moment, and confirm each command's submit CR before typing
            # the next one so two commands can never concatenate in the
            # composer ("/model sonnet[1m]/effort high").
            time.sleep(2.0)
            for cmd in pending:
                self.guard.guard()
                try:
                    self.session.send(cmd)
                    log(f"replayed sticky command: {cmd}")
                    time.sleep(0.8)
                    self.session.nudge_submit(gen)
                    time.sleep(1.5)
                except (OSError, RuntimeError) as e:
                    log(f"sticky replay failed for {cmd}: {e}")


SESSION_MESSAGES_RE = re.compile(r"^/sessions/([A-Za-z0-9._-]+)/messages(?:\?(.*))?$")
SESSION_SEND_RE = re.compile(r"^/sessions/([A-Za-z0-9._-]+)/send$")


def make_handler(token, session, turns, sticky, guard, directory, usage, started_at):
    class Handler(BaseHTTPRequestHandler):
        # Keep-alive: every response sets an accurate Content-Length (see
        # _send below, the sole response path), so HTTP/1.1 is safe here and
        # saves a TCP handshake per poll over the tailnet. `timeout` bounds an
        # abandoned keep-alive connection (well above the /wait ceiling) so
        # it can't pin a ThreadingHTTPServer thread forever.
        protocol_version = "HTTP/1.1"
        timeout = 620

        def log_message(self, fmt, *args):
            log(f"http {self.address_string()} {fmt % args}")

        def _authed(self):
            header = self.headers.get("Authorization", "")
            supplied = header[7:] if header.startswith("Bearer ") else ""
            # http.client decodes headers as latin-1, so a mistyped/mangled
            # token can carry non-ASCII codepoints; hmac.compare_digest raises
            # TypeError on those instead of just comparing unequal. Encoding
            # first keeps a bad token a clean auth failure, not a dropped
            # connection with no response.
            return hmac.compare_digest(supplied.encode("utf-8", "ignore"), token.encode())

        def _send(self, code, payload):
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _query(self):
            raw = self.path.split("?", 1)[1] if "?" in self.path else ""
            qs = {}
            for part in raw.split("&"):
                if "=" in part:
                    k, v = part.split("=", 1)
                    qs[k] = v
            return qs

        def _reply_payload(self):
            """Copy of last_reply plus the suggestion for that same turn when
            one is already generated (null otherwise), so the watch can render
            the chip without a second round trip to /suggest."""
            payload = dict(turns.last_reply)
            payload["suggestion"] = turns.suggestion_for(payload.get("turn_seq"))
            return payload

        def do_GET(self):
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            if self.path == "/health":
                state = "thinking" if turns.busy.locked() else (
                    "ready" if session.ready() else ("starting" if session.alive else "dead")
                )
                return self._send(200, {
                    "state": state,
                    "session_id": session.session_id,
                    "session_file": session.session_file,
                    "child_pid": session.pid,
                    "uptime_s": int(time.time() - started_at),
                })
            if self.path == "/screen":
                # Debug: last ANSI-stripped PTY output.
                return self._send(200, {"tail": session.stdout_tail[-3000:]})
            if self.path == "/last":
                if turns.last_reply is None:
                    return self._send(404, {"error": "no_reply_yet"})
                return self._send(200, self._reply_payload())
            if self.path == "/wait" or self.path.startswith("/wait?"):
                qs = {}
                for part in (self.path.split("?", 1)[1] if "?" in self.path else "").split("&"):
                    if "=" in part:
                        k, v = part.split("=", 1)
                        qs[k] = v
                try:
                    since = float(qs.get("since", "0"))
                except ValueError:
                    since = 0.0
                # since (a client wall-clock timestamp) is a deprecated
                # fallback: clock skew between the watch and this Mac can make
                # it match instantly (stale reply) or never (full timeout).
                # after_seq matches on TurnManager's monotonic completion
                # counter instead, which skew can't affect.
                after_seq = None
                if "after_seq" in qs:
                    try:
                        after_seq = int(qs["after_seq"])
                    except ValueError:
                        after_seq = None
                try:
                    hold = max(1.0, min(float(qs.get("timeout", "600")), 1500.0))
                except ValueError:
                    hold = 600.0
                deadline = time.time() + hold
                # One blocked thread per waiter (ThreadingHTTPServer); the
                # watch holds at most one of these at a time. The watch also
                # cancels waits aggressively (every arm/activation), so poll
                # the connection for EOF instead of blind time.sleep(0.5) —
                # an aborted wait then frees this thread within one tick
                # instead of pinning it for the full hold.
                while time.time() < deadline:
                    if turns.last_reply is not None:
                        if after_seq is not None:
                            if turns.turn_seq > after_seq:
                                return self._send(200, self._reply_payload())
                        elif turns.last_completed_at >= since:
                            return self._send(200, self._reply_payload())
                    try:
                        r, _, _ = select.select([self.connection], [], [], 0.5)
                        if r and self.connection.recv(1, socket.MSG_PEEK) == b"":
                            return  # client disconnected; free the thread quietly
                    except OSError:
                        return
                return self._send(202, {"reply": None, "partial": True, "error": "wait_timeout"})
            if self.path == "/suggest" or self.path.startswith("/suggest?"):
                qs = self._query()
                try:
                    after_seq = int(qs.get("after_seq", "0"))
                except ValueError:
                    after_seq = 0
                try:
                    hold = max(1.0, min(float(qs.get("timeout", "25")), 60.0))
                except ValueError:
                    hold = 25.0
                deadline = time.time() + hold
                # Same select()-based EOF poll as /wait: the watch cancels
                # these aggressively, and an aborted poll must free the thread
                # within a tick instead of pinning it for the full hold.
                while time.time() < deadline:
                    snap = turns.last_suggestion
                    if snap and snap.get("turn_seq", 0) > after_seq:
                        return self._send(200, {
                            "suggestion": snap.get("suggestion"),
                            "turn_seq": snap.get("turn_seq"),
                        })
                    try:
                        r, _, _ = select.select([self.connection], [], [], 0.5)
                        if r and self.connection.recv(1, socket.MSG_PEEK) == b"":
                            return  # client disconnected; free the thread quietly
                    except OSError:
                        return
                return self._send(202, {
                    "suggestion": None,
                    "turn_seq": turns.turn_seq,
                    "error": "wait_timeout",
                })
            if self.path == "/usage":
                return self._send(*usage.fetch())
            if self.path == "/sessions":
                return self._send(200, {
                    "sessions": [directory.public(s) for s in directory.list_sessions()]
                })
            m = SESSION_MESSAGES_RE.match(self.path)
            if m:
                limit = 30
                for part in (m.group(2) or "").split("&"):
                    if part.startswith("limit="):
                        try:
                            limit = max(1, min(200, int(part[len("limit="):])))
                        except ValueError:
                            pass
                return self._send(*directory.messages(m.group(1), limit))
            self._send(404, {"error": "not_found"})

        def do_POST(self):
            if not self._authed():
                return self._send(401, {"error": "unauthorized"})
            if self.path == "/reset":
                return self._send(*turns.reset())
            if self.path == "/chat":
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    body = json.loads(self.rfile.read(length) or b"{}")
                    message = body.get("message", "")
                except (ValueError, json.JSONDecodeError):
                    return self._send(400, {"error": "bad_json"})
                if not isinstance(message, str) or not message.strip():
                    return self._send(400, {"error": "empty_message"})
                return self._send(*turns.run_turn(message.strip(), REPLY_BUDGET_S))
            if self.path == "/command":
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    body = json.loads(self.rfile.read(length) or b"{}")
                    command = body.get("command", "")
                except (ValueError, json.JSONDecodeError):
                    return self._send(400, {"error": "bad_json"})
                if not isinstance(command, str):
                    return self._send(400, {"error": "bad_command"})
                command = command.strip()
                if "\n" in command or "\r" in command:
                    return self._send(400, {"error": "bad_command"})
                if not any(
                    command == p or command.startswith(p + " ")
                    for p in COMMAND_ALLOWLIST
                ):
                    return self._send(400, {"error": "command_not_allowed"})
                # A real non-blocking acquire (not a TOCTOU .locked() peek) so
                # a concurrent POST /chat can't slip in between the check and
                # the send and interleave its paste into this composer.
                if not turns.busy.acquire(blocking=False):
                    return self._send(409, {"error": "turn_in_flight"})
                try:
                    guard.guard()
                    try:
                        session.send(command)
                    except (OSError, RuntimeError) as e:
                        return self._send(503, {"error": f"send_failed: {e}"})
                    # The submit nudge fires 0.8s later, outside any turn lock, so a
                    # respawn (auto-reset / watchdog / /reset) can swap the child in
                    # between. Pin it to the generation we just sent into so a
                    # deferred CR can't inject a stray submit into a fresh child.
                    sent_gen = session.current_gen()
                    timer = threading.Timer(0.8, lambda: session.nudge_submit(sent_gen))
                    timer.daemon = True
                    timer.start()
                    sticky.remember(command)
                    log(f"slash command sent: {command}")
                    return self._send(200, {"ok": True, "command": command})
                finally:
                    turns.busy.release()
            m = SESSION_SEND_RE.match(self.path)
            if m:
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                    body = json.loads(self.rfile.read(length) or b"{}")
                    message = body.get("message", "")
                except (ValueError, json.JSONDecodeError):
                    return self._send(400, {"error": "bad_json"})
                if not isinstance(message, str) or not message.strip():
                    return self._send(400, {"error": "empty_message"})
                return self._send(*directory.send(m.group(1), message.strip()))
            self._send(404, {"error": "not_found"})

    return Handler


# ---------------------------------------------------------------- main


def watchdog(session, turns):
    """Auto-respawn the child if it dies outside an intentional respawn."""
    backoff = 2
    while True:
        time.sleep(1)
        if not session.alive:
            if turns.busy.locked():
                # let the in-flight turn's wait loop notice and finish first
                time.sleep(1)
                continue
            log(f"watchdog: child dead, respawning in {backoff}s")
            time.sleep(backoff)
            backoff = min(backoff * 2, 60)
            try:
                session.spawn()
            except Exception as e:
                log(f"watchdog: respawn failed: {e}")
                continue
            time.sleep(5)
            if session.alive:
                backoff = 2


def main():
    token = read_token()
    claude = resolve_claude()
    bind = resolve_bind()
    if not VAULT:
        log("FATAL: WATCH_BRIDGE_VAULT is not set; point it at the directory "
            "the claude session should run in")
        sys.exit(1)
    if not os.path.isdir(VAULT):
        log(f"FATAL: vault not found: {VAULT}")
        sys.exit(1)
    os.makedirs(os.path.dirname(SIGNAL_PATH), exist_ok=True)

    log(f"watch-bridge starting: bind={bind}:{PORT} claude={claude}")
    session = ClaudeSession(claude)
    session.spawn()
    tailer = TranscriptTailer(session)
    turns = TurnManager(session, tailer)
    guard = SettingsGuard()
    sticky = StickyCommands(session, guard)
    directory = SessionDirectory(session, turns)
    usage = UsageFetcher()
    threading.Thread(target=watchdog, args=(session, turns), daemon=True).start()

    server = ThreadingHTTPServer(
        (bind, PORT),
        make_handler(token, session, turns, sticky, guard, directory, usage, time.time()),
    )
    emit_state("ready")
    log("listening")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            os.kill(session.pid, signal.SIGTERM)
        except OSError:
            pass


if __name__ == "__main__":
    main()
