import { QueryTypes } from 'sequelize';
import { Op } from 'sequelize';
import { Settlement, sequelize } from '../../models';
import { enqueue, registerProcessor, registerRepeatable } from '../../lib/queue';
import { logger } from '../../lib/logger';
import { now } from '../../lib/clock';
import { systemCtx } from '../../types/context';
import { entitlements } from '../subscriptions/subscriptions.public';
import { settings } from '../society-setup/society-setup.public';
import { withSociety } from '../payments/payments.shared';
import { ACCOUNTS_QUEUE, ENT, JOBS, NOTIFY, SETTING_DEFAULTS } from './accounts.constants';
import { accountsPorts } from './accounts.ports';
import { addDaysYmd, n, societyToday } from './accounts.shared';
import { RETRY_DAYS, reconcileSettlement } from './accounts.settlements.service';

const featureOn = (societyId: number) =>
  entitlements.isFeatureOn(societyId, ENT.settlements).catch(() => false);

/**
 * `accounts:settlement-reconcile` (section 9.1): with `{ settlementId, societyId }` one settlement (on ingest); without data the
 * 30 minute dispatcher over RECEIVED and MISMATCH settlements younger than 7 days.
 */
export async function settlementReconcileJob(data: Record<string, unknown>): Promise<number> {
  let rows: { id: number; societyId: number }[];
  if (data.settlementId) rows = [{ id: Number(data.settlementId), societyId: Number(data.societyId) }];
  else {
    const since = new Date(now().getTime() - RETRY_DAYS * 86_400_000);
    rows = (
      await Settlement.findAll({
        where: { status: { [Op.in]: ['RECEIVED', 'MISMATCH'] }, createdAt: { [Op.gte]: since } },
        attributes: ['id', 'societyId'],
        order: [['id', 'ASC']],
      })
    ).map(s => ({ id: n(s.id), societyId: n(s.societyId) }));
  }
  let posted = 0;
  for (const r of rows) {
    if (!(await featureOn(r.societyId))) {
      logger.info({ societyId: r.societyId }, 'settlement reconcile skipped: feature off');
      continue;
    }
    try {
      const ctx = withSociety(systemCtx('accounts:settlement-reconcile'), r.societyId);
      const out = await reconcileSettlement(ctx, r.societyId, r.id);
      if (out.status === 'POSTED') posted += 1;
    } catch (err) {
      logger.warn({ err, settlementId: r.id }, 'settlement reconcile failed');
    }
  }
  return posted;
}

/**
 * Gateway clearing (1140) debits dated before today minus `finance.clearingAlertDays` that no settlement has credited yet (oldest
 * debits are settled first). Returns the aged amount in paise.
 */
export async function agedClearingPaise(societyId: number, today: string, days: number): Promise<number> {
  const cutoff = addDaysYmd(today, -days);
  const [row] = await sequelize.query<{ debits: string; credits: string; agedDebits: string }>(
    `SELECT COALESCE(SUM(l.debitPaise), 0) AS debits, COALESCE(SUM(l.creditPaise), 0) AS credits,
            COALESCE(SUM(CASE WHEN e.entryDate <= :cutoff THEN l.debitPaise ELSE 0 END), 0) AS agedDebits
       FROM journal_lines l
       JOIN journal_entries e ON e.id = l.journalEntryId AND e.status = 'POSTED'
       JOIN ledger_accounts a ON a.id = l.ledgerAccountId
      WHERE a.societyId = :societyId AND a.code = '1140'`,
    { replacements: { societyId, cutoff }, type: QueryTypes.SELECT },
  );
  if (!row) return 0;
  return Math.max(0, Math.min(n(row.agedDebits) - n(row.credits), n(row.debits) - n(row.credits)));
}

/** `accounts:clearing-age`: one society (`{ societyId }`) or the daily dispatcher that enqueues one job per society per local day. */
export async function clearingAgeJob(data: Record<string, unknown>): Promise<number> {
  if (!data.societyId) {
    const ids = await sequelize.query<{ societyId: number }>(
      'SELECT societyId FROM society_balances WHERE chartSeededAt IS NOT NULL ORDER BY societyId',
      { type: QueryTypes.SELECT },
    );
    for (const r of ids) {
      const societyId = n(r.societyId);
      const day = await societyToday(societyId);
      await enqueue(
        ACCOUNTS_QUEUE,
        JOBS.clearingAge,
        { societyId },
        { jobId: `clearing-age:${societyId}:${day}` },
      );
    }
    return ids.length;
  }
  const societyId = Number(data.societyId);
  if (!(await featureOn(societyId))) return 0;
  const raw = await Promise.resolve(settings.get(societyId, 'finance.clearingAlertDays' as never)).catch(
    () => null,
  );
  const days = Number(raw ?? SETTING_DEFAULTS['finance.clearingAlertDays']);
  const aged = await agedClearingPaise(societyId, await societyToday(societyId), days);
  if (aged <= 0) return 0;
  const users = await sequelize.query<{ userId: number }>(
    `SELECT DISTINCT m.userId FROM society_members m JOIN roles r ON r.id = m.roleId
      WHERE m.societyId = :societyId AND m.status = 'ACTIVE' AND r.\`key\` = 'treasurer'`,
    { replacements: { societyId }, type: QueryTypes.SELECT },
  );
  await accountsPorts().notifications.send(
    NOTIFY.clearingAged,
    users.map(u => n(u.userId)),
    { societyId, agedPaise: aged, days },
  );
  return 1;
}

/** One line of `registerAccountsJobs()` (13.3, settlement half; the statement half is added by the statements part). */
export function registerSettlementJobs(): void {
  registerProcessor(ACCOUNTS_QUEUE, JOBS.settlementReconcile, settlementReconcileJob);
  registerRepeatable(ACCOUNTS_QUEUE, JOBS.settlementReconcile, { everyMs: 30 * 60_000 });
  registerProcessor(ACCOUNTS_QUEUE, JOBS.clearingAge, clearingAgeJob);
  registerRepeatable(ACCOUNTS_QUEUE, JOBS.clearingAge, { dailyAtIst: '08:00' });
}
