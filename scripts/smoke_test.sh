#!/usr/bin/env bash
# One-shot smoke test for a freshly flashed TC001.
# Run after WiFi onboarding and DHCP reservation are done.
#
# 1. Confirms the device API is reachable.
# 2. Pushes a hello notification.
# 3. Runs register_states.sh.
# 4. Cycles through all 4 states with a 4s pause between each.

set -euo pipefail

TC001="${TC001_IP:-192.168.12.126}"
API="http://$TC001/api"
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "[1/4] Pinging $TC001..."
curl -sS --max-time 2 "$API/stats" > /dev/null
echo "      OK"

echo "[2/4] Hello notification (5s)..."
curl -sS -X POST "$API/notify" \
  -H "Content-Type: application/json" \
  -d '{"text":"hello claude","color":"#D97757","duration":5}' > /dev/null
sleep 6

echo "[3/4] Registering state apps..."
TC001_IP="$TC001" bash "$HERE/register_states.sh"

echo "[4/4] Cycling states (idle -> thinking -> needs_permission -> complete -> ready -> idle)..."
for s in idle thinking needs_permission complete ready idle; do
  echo "      -> $s"
  TC001_IP="$TC001" bash "$HERE/state_emitter.sh" "$s"
  sleep 4
done

echo ""
echo "Smoke test complete. If all 4 states rendered correctly, the pipeline is wired."
