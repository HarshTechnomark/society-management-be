import 'dotenv/config';
import { env } from './lib/env';
import { logger } from './lib/logger';
import { closeRedis } from './lib/kv';
import { startWorkers, stopWorkers } from './lib/queue';
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
import { registerApprovals } from './modules/approvals/approvals.public';
import { assertCatalogueComplete } from './modules/subscriptions/subscriptions.seed';

/** BullMQ worker process (separate from the API). Each module registers its processors here. */
async function main(): Promise<void> {
  env();
  await sequelize.authenticate();
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
  await assertCatalogueComplete(); // every catalogue key has a row in every plan version (module 04)
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
