#!/usr/bin/env python3
"""Stop-hook signal writer for the watch bridge.

Injected into the bridge's claude session via --settings hooks.Stop. Reads the
hook payload from stdin and atomically writes it (plus a wall-clock timestamp)
to /tmp/watch-bridge/stop_signal.json. The bridge treats a fresh mtime as an
end-of-turn signal, and uses the payload's session_id plus _signal_epoch only
to reject a Stop that belongs to another session or to an earlier turn; a
payload missing those fields falls back to the mtime alone, so schema drift
stays harmless.

Must always exit 0: a hook failure must never affect the claude turn.
"""
import json
import os
import sys
import time

SIGNAL_DIR = "/tmp/watch-bridge"
SIGNAL_PATH = os.path.join(SIGNAL_DIR, "stop_signal.json")

try:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        payload = {"raw": raw[:4096]}
    payload["_signal_epoch"] = time.time()
    os.makedirs(SIGNAL_DIR, exist_ok=True)
    tmp = SIGNAL_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, SIGNAL_PATH)
except Exception:
    pass
sys.exit(0)
