import 'dotenv/config';
import { env } from './lib/env';
import { logger } from './lib/logger';
import { closeRedis } from './lib/kv';
import { startWorkers, stopWorkers } from './lib/queue';
import { closeDb, sequelize } from './models';
import { registerAuthJobs } from './modules/auth/auth.jobs';

/** BullMQ worker process (separate from the API). Each module registers its processors here. */
async function main(): Promise<void> {
  env();
  await sequelize.authenticate();
  registerAuthJobs();
  await startWorkers();
  logger.info('society-worker started');
  const shutdown = async () => {
    await stopWorkers();
    await closeRedis();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
