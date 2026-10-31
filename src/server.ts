import 'dotenv/config';
import { createApp } from './app';
import { env } from './lib/env';
import { logger } from './lib/logger';
import { closeDb, sequelize } from './models';

async function main(): Promise<void> {
  const e = env(); // fails fast with the name of every bad variable
  await sequelize.authenticate();
  logger.info('database connected');

  const server = createApp().listen(e.PORT, () =>
    logger.info({ port: e.PORT, env: e.NODE_ENV }, 'society-api listening'),
  );

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
