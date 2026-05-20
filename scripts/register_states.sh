#!/usr/bin/env bash
# Registers the 5 Claude Code state apps on the Ulanzi TC001 (Awtrix Light).
# Matches the v1 design locked in screens/preview.html on 2026-05-17:
#   - 13x8 Claude coral crab on the left (cols 0-12) for ready/thinking/
#     needs_permission/complete; 8x5 walking crab for idle
#   - State-specific content in the 18-col lane (cols 14-31)
#   - Top indicator LEDs carry the pulse signal that draw primitives cannot fade
#
# Re-run any time you tweak visuals. Apps persist in TC001 flash across reboots.
#
# Usage:
#   TC001_IP=192.168.12.126 ./register_states.sh
#   (defaults to 192.168.12.126 if TC001_IP unset)

set -euo pipefail

TC001="${TC001_IP:-192.168.12.126}"
API="http://$TC001/api"

# Palette (verbatim from screens/preview.html, hex form)
CORAL="#D97757"          # crab body + needs_permission secondary (chevrons) + ready indicator
DUSTY_BLUE="#46A5E1"     # thinking text
AMBER_GOLD="#FFC33C"     # needs_permission "!" + indicator
SAGE_GREEN="#78D282"     # complete text + indicator
CREAM="#FAF4E6"          # ready sentinel scanner
EYE_OFF="#000000"        # eye pixels (drawn as "off" to leave holes in body)

# 13x8 crab draw array as compact JSON (3 filled rects + 8 leg pixels + 2 eyes).
# Takes an optional x-offset (default 0) so the same sprite can sit at either
# the left edge (cols 0-12, used by thinking/needs_permission/complete) or
# centered (cols 10-22, used by ready).
#   Rows 0-1 body block: cols ox+2..ox+10 (rows 0-1, 9w x 2h)
#   Rows 2-3 arm strip:  cols ox+0..ox+12 (full width, 13w x 2h)
#   Rows 4-5 lower body: cols ox+2..ox+10
#   Rows 6-7 legs:       4 pixels per row at cols ox+2, ox+4, ox+8, ox+10
#   Eyes at row 1, cols ox+3 and ox+9 (overlay with #000000 to punch holes)
crab_draw() {
  local ox="${1:-0}"
  cat <<JSON
{"df":[$((ox+2)),0,9,2,"$CORAL"]},
{"df":[$((ox+0)),2,13,2,"$CORAL"]},
{"df":[$((ox+2)),4,9,2,"$CORAL"]},
{"dp":[$((ox+2)),6,"$CORAL"]},{"dp":[$((ox+4)),6,"$CORAL"]},{"dp":[$((ox+8)),6,"$CORAL"]},{"dp":[$((ox+10)),6,"$CORAL"]},
{"dp":[$((ox+2)),7,"$CORAL"]},{"dp":[$((ox+4)),7,"$CORAL"]},{"dp":[$((ox+8)),7,"$CORAL"]},{"dp":[$((ox+10)),7,"$CORAL"]},
{"dp":[$((ox+3)),1,"$EYE_OFF"]},{"dp":[$((ox+9)),1,"$EYE_OFF"]}
JSON
}

post_app() {
  local name="$1" payload="$2"
  curl -sS -X POST "$API/custom?name=$name" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    > /dev/null && echo "  registered: $name"
}

echo "Registering Claude state apps on $TC001..."

# IDLE — static crab, no text, no top indicator.
# (The animator daemon will overwrite this with per-frame walk-cycle pushes
# while the state is active; this baseline is what shows if the daemon is
# stopped or hasn't been built yet.)
post_app "idle" "$(cat <<JSON
{
  "draw": [ $(crab_draw) ],
  "duration": 60,
  "noScroll": true,
  "lifetime": 0
}
JSON
)"

# READY — centered crab (cols 10-22) + a pair of cream "scanner at rest"
# pixels just outside each crab edge (cols 9 and 23, row 4). The animator
# daemon, when active, overwrites this with the full mirror-scanner sweep
# and scrolling "READY" text; this baseline is the "daemon off" fallback
# that still reads as a distinct state.
post_app "ready" "$(cat <<JSON
{
  "draw": [
    $(crab_draw 10),
    {"dp":[9,4,"$CREAM"]},
    {"dp":[23,4,"$CREAM"]}
  ],
  "duration": 60,
  "noScroll": true,
  "lifetime": 0
}
JSON
)"

# THINKING — crab + scrolling "Thinking" in dusty blue.
# Indicator1 fade pulse is set per-switch by state_emitter.sh, not registered here.
post_app "thinking" "$(cat <<JSON
{
  "draw": [ $(crab_draw) ],
  "text": "Thinking",
  "color": "$DUSTY_BLUE",
  "textOffset": 14,
  "duration": 30,
  "lifetime": 0
}
JSON
)"

# NEEDS_PERMISSION — crab + static amber "!" at cols 19-20, coral chevrons at cols 24-26.
# "!" body: cols 19-20, rows 1-4 (df 2x4). Dot: cols 19-20, rows 6-7 (df 2x2).
# Chevrons: 3 coral pixels at row 2 (cols 24-26) and row 5 (cols 24-26).
post_app "needs_permission" "$(cat <<JSON
{
  "draw": [
    $(crab_draw),
    {"df":[19,1,2,4,"$AMBER_GOLD"]},
    {"df":[19,6,2,2,"$AMBER_GOLD"]},
    {"dp":[24,2,"$CORAL"]},{"dp":[25,2,"$CORAL"]},{"dp":[26,2,"$CORAL"]},
    {"dp":[24,5,"$CORAL"]},{"dp":[25,5,"$CORAL"]},{"dp":[26,5,"$CORAL"]}
  ],
  "duration": 60,
  "noScroll": true,
  "lifetime": 0
}
JSON
)"

# COMPLETE — minimal baseline (color hint only).
# AWTRIX /api/custom appears to merge fields rather than replace, so any text
# specified here leaks through later daemon pushes as bottom-corner artifacts.
# The full design (crab + 1px victory hop + arms raised + fade-in/pop/hold/
# fade-out "DONE!") is composited per frame by animator.py; the baseline holds
# nothing except the state name. With the daemon off, the device shows a blank
# panel for complete — acceptable since the indicator3 sage LED carries the
# state signal.
# StateEmitter.ts owns the complete → ready transition via a 3s JS timer.
post_app "complete" "$(cat <<JSON
{
  "duration": 60,
  "noScroll": true,
  "lifetime": 0
}
JSON
)"

echo ""
echo "Done. Test each state:"
echo "  curl -X POST $API/switch -d '{\"name\":\"ready\"}' -H 'Content-Type: application/json'"
echo "  curl -X POST $API/switch -d '{\"name\":\"thinking\"}' -H 'Content-Type: application/json'"
echo "  curl -X POST $API/switch -d '{\"name\":\"needs_permission\"}' -H 'Content-Type: application/json'"
echo "  curl -X POST $API/switch -d '{\"name\":\"complete\"}' -H 'Content-Type: application/json'"
echo "  curl -X POST $API/switch -d '{\"name\":\"idle\"}' -H 'Content-Type: application/json'"
