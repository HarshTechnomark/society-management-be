#!/bin/bash
# Private RAM-disk MySQL for TEST data only (port 3308). Usage: test-ram-mysql.sh start|stop|status
# Unsafe settings (no fsync, no doublewrite): never use this for the dev database.
set -u
BIN="${MYSQLD_BIN:-$HOME/.local/societyapp-mysql/mysqld-copy}"
BASE=/dev/shm/societyapp-mysql-test
PORT=3308
CNF="$BASE/my.cnf"
PIDF="$BASE/run/mysql.pid"
SOCK="$BASE/run/mysql.sock"

write_cnf() {
  cat > "$CNF" <<CNF
[mysqld]
datadir=$BASE/data
socket=$SOCK
mysqlx=OFF
port=$PORT
bind-address=127.0.0.1
pid-file=$PIDF
log-error=$BASE/run/error.log
default-time-zone=+00:00
character-set-server=utf8mb4
collation-server=utf8mb4_0900_ai_ci
sql_mode=STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION
skip-log-bin
skip-name-resolve
performance_schema=OFF
max_connections=400
innodb_flush_log_at_trx_commit=0
innodb_doublewrite=OFF
innodb_flush_neighbors=0
innodb_flush_method=O_DIRECT_NO_FSYNC
innodb_buffer_pool_size=2G
innodb_redo_log_capacity=104857600
innodb_io_capacity=2000
CNF
}

pid_alive() { # true only if pid file names a live process that is our instance
  [ -f "$PIDF" ] || return 1
  local pid; pid=$(cat "$PIDF" 2>/dev/null) || return 1
  [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] && tr '\0' ' ' < "/proc/$pid/cmdline" | grep -q 'societyapp-mysql-test'
}
mysql_ping() { node -e "require('net').connect(${PORT},'127.0.0.1').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})" 2>/dev/null; }

sql() { # run SQL as root through the socket via mysql2 (no mysql client needed)
  node -e "
const m=require('$PWD/node_modules/mysql2/promise');(async()=>{const c=await m.createConnection({socketPath:'$SOCK',user:'root'});
await c.query(process.argv[1]);await c.end()})().catch(e=>{console.error(e.message);process.exit(1)})" "$1"
}

start() {
  if pid_alive && mysql_ping; then echo "already running (pid $(cat "$PIDF"), port $PORT)"; return 0; fi
  [ -x "$BIN" ] || { echo "missing $BIN" >&2; return 1; }
  mkdir -p "$BASE/run"
  write_cnf
  local fresh=0
  if [ ! -d "$BASE/data/mysql" ]; then
    echo "initialising datadir in $BASE/data (RAM disk)"
    rm -rf "$BASE/data"
    "$BIN" --defaults-file="$CNF" --initialize-insecure > "$BASE/run/init.log" 2>&1 || { echo "init failed, see $BASE/run/init.log" >&2; return 1; }
    fresh=1
  fi
  (cd "$BASE" && nohup "$BIN" --defaults-file="$CNF" > "$BASE/run/out.log" 2>&1 &)
  local i
  for i in $(seq 1 60); do mysql_ping && break; sleep 1; done
  mysql_ping || { echo "did not start, see $BASE/run/error.log" >&2; return 1; }
  sleep 1
  sql "CREATE USER IF NOT EXISTS 'societyapp'@'%' IDENTIFIED BY 'societyapp_dev'" || return 1
  sql "GRANT ALL ON *.* TO 'societyapp'@'%'" || return 1
  echo "started (pid $(cat "$PIDF"), port $PORT, fresh=$fresh)"
}

stop() {
  if ! pid_alive; then echo "not running"; return 0; fi
  local pid; pid=$(cat "$PIDF")
  kill "$pid"
  local i; for i in $(seq 1 30); do [ -d "/proc/$pid" ] || break; sleep 1; done
  [ -d "/proc/$pid" ] && { echo "pid $pid still alive" >&2; return 1; }
  echo "stopped"
}

status() {
  if pid_alive && mysql_ping; then echo "running (pid $(cat "$PIDF"), port $PORT)"; else echo "not running"; return 1; fi
}

case "${1:-}" in
  start) start ;; stop) stop ;; status) status ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
