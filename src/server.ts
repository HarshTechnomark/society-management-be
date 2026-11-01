import 'dotenv/config';
import { createApp } from './app';
import { env } from './lib/env';
import { logger } from './lib/logger';
import { closeDb, sequelize } from './models';
import { registerAuthJobs } from './modules/auth/auth.jobs';
import { registerAccessControl } from './modules/access-control/access-control.public';
import { registerSubscriptions } from './modules/subscriptions/subscriptions.public';
import { assertCatalogueComplete } from './modules/subscriptions/subscriptions.seed';
import { startWorkers, stopWorkers, usesRedis } from './lib/queue';
import { closeRedis } from './lib/kv';

async function main(): Promise<void> {
  const e = env(); // fails fast with the name of every bad variable
  await sequelize.authenticate();
  logger.info('database connected');

  // Without Redis the jobs run in this process; with Redis `npm run start:worker` runs them.
  registerAuthJobs();
  registerAccessControl();
  registerSubscriptions();
  await assertCatalogueComplete(); // every catalogue key has a row in every plan version (module 04)
  if (!usesRedis()) await startWorkers();

  const server = createApp().listen(e.PORT, () =>
    logger.info({ port: e.PORT, env: e.NODE_ENV }, 'society-api listening'),
  );

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    server.close(async () => {
      await stopWorkers();
      await closeRedis();
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
