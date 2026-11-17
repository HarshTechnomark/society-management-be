import { logger } from '../../lib/logger';
import { registerProcessor } from '../../lib/queue';
import { isFeatureOn } from '../subscriptions/entitlements.service';
import { ACCOUNTS_QUEUE, ENT, JOBS } from './accounts.constants';
import { runAutoMatch } from './accounts.statements.match';
import { processStatementParse } from './accounts.statements.service';
import { jobCtx } from './accounts.statements.shared';

/**
 * Jobs of 13.3b (section 9.1), payload `{ societyId, importId, requestId }`: `accounts:statement-parse` (does nothing unless the
 * import is UPLOADED) and `accounts:auto-match` (only touches UNMATCHED lines; re-running is safe). Both skip when the plan does
 * not include bank statement import.
 */
export function registerStatementJobs(): void {
  registerProcessor(ACCOUNTS_QUEUE, JOBS.statementParse, async data => {
    await processStatementParse(Number(data.societyId), Number(data.importId));
  });
  registerProcessor(ACCOUNTS_QUEUE, JOBS.autoMatch, async data => {
    const societyId = Number(data.societyId);
    if (!(await isFeatureOn(societyId, ENT.statementImport))) {
      logger.info({ societyId }, 'auto-match skipped: feature not in plan');
      return;
    }
    await runAutoMatch(jobCtx(societyId, String(data.requestId ?? 'job')), Number(data.importId));
  });
}
