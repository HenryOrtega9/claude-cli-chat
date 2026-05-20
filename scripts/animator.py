#!/usr/bin/env python3
"""
TC001 animator daemon for the Claude Code status display (v1, 2026-05-17).

Reads the current state from /tmp/claude_state (set by the plugin's
StateEmitter), renders per-frame Awtrix `draw` arrays matching the v1 design
locked in screens/preview.html, and enqueues them to a background pusher
thread that POSTs to the Ulanzi TC001 via Awtrix's /api/custom endpoint at
~100ms cadence (10 FPS). The pusher owns one keep-alive requests.Session,
de-dupes identical consecutive frames, and discards frames during the
periodic battery-flash window.

Also handles the 60s ready→idle inactivity timeout: when the state has been
"ready" for 60s with no new state-emitter event, the daemon writes "idle"
back into the state-token file (which it then picks up on the next poll).

The daemon is idempotent and stateless — all timing derives from the
state-token's epoch timestamp plus the system clock, so a restart picks up
exactly where it left off.

Usage:
  animator.py                              run as daemon, push to $TC001_IP
  animator.py --preview                    print ASCII frames to stdout instead
  animator.py --once STATE                 push one frame of STATE then exit
  animator.py --state-file /path           override state-token path

Environment:
  TC001_IP        device IP (default: 192.168.12.126)

Dependencies:
  requests (pip install requests). If unavailable, --preview mode still works.
"""

from __future__ import annotations

import argparse
import math
import os
import sys
import threading
import time
from typing import List, Optional, Tuple

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

TC001_IP            = os.environ.get("TC001_IP", "192.168.12.126")
STATE_TOKEN_FILE    = "/tmp/claude_state"
PUSH_INTERVAL_MS    = 100          # 10 FPS; safe now that HTTP is off the render loop (background pusher thread)
READY_TIMEOUT_S     = 60           # ready → idle inactivity window
COMPLETE_TIMEOUT_S  = 10           # complete → ready; ready then times out to idle (walking crab default)
HTTP_TIMEOUT_S      = 0.5
W, H                = 32, 8
# Periodic battery flash: while idle, briefly /api/switch to the native Battery
# app, hold for BATTERY_FLASH_DURATION_S, then switch back to idle. Active states
# (thinking/needs_permission/complete/ready) are never interrupted.
BATTERY_FLASH_INTERVAL_S = int(os.environ.get("BATTERY_FLASH_INTERVAL_S", "300"))
BATTERY_FLASH_DURATION_S = int(os.environ.get("BATTERY_FLASH_DURATION_S", "4"))

VALID_STATES        = ("idle", "ready", "thinking", "needs_permission", "complete")
DEFAULT_STATE       = "idle"

# Palette (matches screens/preview.html)
CRAB_BODY_RGB       = (217, 119, 87)    # #D97757
CRAB_EYE_RGB        = (20, 14, 10)      # near-black
THINKING_RGB        = (70, 165, 225)    # #46A5E1 dusty blue
PERMISSION_RGB      = (255, 195, 60)    # #FFC33C amber gold
PERMISSION_CHEV_RGB = (217, 119, 87)    # coral (same as crab)
COMPLETE_RGB        = (120, 210, 130)   # #78D282 sage green
CREAM_RGB           = (250, 244, 230)   # #FAF4E6 ready scanner / text
HEADPHONE_RGB       = (100, 120, 180)   # desaturated blue for the dance headphones
NOTE_RGB            = (250, 244, 230)   # cream music notes (contrast against headphones)
ORB_RGB             = (255, 220, 130)   # warm yellow firefly companion
STAR_RGB            = (250, 244, 230)   # cream stars (same hex as CREAM_RGB, semantic alias)
CUSHION_RGB         = (140, 95, 70)     # warm brown cushion for the rest vignette
UMBRELLA_RGB        = (60, 100, 140)    # dark teal umbrella canopy
RAIN_RGB            = (120, 170, 210)   # pale blue rain drops

# ---------------------------------------------------------------------------
# Sprite data (mirrors screens/preview.html exactly)
# ---------------------------------------------------------------------------

# 13x8 Claude crab. 0 = off, 1 = body, 2 = eye
CRAB_BIG = [
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,2,1,1,1,1,1,2,1,0,0],
    [1,1,1,1,1,1,1,1,1,1,1,1,1],
    [1,1,1,1,1,1,1,1,1,1,1,1,1],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,1,1,1,1,1,1,1,1,0,0],
    [0,0,1,0,1,0,0,0,1,0,1,0,0],
    [0,0,1,0,1,0,0,0,1,0,1,0,0],
]

# 8x5 walking crab body (legs drawn separately per-frame)
CRAB_SMALL_BODY = [
    [0,1,1,1,1,1,1,0],
    [1,1,2,1,1,2,1,1],
    [0,1,1,1,1,1,1,0],
]
SMALL_LEG_FRAMES = [
    [1, 2],         # frame A: left pair grounded
    [5, 6],         # frame B: right pair grounded
    [1, 2, 5, 6],   # frame R: resting, all four planted (used during pause)
]

# 3x4 sleeping-Z shape (idle pause)
Z_SHAPE = [
    [1,1,1],
    [0,0,1],
    [1,0,0],
    [1,1,1],
]

# 3x5 font (subset of preview.html's font3x5 — only the glyphs we need for
# thinking verbs and the DONE!/READY words).
FONT_3X5 = {
    'A': [[0,1,0],[1,0,1],[1,1,1],[1,0,1],[1,0,1]],
    'B': [[1,1,0],[1,0,1],[1,1,0],[1,0,1],[1,1,0]],
    'C': [[1,1,1],[1,0,0],[1,0,0],[1,0,0],[1,1,1]],
    'D': [[1,1,0],[1,0,1],[1,0,1],[1,0,1],[1,1,0]],
    'E': [[1,1,1],[1,0,0],[1,1,0],[1,0,0],[1,1,1]],
    'G': [[0,1,1],[1,0,0],[1,0,1],[1,0,1],[0,1,1]],
    'H': [[1,0,1],[1,0,1],[1,1,1],[1,0,1],[1,0,1]],
    'I': [[1,1,1],[0,1,0],[0,1,0],[0,1,0],[1,1,1]],
    'K': [[1,0,1],[1,0,1],[1,1,0],[1,0,1],[1,0,1]],
    'L': [[1,0,0],[1,0,0],[1,0,0],[1,0,0],[1,1,1]],
    'M': [[1,0,1],[1,1,1],[1,0,1],[1,0,1],[1,0,1]],
    'N': [[1,0,1],[1,1,1],[1,1,1],[1,0,1],[1,0,1]],
    'O': [[1,1,1],[1,0,1],[1,0,1],[1,0,1],[1,1,1]],
    'P': [[1,1,0],[1,0,1],[1,1,0],[1,0,0],[1,0,0]],
    'R': [[1,1,0],[1,0,1],[1,1,0],[1,0,1],[1,0,1]],
    'S': [[0,1,1],[1,0,0],[0,1,0],[0,0,1],[1,1,0]],
    'T': [[1,1,1],[0,1,0],[0,1,0],[0,1,0],[0,1,0]],
    'U': [[1,0,1],[1,0,1],[1,0,1],[1,0,1],[1,1,1]],
    'V': [[1,0,1],[1,0,1],[1,0,1],[1,0,1],[0,1,0]],
    'W': [[1,0,1],[1,0,1],[1,0,1],[1,1,1],[1,0,1]],
    'Y': [[1,0,1],[1,0,1],[0,1,0],[0,1,0],[0,1,0]],
    '.': [[0],[0],[0],[0],[1]],
    '!': [[1],[1],[1],[0],[1]],
}

THINKING_VERBS = [
    "PONDERING...", "CRUNCHING...", "BREWING...", "COGITATING...", "MULLING...",
    "HATCHING...", "CONJURING...", "NOODLING...", "PERCOLATING...", "DIVINING...",
    "SIMMERING...", "VIBING...",
]

# ---------------------------------------------------------------------------
# Frame buffer (RGB grid). Awtrix has no alpha so we composite into RGB here
# before emitting draw commands.
# ---------------------------------------------------------------------------

class Frame:
    def __init__(self) -> None:
        self.pixels: List[List[Tuple[int, int, int]]] = [
            [(0, 0, 0) for _ in range(W)] for _ in range(H)
        ]

    def put(self, x: int, y: int, rgb: Tuple[int, int, int], alpha: float = 1.0) -> None:
        if x < 0 or x >= W or y < 0 or y >= H:
            return
        if alpha >= 1.0:
            self.pixels[y][x] = rgb
        elif alpha <= 0.0:
            return
        else:
            # Pre-multiply against black background (Awtrix has no alpha).
            r, g, b = rgb
            self.pixels[y][x] = (int(r * alpha), int(g * alpha), int(b * alpha))

    def to_draw_array(self) -> list:
        """Convert the frame buffer into an Awtrix `draw` array.

        AWTRIX 3 rejects POSTs to /api/custom with HTTP 500 when the draw array
        exceeds ~100 items, so per-pixel `dp` emit blew past the cap for any
        non-trivial state (complete: 118, thinking: 115, ready: 105). Per-row
        run-length encoding into `df` (filled rect) primitives keeps the array
        well under 100 by collapsing horizontal runs of identical color into a
        single 1-row-tall rect.
        """
        # AWTRIX `draw` is sparse: cells not present in the new array retain
        # their previous value from prior pushes. Without a baseline clear,
        # pixels drift between frames (text fade-in pixels left over from the
        # previous cycle, etc.). Prepend a full-matrix black rect to force a
        # clean replace.
        cmds: list = [{"df": [0, 0, W, H, "#000000"]}]
        for y in range(H):
            x = 0
            while x < W:
                r, g, b = self.pixels[y][x]
                if (r, g, b) == (0, 0, 0):
                    x += 1
                    continue
                run_start = x
                run_color = (r, g, b)
                while x < W and self.pixels[y][x] == run_color:
                    x += 1
                run_len = x - run_start
                hex_color = f"#{run_color[0]:02X}{run_color[1]:02X}{run_color[2]:02X}"
                if run_len == 1:
                    cmds.append({"dp": [run_start, y, hex_color]})
                else:
                    cmds.append({"df": [run_start, y, run_len, 1, hex_color]})
        return cmds

    def to_ascii(self) -> str:
        """Render the frame as ASCII for terminal preview. Each pixel is a
        fixed-width 3-char cell so columns line up across rows."""
        rows = []
        for y in range(H):
            row = ""
            for x in range(W):
                r, g, b = self.pixels[y][x]
                brightness = (r + g + b) / 3
                if   brightness == 0:   row += " . "
                elif brightness < 30:   row += " : "
                elif brightness < 110:  row += ":: "
                elif brightness < 180:  row += "** "
                else:                   row += "## "
            rows.append(row)
        return "\n".join(rows)


# ---------------------------------------------------------------------------
# Sprite drawing helpers (mirror the JS versions exactly)
# ---------------------------------------------------------------------------

def draw_crab_big(f: Frame, ox: int, oy: int, alpha: float = 1.0,
                  left_arm_up: bool = False, right_arm_up: bool = False,
                  blinking: bool = False) -> None:
    for y in range(8):
        for x in range(13):
            v = CRAB_BIG[y][x]
            if y == 3:
                if left_arm_up and x in (0, 1): v = 0
                if right_arm_up and x in (11, 12): v = 0
            if v == 1:
                f.put(ox + x, oy + y, CRAB_BODY_RGB, alpha)
            elif v == 2:
                color = CRAB_BODY_RGB if blinking else CRAB_EYE_RGB
                f.put(ox + x, oy + y, color, alpha)
    if left_arm_up:
        f.put(ox + 0, oy + 1, CRAB_BODY_RGB, alpha)
        f.put(ox + 1, oy + 1, CRAB_BODY_RGB, alpha)
    if right_arm_up:
        f.put(ox + 11, oy + 1, CRAB_BODY_RGB, alpha)
        f.put(ox + 12, oy + 1, CRAB_BODY_RGB, alpha)


def draw_crab_small(f: Frame, ox: int, oy: int, leg_frame: int,
                    blinking: bool = False, draw_legs: bool = True) -> None:
    for y in range(3):
        for x in range(8):
            v = CRAB_SMALL_BODY[y][x]
            if v == 1:
                f.put(ox + x, oy + y, CRAB_BODY_RGB)
            elif v == 2:
                f.put(ox + x, oy + y, CRAB_BODY_RGB if blinking else CRAB_EYE_RGB)
    if draw_legs:
        for lx in SMALL_LEG_FRAMES[leg_frame]:
            f.put(ox + lx, oy + 3, CRAB_BODY_RGB)


def draw_z(f: Frame, x: int, y: int, rgb: Tuple[int, int, int], alpha: float) -> None:
    for r in range(len(Z_SHAPE)):
        for c in range(len(Z_SHAPE[r])):
            if Z_SHAPE[r][c]:
                f.put(x + c, y + r, rgb, alpha)


def glyph_width(ch: str) -> int:
    g = FONT_3X5.get(ch)
    return len(g[0]) if g else 3


def text_width(text: str) -> int:
    if not text:
        return 0
    w = 0
    for ch in text:
        w += glyph_width(ch) + 1
    return w - 1


def render_text(f: Frame, text: str, x0: int, y0: int, rgb: Tuple[int, int, int],
                alpha: float = 1.0, x_min: int = 0, x_max: int = W) -> None:
    x = x0
    for ch in text:
        glyph = FONT_3X5.get(ch)
        if glyph:
            gw = len(glyph[0])
            for r in range(5):
                for c in range(gw):
                    if glyph[r][c]:
                        xx = x + c
                        if x_min <= xx < x_max:
                            f.put(xx, y0 + r, rgb, alpha)
            x += gw + 1
        else:
            x += 4


# ---------------------------------------------------------------------------
# State renderers — t is milliseconds since some epoch (we use monotonic ms)
# ---------------------------------------------------------------------------

def render_idle(t: float) -> Frame:
    f = Frame()
    CRAB_SMALL_W = 8

    step_duration   = 220
    blink_interval  = 5300; blink_duration = 200
    jump_interval   = 13000; jump_duration  = 1100
    # Pause every 7 s for 3.5 s. With 6 vignettes the full rotation is 42 s,
    # so a casual glance at the display catches every scenario within a minute.
    pause_interval  = 7000;  pause_duration = 3500
    jump_height     = 3

    pause_cycle_pos      = t % pause_interval
    in_pause             = pause_cycle_pos < pause_duration
    completed_pauses     = t // pause_interval
    pause_time_so_far    = completed_pauses * pause_duration + min(pause_cycle_pos, pause_duration)
    walk_time            = t - pause_time_so_far

    # Pause behavior rotates through six vignettes so the idle screen has
    # more personality than a single sleep loop. Each vignette repeats every
    # 42 s on average (7 s * 6 vignettes).
    PAUSE_BEHAVIORS = ("sleep", "dance", "visit", "stargaze", "rest", "rain")
    pause_kind: Optional[str] = None
    if in_pause:
        pause_kind = PAUSE_BEHAVIORS[int(completed_pauses) % len(PAUSE_BEHAVIORS)]

    step       = int(walk_time // step_duration)
    max_x      = W - CRAB_SMALL_W
    cycle_steps = max_x * 2
    phase      = step % cycle_steps
    x          = phase if phase < max_x else cycle_steps - phase

    if pause_kind == "dance":
        leg_frame = int(pause_cycle_pos // 150) % 2  # fast tap-dance
    elif in_pause:
        leg_frame = 2  # all four planted (sleep / visit)
    else:
        leg_frame = step % 2  # normal walk

    jump_cycle_pos = walk_time % jump_interval
    in_jump        = (jump_cycle_pos < jump_duration) and not in_pause
    dy = 3
    if in_jump:
        jt = jump_cycle_pos / jump_duration
        lift = 4 * jump_height * jt * (1 - jt)
        dy = 3 - round(lift)
    elif pause_kind == "dance":
        # Subtle 1 px bounce every 300 ms (the crab bobbing to the beat).
        dy = 2 if (int(pause_cycle_pos // 300) % 2 == 0) else 3

    blink_cycle_pos = walk_time % blink_interval
    # Eyes open for dance and visit so the crab "engages"; only the sleep
    # vignette inherits the pause-blink closed-eye effect.
    blinking = (blink_cycle_pos < blink_duration) or (pause_kind == "sleep")

    # Rain falls BEHIND the crab so the body naturally overdraws any drops
    # that would otherwise pass through it.
    if pause_kind == "rain":
        cx_rain = int(x)
        DROP_XS = (2, 7, 13, 18, 24, 29)
        DROP_PERIOD = 700
        for i, drop_x in enumerate(DROP_XS):
            offset = i * DROP_PERIOD / len(DROP_XS)
            drop_phase = ((pause_cycle_pos + offset) % DROP_PERIOD) / DROP_PERIOD
            drop_y = drop_phase * (H + 2) - 2
            drop_y_int = int(round(drop_y))
            # Umbrella canopy spans cols cx..cx+7 at rows 0-1; drops in that
            # x range are caught and don't render below row 0.
            in_umbrella_x = cx_rain <= drop_x <= cx_rain + 7
            if in_umbrella_x and drop_y_int >= 0:
                continue
            if 0 <= drop_y_int <= 7:
                f.put(drop_x, drop_y_int,     RAIN_RGB, 0.85)
                if drop_y_int > 0:
                    f.put(drop_x, drop_y_int - 1, RAIN_RGB, 0.30)

    if pause_kind == "rest":
        # Sit down: body drops 1 px, legs tuck under (not drawn), cushion below.
        draw_crab_small(f, int(x), 4, leg_frame, blinking, draw_legs=False)
    else:
        draw_crab_small(f, int(x), dy, leg_frame, blinking)

    if pause_kind == "sleep":
        # Z's float up and fade, in dusty blue (dreamy).
        z_cycle = 1600
        num_zs = 2
        for i in range(num_zs):
            z_phase = ((pause_cycle_pos + i * z_cycle / num_zs) % z_cycle) / z_cycle
            sx, sy = x + 6, 1
            ex, ey = x + 10, -3
            zx = round(sx + (ex - sx) * z_phase)
            zy = round(sy + (ey - sy) * z_phase)
            za = (1 - z_phase) * 0.9
            draw_z(f, zx, zy, THINKING_RGB, za)

    elif pause_kind == "dance":
        # Headphones on the crab's head + music notes drifting up and fading.
        cx = int(x)
        # Band one row above the body top (moves with the bounce).
        for hx in range(1, 7):
            f.put(cx + hx, dy - 1, HEADPHONE_RGB)
        # Earcups in the empty corners of the head row.
        f.put(cx + 0, dy, HEADPHONE_RGB)
        f.put(cx + 7, dy, HEADPHONE_RGB)
        # Music notes: a 2x2 head + 1 px stem, rising and fading from both
        # sides of the crab on a 1.4 s cycle.
        note_cycle = 1400
        num_notes = 3
        for i in range(num_notes):
            note_phase = ((pause_cycle_pos + i * note_cycle / num_notes) % note_cycle) / note_cycle
            side = 1 if i % 2 == 0 else -1
            note_x = cx + (9 if side > 0 else -2)
            note_y_start = dy - 1
            note_y_end   = -3
            note_y = round(note_y_start + (note_y_end - note_y_start) * note_phase)
            a = (1 - note_phase) * 0.9
            f.put(note_x,     note_y,     NOTE_RGB, a)
            f.put(note_x + 1, note_y,     NOTE_RGB, a)
            f.put(note_x,     note_y + 1, NOTE_RGB, a * 0.7)
            f.put(note_x + 1, note_y + 1, NOTE_RGB, a * 0.7)
            f.put(note_x + 1, note_y - 1, NOTE_RGB, a * 0.5)

    elif pause_kind == "visit":
        # A glowing firefly drifts in from whichever side has more room,
        # hovers next to the crab while pulsing brighter, then drifts up
        # and away as it fades out.
        cx = int(x)
        crab_center_x = cx + 4
        from_left = crab_center_x > W // 2
        orb_start_x = 0 if from_left else (W - 1)
        orb_meet_x  = (cx - 2) if from_left else (cx + 9)

        pcp = pause_cycle_pos
        if pcp < 1500:
            # Drift in along row 2.
            pt = pcp / 1500
            orb_x = orb_start_x + (orb_meet_x - orb_start_x) * pt
            orb_y = 2
            orb_glow = 0.50 + 0.15 * math.sin(pcp / 110)
        elif pcp < 2000:
            # Hover next to the crab and pulse brighter for ~0.5 s.
            orb_x = orb_meet_x
            orb_y = 2
            orb_glow = 0.85 + 0.10 * math.sin((pcp - 1500) / 80)
        else:
            # Drift up and away over the last 1.5 s.
            pt = (pcp - 2000) / 1500
            orb_x = orb_meet_x + (2 if from_left else -2) * pt
            orb_y = 2 - 5 * pt
            orb_glow = (1 - pt) * 0.85

        ox = int(round(orb_x))
        oy = int(round(orb_y))
        # Core pixel + 4-neighbor halo at lower alpha.
        f.put(ox, oy, ORB_RGB, min(1.0, orb_glow * 1.2))
        halo = orb_glow * 0.35
        f.put(ox - 1, oy,     ORB_RGB, halo)
        f.put(ox + 1, oy,     ORB_RGB, halo)
        f.put(ox,     oy - 1, ORB_RGB, halo)
        f.put(ox,     oy + 1, ORB_RGB, halo)

    elif pause_kind == "stargaze":
        # Crab stands still; five stars twinkle at fixed positions above,
        # and a shooting star streaks across the top mid-vignette.
        STAR_POSITIONS = ((4, 0), (11, 1), (17, 0), (23, 2), (29, 1))
        for idx, (sx, sy) in enumerate(STAR_POSITIONS):
            phase = pause_cycle_pos / 220 + idx * 1.4
            alpha = 0.30 + 0.55 * (0.5 + 0.5 * math.sin(phase))
            f.put(sx, sy, STAR_RGB, alpha)
        # Shooting star: 700 ms streak from left to right, head + 2 px tail.
        if 1400 <= pause_cycle_pos < 2100:
            st = (pause_cycle_pos - 1400) / 700
            head_x = round(st * (W + 3)) - 2
            head_y = 0
            f.put(head_x,     head_y, STAR_RGB, 1.00)
            f.put(head_x - 1, head_y, STAR_RGB, 0.55)
            f.put(head_x - 2, head_y, STAR_RGB, 0.25)

    elif pause_kind == "rest":
        # A small brown cushion sits below the lowered crab (drawn above
        # with draw_legs=False). Cushion fades in for the first 400 ms and
        # out for the last 400 ms so it doesn't pop.
        cx = int(x)
        if pause_cycle_pos < 400:
            cushion_alpha = pause_cycle_pos / 400
        elif pause_cycle_pos > (pause_duration - 400):
            cushion_alpha = (pause_duration - pause_cycle_pos) / 400
        else:
            cushion_alpha = 1.0
        for hx in range(2, 6):
            f.put(cx + hx, 7, CUSHION_RGB, cushion_alpha)

    elif pause_kind == "rain":
        # Umbrella above the crab. Rendered AFTER the body so the canopy
        # sits in front. Fades in/out at the edges so it doesn't pop.
        cx = int(x)
        if pause_cycle_pos < 400:
            umb_alpha = pause_cycle_pos / 400
        elif pause_cycle_pos > (pause_duration - 400):
            umb_alpha = (pause_duration - pause_cycle_pos) / 400
        else:
            umb_alpha = 1.0
        # Row 0: 4 px peak.
        for hx in range(2, 6):
            f.put(cx + hx, 0, UMBRELLA_RGB, umb_alpha)
        # Row 1: 8 px brim (overhangs both sides of the body).
        for hx in range(0, 8):
            f.put(cx + hx, 1, UMBRELLA_RGB, umb_alpha)
        # Row 2: 1 px handle that meets the top of the head.
        f.put(cx + 3, 2, UMBRELLA_RGB, umb_alpha)

    return f


def render_ready(t: float) -> Frame:
    f = Frame()
    CRAB_LEFT  = 10
    CRAB_RIGHT = CRAB_LEFT + 13 - 1   # col 22

    # Outward-radiating comets
    spawn_interval = 1500
    comet_speed    = 250
    max_age        = 3000
    scanner_y      = 4
    left_spawn     = CRAB_LEFT - 1     # col 9
    right_spawn    = CRAB_RIGHT + 1    # col 23

    latest_spawn_idx   = int(t // spawn_interval)
    oldest_still_alive = int((t - max_age) // spawn_interval)
    for idx in range(oldest_still_alive, latest_spawn_idx + 1):
        age = t - idx * spawn_interval
        if age < 0 or age > max_age:
            continue
        cols_traveled = age / comet_speed
        left_head_x  = round(left_spawn  - cols_traveled)
        right_head_x = round(right_spawn + cols_traveled)
        f.put(left_head_x,     scanner_y, CREAM_RGB, 1.00)
        f.put(left_head_x + 1, scanner_y, CREAM_RGB, 0.45)
        f.put(left_head_x + 2, scanner_y, CREAM_RGB, 0.18)
        f.put(right_head_x,     scanner_y, CREAM_RGB, 1.00)
        f.put(right_head_x - 1, scanner_y, CREAM_RGB, 0.45)
        f.put(right_head_x - 2, scanner_y, CREAM_RGB, 0.18)

    # Crab on top (covers any scanner pixels in its footprint)
    blink_cycle, blink_duration = 5000, 200
    blinking = (t % blink_cycle) < blink_duration
    draw_crab_big(f, CRAB_LEFT, 0, 1.0, blinking=blinking)
    return f


def render_thinking(t: float) -> Frame:
    f = Frame()
    ANIM_X0 = 14

    scratch_cycle = 2500
    scratch_phase = (t % scratch_cycle) / scratch_cycle
    right_arm_up  = 0.30 < scratch_phase < 0.70
    draw_crab_big(f, 0, 0, 1.0, right_arm_up=right_arm_up)

    # Pulsing dot at (12, 0)
    dot_pulse = 0.30 + 0.70 * (0.5 + 0.5 * math.sin(t / 250))
    f.put(12, 0, CRAB_BODY_RGB, dot_pulse)

    # Scrolling verb in dusty blue
    verb_duration = 3500
    verb_idx = int(t // verb_duration) % len(THINKING_VERBS)
    verb = THINKING_VERBS[verb_idx]
    verb_t = (t % verb_duration) / verb_duration
    w = text_width(verb)
    start_x = W
    end_x = ANIM_X0 - w
    x = round(start_x + (end_x - start_x) * verb_t)
    render_text(f, verb, x, 1, THINKING_RGB, 1.0, ANIM_X0, W)
    return f


def render_needs_permission(t: float) -> Frame:
    f = Frame()
    ANIM_X0 = 14

    shake = 1 if (int(t // 130) % 2) else -1
    draw_crab_big(f, shake, 0, 1.0)

    pulse = 0.35 + 0.65 * abs(math.sin(t / 240))
    ex_x = ANIM_X0 + 5     # cols 19-20 are the "!"
    top_y = 1
    # "!" body (rows 1-4)
    for y in range(4):
        f.put(ex_x,     top_y + y, PERMISSION_RGB, pulse)
        f.put(ex_x + 1, top_y + y, PERMISSION_RGB, pulse)
    # "!" dot (rows 6-7)
    for y in (5, 6):
        f.put(ex_x,     top_y + y, PERMISSION_RGB, pulse)
        f.put(ex_x + 1, top_y + y, PERMISSION_RGB, pulse)
    # chevrons
    for i in range(3):
        cx = ANIM_X0 + 10 + i
        a_chev = 0.15 + 0.45 * abs(math.sin(t / 240 + i * 0.5))
        f.put(cx, 2, PERMISSION_CHEV_RGB, a_chev)
        f.put(cx, 5, PERMISSION_CHEV_RGB, a_chev)
    return f


def render_complete(t: float) -> Frame:
    f = Frame()
    ANIM_X0 = 14

    # Crab celebration cycle: hop + arms-up cheer, independent of the text
    # cadence so any scroll phase can pair with any celebration beat.
    crab_cycle = 3000
    crab_phase = (t % crab_cycle) / crab_cycle
    arms_up = 0.15 <= crab_phase < 0.90
    dy = 0
    if 0.15 <= crab_phase < 0.25:
        jt = (crab_phase - 0.15) / 0.10
        lift = 4 * 1 * jt * (1 - jt)
        dy = -round(lift)
    draw_crab_big(f, 0, dy, 1.0, left_arm_up=arms_up, right_arm_up=arms_up)

    # "DONE!" rendered as one 5-glyph string so D-O-N-E-! never split across
    # the lane edge. Slide in from the right, hold long enough to read, then
    # slide out to the left.
    text = "DONE!"
    text_cycle = 3000
    text_phase = (t % text_cycle) / text_cycle
    w = text_width(text)
    start_x = W                  # off the right edge
    hold_x = ANIM_X0             # left-aligned in the 18-col lane
    end_x = ANIM_X0 - w          # off the left edge
    if text_phase < 0.25:
        slide_t = text_phase / 0.25
        x = round(start_x + (hold_x - start_x) * slide_t)
    elif text_phase < 0.75:
        x = hold_x
    else:
        slide_t = (text_phase - 0.75) / 0.25
        x = round(hold_x + (end_x - hold_x) * slide_t)
    render_text(f, text, x, 1, COMPLETE_RGB, 1.0, ANIM_X0, W)
    return f


RENDERERS = {
    "idle":             render_idle,
    "ready":            render_ready,
    "thinking":         render_thinking,
    "needs_permission": render_needs_permission,
    "complete":         render_complete,
}


# ---------------------------------------------------------------------------
# State-token I/O + timeout
# ---------------------------------------------------------------------------

def read_state_token(path: str) -> Tuple[str, float]:
    """Read state-token file. Returns (state, set_at_epoch_sec).
    Returns (DEFAULT_STATE, 0) if the file is missing or malformed."""
    try:
        with open(path, "r") as fh:
            line = fh.readline().strip()
        parts = line.split()
        if len(parts) != 2:
            return (DEFAULT_STATE, 0.0)
        ts, name = parts
        if name not in VALID_STATES:
            return (DEFAULT_STATE, 0.0)
        return (name, float(ts))
    except (OSError, ValueError):
        return (DEFAULT_STATE, 0.0)


def write_state_token(path: str, state: str) -> None:
    try:
        with open(path, "w") as fh:
            fh.write(f"{int(time.time())} {state}\n")
    except OSError:
        pass


# ---------------------------------------------------------------------------
# HTTP push: shared session + background pusher thread
# ---------------------------------------------------------------------------
#
# All outbound HTTP funnels through one background thread so the render loop
# never blocks on network I/O. The thread owns a keep-alive requests.Session
# so successive POSTs share a TCP connection (saves ~20-80ms per push on LAN).
#
# Communication is via a single mailbox guarded by a Condition:
#   - latest_frame: 1-slot, overwrite-on-replace. Late pushes shed
#     intermediate frames rather than queueing them — the natural backpressure
#     for a real-time display.
#   - controls: FIFO of pending /api/switch ops. A "Battery" CONTROL marks a
#     window during which frame pushes are discarded (the native Battery app
#     is on screen; updating the custom app behind it would be wasted work).
#   Any non-Battery switch clears the flash window so a mid-flash state change
#   brings the new app forward immediately.

_SESSION = None
_SESSION_LOCK = threading.Lock()


def _session():
    """Lazy module-level requests.Session with a small connection pool.
    Returns None if `requests` is unavailable (preview-only environments)."""
    global _SESSION
    try:
        import requests
    except ImportError:
        return None
    with _SESSION_LOCK:
        if _SESSION is None:
            s = requests.Session()
            adapter = requests.adapters.HTTPAdapter(pool_connections=2, pool_maxsize=4)
            s.mount("http://", adapter)
            _SESSION = s
        return _SESSION


def _reset_session() -> None:
    """Drop the cached session so the next POST opens a fresh connection.
    Used after a network error to clear half-dead keep-alive sockets."""
    global _SESSION
    with _SESSION_LOCK:
        if _SESSION is not None:
            try:
                _SESSION.close()
            except Exception:
                pass
            _SESSION = None


def _do_push_frame(state: str, draw_array: list) -> bool:
    """Synchronous /api/custom POST. Used by --once (one-shot) and by the
    pusher thread. Returns True on success so the caller can update its
    delta-push cache."""
    s = _session()
    if s is None:
        return False
    payload = {
        "draw": draw_array,
        "text": "",
        "duration": 60,
        "noScroll": True,
        "lifetime": 0,
    }
    try:
        s.post(
            f"http://{TC001_IP}/api/custom?name={state}",
            json=payload,
            timeout=HTTP_TIMEOUT_S,
        )
        return True
    except Exception:
        _reset_session()
        return False


def _do_switch_app(name: str) -> None:
    """Synchronous /api/switch POST."""
    s = _session()
    if s is None:
        return
    try:
        s.post(
            f"http://{TC001_IP}/api/switch",
            json={"name": name},
            timeout=HTTP_TIMEOUT_S,
        )
    except Exception:
        _reset_session()


class Pusher:
    """Background thread funneling all outbound HTTP to the TC001."""

    def __init__(self) -> None:
        self._cv = threading.Condition()
        self._latest_frame: Optional[Tuple[str, list]] = None
        self._controls: List[str] = []
        # Owned solely by the pusher thread:
        self._last_pushed: Optional[Tuple[str, int]] = None  # (state, repr-hash)
        self._flash_until_ms: float = 0.0
        self._thread = threading.Thread(
            target=self._run, name="tc001-pusher", daemon=True,
        )

    def start(self) -> None:
        self._thread.start()

    def enqueue_frame(self, state: str, draw_array: list) -> None:
        with self._cv:
            self._latest_frame = (state, draw_array)
            self._cv.notify()

    def enqueue_control(self, switch_to: str) -> None:
        with self._cv:
            self._controls.append(switch_to)
            self._cv.notify()

    def _run(self) -> None:
        while True:
            with self._cv:
                while self._latest_frame is None and not self._controls:
                    self._cv.wait()
                controls = self._controls
                self._controls = []
                frame = self._latest_frame
                self._latest_frame = None

            for switch_to in controls:
                _do_switch_app(switch_to)
                if switch_to == "Battery":
                    self._flash_until_ms = (
                        time.monotonic() * 1000 + BATTERY_FLASH_DURATION_S * 1000
                    )
                else:
                    self._flash_until_ms = 0.0

            if frame is None:
                continue
            if time.monotonic() * 1000 < self._flash_until_ms:
                continue
            state, draw_array = frame
            payload_hash = (state, hash(repr(draw_array)))
            if payload_hash == self._last_pushed:
                continue
            if _do_push_frame(state, draw_array):
                self._last_pushed = payload_hash
            else:
                # Failure: clear the dedup cache so the next identical frame
                # will be retried instead of silently swallowed.
                self._last_pushed = None


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def run_daemon(state_file: str, preview: bool) -> None:
    """Read state from disk, render, enqueue (or print). Loop forever.

    HTTP is fully off the critical path — the loop only renders and enqueues.
    The pusher thread owns all network I/O, so render cadence is decoupled
    from device/network latency."""
    t0_monotonic_ms = time.monotonic() * 1000
    last_battery_flash = time.time()  # delay first flash by full interval
    flash_end_t: Optional[float] = None  # wall-clock t when active battery flash should end
    prev_state: Optional[str] = None

    pusher: Optional[Pusher] = None
    if not preview:
        pusher = Pusher()
        pusher.start()

    interval_s = PUSH_INTERVAL_MS / 1000
    next_tick = time.monotonic()

    while True:
        state, set_at = read_state_token(state_file)

        # ready → idle inactivity timeout
        if state == "ready" and set_at > 0 and (time.time() - set_at) > READY_TIMEOUT_S:
            write_state_token(state_file, "idle")
            state, set_at = "idle", time.time()

        # complete → ready; the ready timeout then drops to idle so the
        # cycle ends on the walking crab after 60s of inactivity.
        if state == "complete" and set_at > 0 and (time.time() - set_at) > COMPLETE_TIMEOUT_S:
            write_state_token(state_file, "ready")
            state, set_at = "ready", time.time()

        # On any state change (especially internal timeouts), force the device's
        # active app to match — state_emitter.sh only switches apps on external
        # transitions, so without this the device stays parked on the previous
        # app and shows stale frames. Also cancels any active battery flash so
        # the new app appears immediately.
        if pusher is not None and prev_state is not None and state != prev_state:
            pusher.enqueue_control(state)
            flash_end_t = None
        prev_state = state

        renderer = RENDERERS.get(state, RENDERERS[DEFAULT_STATE])
        # Monotonic ms since daemon start: animations advance via a fixed
        # clock so the crab resumes in-phase across any pause (battery flash,
        # network stall, OS suspend).
        t_ms = time.monotonic() * 1000 - t0_monotonic_ms
        frame = renderer(t_ms)

        if preview:
            os.system("clear" if sys.platform != "win32" else "cls")
            print(f"state: {state}  t: {t_ms:.0f}ms")
            print(frame.to_ascii())
        else:
            assert pusher is not None
            pusher.enqueue_frame(state, frame.to_draw_array())

            # Non-blocking battery flash. Fire Battery switch, let it sit
            # for BATTERY_FLASH_DURATION_S while the pusher discards frames,
            # then switch back. The render loop keeps ticking the whole time
            # so the crab resumes in-phase.
            now = time.time()
            if flash_end_t is None:
                if state == "idle" and (now - last_battery_flash) >= BATTERY_FLASH_INTERVAL_S:
                    pusher.enqueue_control("Battery")
                    flash_end_t = now + BATTERY_FLASH_DURATION_S
                    last_battery_flash = now
            elif now >= flash_end_t:
                pusher.enqueue_control(state)
                flash_end_t = None

        # Drift-correcting cadence: anchor to a fixed-step next_tick rather
        # than accumulating per-iteration drift. If we fall more than 2
        # intervals behind (OS suspend, long GC pause), snap forward instead
        # of sprinting catch-up frames.
        next_tick += interval_s
        now_mono = time.monotonic()
        sleep_s = next_tick - now_mono
        if sleep_s < -2 * interval_s:
            next_tick = now_mono
            sleep_s = 0.0
        if sleep_s > 0:
            time.sleep(sleep_s)


def render_once(state: str, preview: bool) -> int:
    if state not in RENDERERS:
        print(f"unknown state: {state}", file=sys.stderr)
        return 2
    frame = RENDERERS[state](0)
    if preview:
        print(f"state: {state}")
        print(frame.to_ascii())
    else:
        _do_push_frame(state, frame.to_draw_array())
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="TC001 animator daemon")
    ap.add_argument("--preview", action="store_true",
                    help="print ASCII frames to stdout instead of pushing to TC001")
    ap.add_argument("--once", metavar="STATE", default=None,
                    help="render one frame of STATE then exit")
    ap.add_argument("--state-file", default=STATE_TOKEN_FILE,
                    help=f"override state-token path (default {STATE_TOKEN_FILE})")
    args = ap.parse_args()

    if args.once:
        return render_once(args.once, args.preview)
    try:
        run_daemon(args.state_file, args.preview)
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
