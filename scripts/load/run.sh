#!/usr/bin/env bash
# The load test, start to finish (app-business-core #356; plan in config/load-test.ts).
#
#   bash scripts/load/install-k6.sh && npm run build && bash scripts/load/run.sh
#
# Expects a built app and the job's throwaway environment (the `load-test` job in
# .github/workflows/ci.yml). Refuses any target but this machine, serves the app,
# runs k6 while recording the app's processor and memory use, gates the result and
# stops the app. Run it on GitHub's runners, not on a laptop: 100 users and a flood
# are heavy. Every input is supplied and stdin is closed, so nothing waits on a prompt.
set -euo pipefail

BASE="${LOAD_BASE:-http://127.0.0.1:3100}"
PORT="${BASE##*:}"
OUT="${LOAD_OUT:-load-results}"
K6="${K6_BIN:-k6}"

if [ -n "${VERCEL_ENV:-}" ]; then
  echo "::error::Load test: VERCEL_ENV is set, so this is a deployed app. It runs only on a local copy."
  exit 1
fi
npx tsx scripts/load/gate.ts --check-target "$BASE" < /dev/null

mkdir -p "$OUT"
rm -f "$OUT/summary.json" "$OUT/server-samples.txt"
stop_app() {
  # The app runs in its own process group (setsid), so this stops npx AND the
  # next-server it started, and nothing else on the machine.
  if [ -f "$OUT/sampler.pid" ]; then kill "$(cat "$OUT/sampler.pid")" 2>/dev/null || true; fi
  if [ -f "$OUT/server.pid" ]; then kill -- "-$(cat "$OUT/server.pid")" 2>/dev/null || true; fi
  rm -f "$OUT/server.pid" "$OUT/sampler.pid"
}
trap stop_app EXIT

echo "== Starting the app on $BASE"
setsid nohup npx next start -H 127.0.0.1 -p "$PORT" > "$OUT/server.log" 2>&1 < /dev/null &
echo "$!" > "$OUT/server.pid"
up=""
for i in $(seq 1 90); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -H 'x-forwarded-for: 203.0.113.252' "$BASE/api/health" || true)"
  if [ -n "$code" ] && [ "$code" != "000" ]; then up="$i"; break; fi
  sleep 1
done
if [ -z "$up" ]; then
  echo "::error::Load test: the app never answered on $BASE within 90s."
  cat "$OUT/server.log"
  exit 1
fi
echo "App answered after ${up}s."

# Every 5 seconds: the app's processor share (100 = one core flat out) and memory in
# KB, summed over its process group. The report names the limiting component from this.
group="$(cat "$OUT/server.pid")"
(
  while sleep 5; do
    ps -o pcpu=,rss= -g "$group" 2>/dev/null \
      | awk '{ cpu += $1; rss += $2 } END { if (NR) print cpu, rss }' >> "$OUT/server-samples.txt"
  done
) &
echo "$!" > "$OUT/sampler.pid"

echo "== Running k6 ($("$K6" version | head -1))"
set +e
"$K6" run --quiet -e "BASE_URL=$BASE" -e "OUT_DIR=$OUT" scripts/load/journey.js < /dev/null 2>&1 | tee "$OUT/k6.log"
k6_exit="${PIPESTATUS[0]}"
set -e
stop_app
echo "k6 finished with exit code $k6_exit."

echo "== Gate"
npx tsx scripts/load/gate.ts --dir "$OUT" --k6-exit "$k6_exit" < /dev/null
