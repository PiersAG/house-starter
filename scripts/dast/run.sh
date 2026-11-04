#!/usr/bin/env bash
# The signed-in active scan, start to finish (app-business-core issue 533).
#
#   bash scripts/dast/run.sh                               # CI: fail on any High finding
#   bash scripts/dast/run.sh --expect-high /dashboard/canary  # self-test: pass only if the seeded flaw is caught
#
# Expects a built app (`npm run build`) and the scan's throwaway environment
# (see the `active-scan` job in .github/workflows/ci.yml). Serves the app on
# this machine's loopback, signs the scan account in, writes the plan, runs
# OWASP ZAP's Automation Framework in Docker with host networking, gates, and
# stops the app. Every input is supplied and stdin is closed, so nothing waits
# on a prompt; ZAP's progress is on the console as well as in the log file.
set -euo pipefail

BASE="${SCAN_BASE:-http://127.0.0.1:3000}"
PORT="${BASE##*:}"
OUT="${SCAN_OUT:-dast-results}"
IMAGE="${ZAP_IMAGE:?ZAP_IMAGE must name the pinned ZAP image}"
GATE_ARGS=("$@")

mkdir -p "$OUT"
stop_app() {
  # The app runs in its own process group (setsid), so this stops npx AND the
  # next-server it started, and nothing else on the machine.
  if [ -f "$OUT/server.pid" ]; then kill -- "-$(cat "$OUT/server.pid")" 2>/dev/null || true; fi
  rm -f "$OUT/session.json" "$OUT/plan.yaml"
}
trap stop_app EXIT

echo "== Starting the app on $BASE"
setsid nohup npx next start -H 127.0.0.1 -p "$PORT" > "$OUT/server.log" 2>&1 < /dev/null &
echo "$!" > "$OUT/server.pid"
up=""
for i in $(seq 1 90); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/health" || true)"
  if [ -n "$code" ] && [ "$code" != "000" ]; then up="$i"; break; fi
  sleep 1
done
if [ -z "$up" ]; then
  echo "::error::Active scan: the app never answered on $BASE within 90s."
  cat "$OUT/server.log"
  exit 1
fi
echo "App answered after ${up}s."

echo "== Signing the scan account in and writing the plan"
npx tsx scripts/dast/session.ts --base "$BASE" --out "$OUT/session.json" < /dev/null
npx tsx scripts/dast/plan.ts --base "$BASE" --session "$OUT/session.json" --dir "$OUT" < /dev/null
chmod 777 "$OUT"
chmod 644 "$OUT"/*

echo "== Running the active scan ($IMAGE)"
set +e
docker run --rm --network=host -v "$PWD/$OUT:/zap/wrk/:rw" "$IMAGE" \
  zap.sh -cmd -autorun /zap/wrk/plan.yaml < /dev/null 2>&1 | tee "$OUT/zap.log"
set -e

echo "== Gate"
npx tsx scripts/dast/gate.ts --dir "$OUT" --base "$BASE" --server-log "$OUT/server.log" "${GATE_ARGS[@]}" < /dev/null
