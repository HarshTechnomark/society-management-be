import { Sequelize } from 'sequelize';
import { env } from '../lib/env';

/** The one Sequelize connection. Each module adds its model file here and calls its `associate`. */
const u = new URL(env().DATABASE_URL);

export const sequelize = new Sequelize(
  u.pathname.replace(/^\//, ''),
  decodeURIComponent(u.username),
  decodeURIComponent(u.password),
  {
    host: u.hostname,
    port: Number(u.port || 3306),
    dialect: 'mysql',
    timezone: '+00:00',
    logging: false,
    pool: { max: 20, min: 0, idle: 10_000, acquire: 30_000 },
    define: { charset: 'utf8mb4', collate: 'utf8mb4_0900_ai_ci', freezeTableName: true },
  },
);

/** All models, filled in as modules add them. */
export const db = { sequelize };

export async function closeDb(): Promise<void> {
  await sequelize.close();
}
