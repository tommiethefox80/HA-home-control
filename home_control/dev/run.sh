#!/bin/sh
# Start the mock HA and the app against it. Logs in dev/logs. ./dev/run.sh stop to stop.
cd "$(dirname "$0")/.." || exit 1
mkdir -p dev/logs dev/data
for f in dev/logs/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null; rm -f "$f"; done
sleep 1
[ "$1" = "stop" ] && exit 0
sleep 0.5
node dev/mock-ha.js > dev/logs/mock.log 2>&1 & echo $! > dev/logs/mock.pid
sleep 0.8
MEDIA_DIR="$(pwd)/dev/data/media" HA_MEDIA_DIR="$(pwd)/dev/data/media" HA_URL=http://localhost:8123 HA_TOKEN=dev DATA_DIR=dev/data PORT=8099 node server/src/index.js > dev/logs/server.log 2>&1 & echo $! > dev/logs/server.pid
sleep 1.5
echo "App on http://localhost:8099  (mock control on :8124)"
