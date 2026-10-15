#!/bin/sh
# Takes the mock Home Assistant away in different ways and checks the app reconnects by itself.
# Run from the app folder: sh dev/reconnect-test.sh
cd "$(dirname "$0")/.." || exit 1
fail=0
# both halves share one connection: lighting and heating must agree
state() {
  l=$(curl -s localhost:8099/api/lighting/state | node -e 'const d=JSON.parse(require("fs").readFileSync(0));process.stdout.write(d.connected?"connected":"down: "+(d.haError||""))')
  h=$(curl -s localhost:8099/api/state | node -e 'const d=JSON.parse(require("fs").readFileSync(0));process.stdout.write(d.haConnected?"connected":"down")')
  case "$l" in connected*) [ "$h" = connected ] && echo "connected" || echo "mixed: lighting $l, heating $h";; *) [ "$h" = down ] && echo "$l" || echo "mixed: lighting $l, heating $h";; esac
}
expect() { s=$(state); case "$s" in $1*) echo "  ok   $2 ($s)";; *) echo "  FAIL $2 ($s)"; fail=1;; esac; }
start_mock() { node dev/mock-ha.js > dev/logs/mock.log 2>&1 & echo $! > dev/logs/mock.pid; }

sh dev/run.sh stop; rm -rf dev/data/*; sh dev/run.sh >/dev/null; sleep 2
expect connected "starts connected"
for mode in refuse 502 hang; do
  kill "$(cat dev/logs/mock.pid)"; sleep 1
  [ "$mode" != refuse ] && { node dev/fake-ha-down.js $mode > /dev/null 2>&1 & FP=$!; }
  sleep 20
  expect down "while Home Assistant is away ($mode)"
  [ -n "$FP" ] && kill "$FP" 2>/dev/null; FP=
  sleep 0.5; start_mock
  sleep 35
  expect connected "back by itself after $mode"
done
echo "  freezing Home Assistant with the connection open (checks the 30 s ping)"
curl -s -XPOST localhost:8124/freeze >/dev/null
sleep 50
expect down "notices a silent connection"
curl -s -XPOST localhost:8124/unfreeze >/dev/null
sleep 35
expect connected "back by itself after freezing"
grep -c "Lost connection" dev/logs/server.log | xargs echo "  drops logged:"
sh dev/run.sh stop
[ $fail = 0 ] && echo "reconnect checks passed" || { echo "reconnect checks FAILED"; exit 1; }
