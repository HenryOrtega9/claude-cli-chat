#!/usr/bin/env bash
# Fires a state change to the TC001. Switches the active custom app AND sets
# the top-row indicator LEDs (which carry the pulse signal that custom app
# draw arrays cannot produce). Also writes a state-token file that the
# animator daemon reads to drive per-frame motion and the ready→idle timeout.
#
# Silent on failure with a 0.5s timeout so a powered-off or off-network
# device cannot slow Claude Code hook execution.
#
# Usage: state_emitter.sh <idle|ready|thinking|needs_permission|complete>

# State-token file consumed by animator.py. Format: "<epoch_sec> <state>\n".
# The daemon polls this to know which state to render and to time the
# 60s ready→idle inactivity window.
STATE_TOKEN_FILE="/tmp/claude_state"

STATE="$1"
TC001="${TC001_IP:-192.168.12.126}"
API="http://$TC001/api"

[ -z "$STATE" ] && exit 0

# Write the state token first (never blocks on network). The animator daemon
# polls this file; writing here ensures the daemon notices the new state
# even if the HTTP push below fails.
printf '%s %s\n' "$(date +%s)" "$STATE" > "$STATE_TOKEN_FILE" 2>/dev/null || true

# Palette (must match register_states.sh)
CORAL="#D97757"
AMBER_GOLD="#FFC33C"
SAGE_GREEN="#78D282"

# Push the app switch. Always silent.
switch_app() {
  curl -s --max-time 0.5 \
    -X POST "$API/switch" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$1\"}" \
    > /dev/null 2>&1 || true
}

# Set or clear a top indicator LED. Awtrix endpoints:
#   /api/indicator1  — leftmost LED
#   /api/indicator2  — middle LED
#   /api/indicator3  — rightmost LED
# Body: {"color":"#RRGGBB","blink":<ms>,"fade":<ms>} — omit blink/fade for solid.
# To clear: empty body {} or color "#000000".
set_indicator() {
  local n="$1" body="$2"
  curl -s --max-time 0.5 \
    -X POST "$API/indicator$n" \
    -H "Content-Type: application/json" \
    -d "$body" \
    > /dev/null 2>&1 || true
}

clear_indicators() {
  set_indicator 1 '{}'
  set_indicator 2 '{}'
  set_indicator 3 '{}'
}

case "$STATE" in
  idle|ready|thinking|needs_permission|complete)
    # Matrix-only design (indicator LEDs disabled 2026-05-18): the 3 indicator
    # LEDs on the TC001 are physically chained into the matrix at r6c31,
    # r7c30, r7c31, so they read as bottom-right matrix pixels and clutter
    # the per-state visuals. All state differentiation lives in the daemon's
    # per-frame matrix rendering (color, gesture, text, glyph).
    switch_app "$STATE"
    clear_indicators
    ;;
  *)
    # Unknown state: noop, exit clean
    exit 0
    ;;
esac

exit 0
