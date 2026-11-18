/* Creates or drops the scratch shard databases `societyapp_shard_1..N` for scripts/test-shards.sh.
 * Usage: node scripts/test-db-admin.cjs create|drop N [ram]. Connects as root without a password (the private test MySQL). */
const mysql = require('mysql2/promise');

(async () => {
  const [action, n, mode] = [process.argv[2], Number(process.argv[3] || 8), process.argv[4]];
  const conn = await mysql.createConnection(
    mode === 'ram'
      ? { socketPath: '/dev/shm/societyapp-mysql-test/run/mysql.sock', user: 'root' }
      : { host: '127.0.0.1', port: 3307, user: 'root' },
  );
  if (action === 'create' || action === 'ensure')
    // the app user needs rights on the scratch databases (the dev MySQL grants per database)
    await conn
      .query("GRANT ALL ON `societyapp\\_shard\\_%`.* TO 'societyapp'@'%'")
      .catch(() => conn.query("GRANT ALL ON `societyapp\\_shard\\_%`.* TO 'societyapp'@'localhost'"));
  for (let i = 1; i <= n; i += 1) {
    const db = `societyapp_shard_${i}`;
    // 'ensure' keeps the standing shard databases and only creates the missing ones (the default of test-shards.sh)
    if (action === 'ensure') {
      await conn.query(
        `CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
      );
      continue;
    }
    await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
    if (action === 'create')
      await conn.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  }
  await conn.end();
})().catch(e => {
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
});
