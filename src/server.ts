import 'dotenv/config';
import { createApp } from './app';
import { env } from './lib/env';
import { logger } from './lib/logger';
import { closeDb, sequelize } from './models';
import { registerAuthJobs } from './modules/auth/auth.jobs';
import { registerAccessControl } from './modules/access-control/access-control.public';
import { registerSubscriptions } from './modules/subscriptions/subscriptions.public';
import { registerSocieties } from './modules/societies/societies.public';
import { registerPlatformBilling } from './modules/platform-billing/platform-billing.public';
import { registerPlatformOps } from './modules/platform-ops/platform-ops.public';
import { registerSocietySetup } from './modules/society-setup/society-setup.public';
import { wireApprovalsPorts } from './modules/approvals/approvals.wire';
import { registerResidents } from './modules/residents/residents.public';
import { registerCommittee } from './modules/committee/committee.public';
import { registerAccounts } from './modules/accounts/accounts.public';
import { registerBilling } from './modules/billing/billing.public';
import { registerPayments } from './modules/payments/payments.public';
import { registerCommunication } from './modules/communication/communication.public';
import { registerHelpdesk } from './modules/helpdesk/helpdesk.public';
import { registerApprovals } from './modules/approvals/approvals.public';
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
  registerSocieties();
  registerPlatformBilling();
  registerPlatformOps();
  registerSocietySetup();
  wireApprovalsPorts(); // module 14: real approvals engine behind every placeholder port, before the modules register their types
  registerResidents();
  registerCommittee();
  registerAccounts(); // before registerBilling(): installs the real journal behind the module 11 and 12 ports
  registerBilling();
  registerPayments();
  registerApprovals();
  registerHelpdesk(); // module 15: export provider, purge handler, queue, unit guard
  registerCommunication(); // module 16: the real notify() engine, export provider, purge handler, queue `communication`
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
