/* Sequelize CLI configuration, built from DATABASE_URL. `require('dotenv')` lets the CLI read .env. */
require('dotenv').config();

const url = (process.env.DATABASE_URL || '').trim();
if (!url) throw new Error('DATABASE_URL is required');
const u = new URL(url);

const base = {
  username: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  host: u.hostname,
  port: Number(u.port || 3306),
  database: u.pathname.replace(/^\//, ''),
  dialect: 'mysql',
  timezone: '+00:00',
  dialectOptions: { dateStrings: false, typeCast: true },
  define: { charset: 'utf8mb4', collate: 'utf8mb4_0900_ai_ci' },
  migrationStorageTableName: 'sequelize_meta',
};

module.exports = { development: base, test: base, staging: base, production: base };
