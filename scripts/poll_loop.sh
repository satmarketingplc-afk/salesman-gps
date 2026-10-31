#!/usr/bin/env bash
# Render worker entrypoint — replaces .github/workflows/poll.yml.
# One poll pass every POLL_INTERVAL_S seconds (Telegram long-poll holds the request
# open up to 25 s, so this is latency, not CPU). The dashboard "Refresh" button bumps
# DATA_DIR/wake, and the sleep loop checks it every second, so a nudge accelerates the
# next pass without a separate dispatch mechanism. Reports rebuild hourly when
# BUILD_REPORTS=1.
set -u

POLL_INTERVAL_S="${POLL_INTERVAL_S:-15}"
DATA_DIR="${DATA_DIR:-}"
WAKE=""
[ -n "$DATA_DIR" ] && WAKE="$DATA_DIR/wake"

echo "[poll-loop] starting; interval=${POLL_INTERVAL_S}s wake=${WAKE:-off} reports=${BUILD_REPORTS:-off}"

while true; do
  node scripts/poll_telegram.mjs || echo "[poll-loop] pass failed (continuing)"

  # hourly report build (cheap; reads only the local archive)
  if [ "${BUILD_REPORTS:-0}" = "1" ]; then
    HOUR_KEY="$(date +%Y%j%H)"
    if [ "$HOUR_KEY" != "${LAST_REPORTS:-}" ]; then
      node scripts/report.mjs || echo "[poll-loop] report build failed"
      LAST_REPORTS="$HOUR_KEY"
    fi
  fi

  # interruptible sleep: react to the Refresh wake marker within ~1 s
  END=$(( $(date +%s) + POLL_INTERVAL_S ))
  while [ "$(date +%s)" -lt "$END" ]; do
    sleep 1
    if [ -n "$WAKE" ] && [ -f "$WAKE" ]; then
      rm -f "$WAKE"
      break
    fi
  done
done
