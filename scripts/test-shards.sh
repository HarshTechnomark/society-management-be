#!/bin/bash
# Runs the full backend suite in N parallel vitest shards (default 8), each on its own scratch
# database on the RAM MySQL (port 3308, see scripts/test-ram-mysql.sh). Usage: test-shards.sh [N]
# DATABASE_URL set in the environment beats .env / .env.test (dotenv never overrides), for both
# sequelize-cli and vitest.
set -u
N=${1:-8}
# Cheap password hashes for fixture users (tests/setup/fast-argon.ts); TEST_FAST=0 scripts/test-shards.sh turns it off.
export TEST_FAST=${TEST_FAST:-1}
PORT=3308
SOCK=/dev/shm/societyapp-mysql-test/run/mysql.sock
cd "$(dirname "$0")/.." || exit 1
ROOT=$PWD
LOGS=$(mktemp -d "${TMPDIR:-/tmp}/shards.XXXXXX")

"$ROOT/scripts/test-ram-mysql.sh" start >/dev/null || { echo "RAM MySQL not available" >&2; exit 1; }

dbs() { # $1 = drop|create
  node -e "
const m=require('$ROOT/node_modules/mysql2/promise');(async()=>{const c=await m.createConnection({socketPath:'$SOCK',user:'root'});
for(let i=1;i<=$N;i++){const d='societyapp_shard_'+i;await c.query('DROP DATABASE IF EXISTS '+d);
if(process.argv[1]==='create')await c.query('CREATE DATABASE '+d+' CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');}
await c.end()})().catch(e=>{console.error(e.message);process.exit(1)})" "$1"
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
