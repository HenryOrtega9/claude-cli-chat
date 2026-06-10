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
  POST /command {"command": str} -> 200 {ok}. Fire-and-forget slash command
                 (allowlist: /model, /effort). These run locally in the CLI
                 and produce no assistant turn, so they bypass the turn
                 machinery entirely. Sticky: replayed after respawns.
  POST /reset  -> kill + respawn the claude child (fresh session)
  GET  /health -> {state, session_id, session_file, child_pid, uptime_s}
  GET  /sessions -> {sessions: [{id, kind, name, cwd, attach, pid,
                 last_activity, preview}]}. Every live claude process on this
                 Mac mapped to its JSONL transcript. attach: "bridge" (this
                 daemon's child), "tmux:<target>" (injectable via send-keys,
                 e.g. vault-cc), or null (view-only).
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
  WATCH_BRIDGE_VAULT           default: Henry's Second Brain vault path
  WATCH_BRIDGE_CLAUDE          default: `claude` resolved from an enriched PATH
  WATCH_BRIDGE_REPLY_BUDGET_S  default 90
  Token file: ~/.config/watch-bridge/token (chmod 600)

State changes mirror to /tmp/claude_state (same token format as the plugin's
StateEmitter) so the TC001 animator reflects watch activity for free.
"""
import fcntl
import hmac
import json
import os
import pty
import re
import select
import shutil
import signal
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
DEFAULT_VAULT = (
    HOME
    + "/Library/Mobile Documents/iCloud~md~obsidian/Documents/"
    + "Henry Ortega's Second Brain"
)
TOKEN_PATH = HOME + "/.config/watch-bridge/token"
SIGNAL_PATH = "/tmp/watch-bridge/stop_signal.json"
STATE_TOKEN_PATH = "/tmp/claude_state"
STOP_HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "stop_hook.py")
TAILSCALE_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"

PORT = int(os.environ.get("WATCH_BRIDGE_PORT", "8787"))
BIND = os.environ.get("WATCH_BRIDGE_BIND", "")
VAULT = os.environ.get("WATCH_BRIDGE_VAULT", DEFAULT_VAULT)
REPLY_BUDGET_S = float(os.environ.get("WATCH_BRIDGE_REPLY_BUDGET_S", "90"))
IDLE_FALLBACK_S = 15.0
JSONL_AUTO_RESET_BYTES = 4 * 1024 * 1024
SETTLE_S = 3.0

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
                return
            try:
                rlist, _, _ = select.select([fd], [], [], 0.1)
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
        if gen == self._gen:
            self.alive = False
            log(f"claude child pid={pid} exited")
            try:
                os.close(fd)
            except OSError:
                pass
        # reap if we broke out of the loop on EOF before waitpid saw the exit
        try:
            os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            pass

    def _handle_output(self, chunk, fd):
        self.stdout_tail = (self.stdout_tail + strip_ansi(chunk))[-65536:]
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
            if self.session_id:
                candidate = os.path.join(proj, f"{self.session_id}.jsonl")
                if os.path.exists(candidate):
                    self._adopt(candidate)
                    return
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

    def send(self, text):
        """Bracketed paste so dictated newlines don't submit early, settle,
        then CR to submit."""
        if not self.ready():
            raise RuntimeError("session not ready")
        if self.first_send_epoch is None:
            self.first_send_epoch = time.time()
        fd = self.fd
        os.write(fd, b"\x1b[200~" + text.encode() + b"\x1b[201~")
        time.sleep(0.2)
        os.write(fd, b"\r")

    def respawn(self):
        with self.lock:
            pid = self.pid
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
            path = self.session.session_file
            with self.lock:
                if path != self.path:
                    self._reset(path or "")
            if path:
                try:
                    self._read_new(path)
                except OSError:
                    pass
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


# ---------------------------------------------------------------- turn manager


class TurnManager:
    def __init__(self, session, tailer):
        self.session = session
        self.tailer = tailer
        self.busy = threading.Lock()
        self.last_reply = None
        self.last_session_id = None

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

            done = threading.Event()
            result = {}

            def wait_for_completion():
                try:
                    nudged = False
                    while True:
                        if self._stop_signaled(start) or self.tailer.idle_complete(mark):
                            break
                        if not self.session.alive:
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
                            try:
                                os.write(self.session.fd, b"\r")
                            except OSError:
                                pass
                        if not landed and waited > 45:
                            log("turn: message never landed in transcript, aborting turn")
                            break
                        if waited > budget_s * 4:
                            log("turn: absolute ceiling reached, aborting turn")
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
                    self.last_reply = {
                        "reply": reply,
                        "session_id": self.session.session_id,
                        "elapsed_ms": int((time.time() - start) * 1000),
                        "partial": False,
                    }
                    emit_state("complete")
                finally:
                    done.set()
                    self.busy.release()

            threading.Thread(target=wait_for_completion, daemon=True).start()
            if done.wait(timeout=budget_s):
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


def extract_messages(path, limit=30):
    """Last `limit` user/assistant text messages from a session JSONL. Reads
    only the file tail (256KB) so huge transcripts stay cheap. Tool results,
    meta records, and harness-injected user content are skipped."""
    try:
        size = os.stat(path).st_size
    except OSError:
        return []
    msgs = []
    try:
        with open(path, "rb") as f:
            if size > 262144:
                f.seek(size - 262144)
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
    return msgs[-limit:]


class SessionDirectory:
    """Discovers live `claude` processes on this Mac and maps each one to its
    session JSONL, so the watch can list and read any active conversation
    (vault-cc remote-control sessions included). Input routing: the bridge's
    own PTY child is attachable natively; a claude running inside a tmux pane
    is attachable via `tmux send-keys`; anything else is view-only."""

    CACHE_S = 5.0

    def __init__(self, session, turns):
        self.session = session
        self.turns = turns
        self.lock = threading.Lock()
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

    def _session_file_for(self, cwd, start_epoch, exclude=None):
        """Newest JSONL in the project slug born after the process started.
        Same heuristic the plugin uses; ambiguous only when two sessions start
        in the same cwd within seconds of each other."""
        proj = project_dir_for(cwd)
        floor = (start_epoch or 0) - 5
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
                sessions.append({
                    "id": self.session.session_id or "watch",
                    "kind": "watch",
                    "name": "Watch session",
                    "cwd": VAULT,
                    "file": own_file,
                    "attach": "bridge",
                    "pid": pid,
                })
                continue
            cwd = self._cwd_of(pid)
            if not cwd:
                continue
            start = self._start_epoch(pid)
            file = self._session_file_for(cwd, start, exclude=own_file)
            target = tmux_target(pid)
            kind = "remote-control" if "remote-control" in command else "terminal"
            name = os.path.basename(cwd)
            m = re.search(r"--remote-control\s+(.+)$", command)
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
                tail = extract_messages(s["file"], limit=1)
                if tail:
                    s["preview"] = tail[-1]["text"][:120]
        with self.lock:
            self._cached_at = time.time()
            self._sessions = sessions
            self._by_id = {s["id"]: s for s in sessions}
        return sessions

    def list_sessions(self):
        with self.lock:
            fresh = time.time() - self._cached_at < self.CACHE_S
            cached = list(self._sessions)
        return cached if fresh else self.refresh()

    def resolve(self, sid):
        with self.lock:
            fresh = time.time() - self._cached_at < self.CACHE_S
            hit = self._by_id.get(sid)
        # A hit without a transcript yet (or a stale cache) gets re-scanned so
        # the session file is picked up as soon as it exists.
        if hit and fresh and hit.get("file"):
            return hit
        self.refresh()
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

    def __init__(self):
        self.lock = threading.Lock()
        self._cached_at = 0.0
        self._cached = None
        self._ctx = _https_context()

    def fetch(self):
        with self.lock:
            if self._cached is not None and time.time() - self._cached_at < self.CACHE_S:
                return 200, self._cached
            creds = self._load_creds()
            if not creds or not creds.get("accessToken"):
                return 503, {"error": "usage_credentials_missing"}
            if self._needs_refresh(creds):
                creds = self._refresh(creds) or creds
            code, payload = self._get_usage(creds["accessToken"])
            if code == 401:
                creds = self._refresh(creds)
                if not creds:
                    return 503, {"error": "usage_auth_expired"}
                code, payload = self._get_usage(creds["accessToken"])
            if code == 200:
                self._cached_at = time.time()
                self._cached = payload
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
                return time.mktime(time.strptime(value, fmt)) - time.timezone
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

    def _refresh(self, creds):
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
            log(f"usage token refresh failed: {e}")
            return None
        access = data.get("access_token")
        if not access:
            return None
        expires_in = data.get("expires_in") or 3600
        updated = {
            "accessToken": access,
            "refreshToken": data.get("refresh_token") or refresh_token,
            "expiresAt": time.strftime(
                "%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + float(expires_in))
            ),
            "scopes": scopes,
        }
        try:
            tmp = self.CRED_PATH + ".watch-bridge.tmp"
            with open(tmp, "w") as f:
                json.dump(updated, f, indent=2)
                f.write("\n")
            os.chmod(tmp, 0o600)
            os.replace(tmp, self.CRED_PATH)
            log("usage token refreshed")
        except OSError as e:
            log(f"usage credentials save failed: {e}")
        return updated


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
            for cmd in pending:
                self.guard.guard()
                try:
                    self.session.send(cmd)
                    log(f"replayed sticky command: {cmd}")
                    time.sleep(1.0)
                except (OSError, RuntimeError) as e:
                    log(f"sticky replay failed for {cmd}: {e}")


SESSION_MESSAGES_RE = re.compile(r"^/sessions/([A-Za-z0-9._-]+)/messages(?:\?(.*))?$")
SESSION_SEND_RE = re.compile(r"^/sessions/([A-Za-z0-9._-]+)/send$")


def make_handler(token, session, turns, sticky, guard, directory, usage, started_at):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            log(f"http {self.address_string()} {fmt % args}")

        def _authed(self):
            header = self.headers.get("Authorization", "")
            supplied = header[7:] if header.startswith("Bearer ") else ""
            return hmac.compare_digest(supplied, token)

        def _send(self, code, payload):
            body = json.dumps(payload).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

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
                return self._send(200, turns.last_reply)
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
                if turns.busy.locked():
                    return self._send(409, {"error": "turn_in_flight"})
                guard.guard()
                try:
                    session.send(command)
                except (OSError, RuntimeError) as e:
                    return self._send(503, {"error": f"send_failed: {e}"})
                sticky.remember(command)
                log(f"slash command sent: {command}")
                return self._send(200, {"ok": True, "command": command})
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
