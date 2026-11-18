/* The STANDING test database pool: created once, reused by every helper and module (nothing is created or dropped per module).
 *   node scripts/test-db-pool.cjs ensure            create the missing databases and the grants (idempotent)
 *   node scripts/test-db-pool.cjs migrate [N ...]   migrate pool databases to the latest migrations (all when no N)
 *   node scripts/test-db-pool.cjs status            list the databases and their migration counts
 *   node scripts/test-db-pool.cjs url N             print the DATABASE_URL of pool database N
 * Databases: `societyapp_pool_1..12` (one per helper/worktree: use the number of your assignment) and
 * `societyapp_shard_1..8` (the full-suite shard runner, scripts/test-shards.sh). Test data is wiped by the tests themselves
 * (they truncate their tables), so a pool database never needs to be recreated; after new migrations run `migrate`.
 * Server: the normal local MySQL on 127.0.0.1:3307 as root without a password (the private test MySQL). Never the dev database. */
const mysql = require('mysql2/promise');
const { spawn } = require('node:child_process');

const POOL = 12;
const SHARDS = 8;
const names = [
  ...Array.from({ length: POOL }, (_, i) => `societyapp_pool_${i + 1}`),
  ...Array.from({ length: SHARDS }, (_, i) => `societyapp_shard_${i + 1}`),
];
const urlOf = db => `mysql://societyapp:societyapp_dev@127.0.0.1:3307/${db}`;
const connect = () => mysql.createConnection({ host: '127.0.0.1', port: 3307, user: 'root' });

async function ensure() {
  const c = await connect();
  for (const p of ['pool', 'shard'])
    await c
      .query(`GRANT ALL ON \`societyapp\\_${p}\\_%\`.* TO 'societyapp'@'%'`)
      .catch(() => c.query(`GRANT ALL ON \`societyapp\\_${p}\\_%\`.* TO 'societyapp'@'localhost'`));
  for (const db of names)
    await c.query(`CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  await c.end();
  process.stdout.write(`${names.length} databases ready (${POOL} pool, ${SHARDS} shard)\n`);
}

const migrateOne = db =>
  new Promise(resolve => {
    const p = spawn('npx', ['sequelize-cli', 'db:migrate'], {
      env: { ...process.env, DATABASE_URL: urlOf(db) },
      stdio: 'ignore',
    });
    p.on('exit', code => resolve({ db, code }));
  });

async function migrate(args) {
  const list = args.length ? args.map(n => (/^\d+$/.test(n) ? `societyapp_pool_${n}` : n)) : names;
  const results = [];
  for (let i = 0; i < list.length; i += 4)
    results.push(...(await Promise.all(list.slice(i, i + 4).map(migrateOne))));
  for (const r of results)
    process.stdout.write(`${r.db}: ${r.code === 0 ? 'up to date' : `FAILED (exit ${r.code})`}\n`);
  if (results.some(r => r.code !== 0)) process.exit(1);
}

async function status() {
  const c = await connect();
  for (const db of names) {
    const [t] = await c.query('SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = ?', [
      db,
    ]);
    let m = 'no';
    try {
      const [r] = await c.query(`SELECT COUNT(*) n FROM \`${db}\`.sequelize_meta`);
      m = r[0].n;
    } catch {
      // the database exists but has no migration table yet
    }
    process.stdout.write(`${db}: ${t[0].n} tables, ${m} migrations\n`);
  }
  await c.end();
}

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'ensure') await ensure();
  else if (cmd === 'migrate') await migrate(args);
  else if (cmd === 'status') await status();
  else if (cmd === 'url')
    process.stdout.write(`${urlOf(/^\d+$/.test(args[0] || '') ? `societyapp_pool_${args[0]}` : args[0])}\n`);
  else process.stderr.write('usage: test-db-pool.cjs ensure|migrate [N...]|status|url N\n');
})().catch(e => {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
});
