#!/bin/bash
# Runs the full backend suite in N parallel vitest shards (default 8), each on its own scratch
# database `societyapp_shard_<i>` on the normal local MySQL (127.0.0.1:3307, the same server as the dev
# database; the shard databases are created and dropped here). Usage: test-shards.sh [N]
# Opt-in only: TEST_DB=ram uses the RAM MySQL of scripts/test-ram-mysql.sh (port 3308) instead.
# DATABASE_URL set in the environment beats .env / .env.test (dotenv never overrides), for both
# sequelize-cli and vitest.
set -u
N=${1:-8}
# Cheap password hashes for fixture users (tests/setup/fast-argon.ts); TEST_FAST=0 scripts/test-shards.sh turns it off.
export TEST_FAST=${TEST_FAST:-1}
if [ "${TEST_DB:-}" = "ram" ]; then PORT=3308; else PORT=3307; fi
cd "$(dirname "$0")/.." || exit 1
ROOT=$PWD
LOGS=$(mktemp -d "${TMPDIR:-/tmp}/shards.XXXXXX")

if [ "${TEST_DB:-}" = "ram" ]; then
  "$ROOT/scripts/test-ram-mysql.sh" start >/dev/null || { echo "RAM MySQL not available" >&2; exit 1; }
else
  (echo > /dev/tcp/127.0.0.1/3307) 2>/dev/null || { echo "MySQL on 127.0.0.1:3307 is not running (see BUILD_BRIEF.md rule 4)" >&2; exit 1; }
fi

dbs() { # $1 = drop|create
  node "$ROOT/scripts/test-db-admin.cjs" "$1" "$N" "${TEST_DB:-}"
}

T0=$(date +%s)
dbs create || exit 1
for i in $(seq 1 "$N"); do
  (
    export DATABASE_URL="mysql://societyapp:societyapp_dev@127.0.0.1:$PORT/societyapp_shard_$i"
    s=$(date +%s)
    npx sequelize-cli db:migrate > "$LOGS/shard-$i.log" 2>&1 || { echo "EXIT 1 (migrate failed)" >> "$LOGS/shard-$i.log"; exit 1; }
    m=$(date +%s)
    npx vitest run --shard="$i/$N" >> "$LOGS/shard-$i.log" 2>&1
    echo "EXIT $?" >> "$LOGS/shard-$i.log"
    echo "migrate=$((m - s))s tests=$(($(date +%s) - m))s" >> "$LOGS/shard-$i.log"
  ) &
done
wait
RC=0
for i in $(seq 1 "$N"); do
  L="$LOGS/shard-$i.log"
  files=$(grep -E 'Test Files' "$L" | sed 's/\x1b\[[0-9;]*m//g' | tr -s ' ' | sed 's/^ //')
  tests=$(grep -E '^ *Tests ' "$L" | sed 's/\x1b\[[0-9;]*m//g' | tr -s ' ' | sed 's/^ //')
  code=$(grep -E '^EXIT' "$L" | tail -1)
  echo "shard $i: ${files:-no files line} | ${tests:-no tests line} | ${code:-EXIT ?} | $(tail -1 "$L")"
  [ "$code" = "EXIT 0" ] || RC=1
done
if [ "$RC" -ne 0 ]; then
  echo "--- failures ---"
  sed 's/\x1b\[[0-9;]*m//g' "$LOGS"/shard-*.log | grep -E '^ *(FAIL|×)|Error:' | sort -u | head -50
fi
dbs drop
echo "wall time: $(($(date +%s) - T0))s, shards: $N, exit: $RC, logs: $LOGS"
exit "$RC"
