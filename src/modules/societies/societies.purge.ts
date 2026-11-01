import { Op } from 'sequelize';
import { Society, SocietyLifecycleEvent, sequelize } from '../../models';
import { addDays, istDate, now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { endAllMembersForSociety } from '../access-control/access-control.public';
import { societyPorts } from './societies.ports';
import { AUDIT } from './societies.types';
import { writeEvent } from './societies.lifecycle';
import { groups, notifyAfterCommit, platformUsersWith } from './societies.notify';

/** Retention purge 90 days after closure (BR-05-21, 6.7) and the end of financial retention (BR-05-38). */

/** Financial tables that purge handlers must never touch (BR-05-21). */
export const FINANCIAL_TABLES = [
  'invoices',
  'invoice_lines',
  'billing_runs',
  'billing_run_items',
  'unit_ledger_entries',
  'opening_balances',
  'payment_orders',
  'payments',
  'payment_allocations',
  'refunds',
  'unit_advances',
  'collections',
  'ledger_accounts',
  'journal_entries',
  'journal_lines',
  'society_balances',
  'balance_history',
  'funds',
  'expenses',
  'bank_accounts',
  'settlements',
  'deposits',
  'audit_logs',
  'platform_invoices',
  'platform_invoice_lines',
  'platform_payments',
  'platform_credits',
  'dunning_events',
] as const;
/** File purposes kept unchanged until the end of financial retention. */
export const FINANCIAL_FILE_PURPOSES = [
  'INVOICE_PDF',
  'RECEIPT_PDF',
  'EXPENSE_BILL',
  'PLATFORM_INVOICE_PDF',
  'TDS_CERTIFICATE',
  'PLATFORM_ATTACHMENT',
] as const;

export interface PurgeHandler {
  module: string;
  /** Run order, highest first (modules 30 → 08). */
  order: number;
  /** Tables the handler deletes from or anonymises; financial tables are refused. */
  tables: string[];
  purge(societyId: number): Promise<{ deleted: number; anonymised: number }>;
}
export interface RetentionExpiryHandler {
  module: string;
  order: number;
  deleteRetained(societyId: number): Promise<{ deleted: number }>;
}

const purgeHandlers = new Map<string, PurgeHandler>();
const retentionHandlers = new Map<string, RetentionExpiryHandler>();

export function registerPurgeHandler(h: PurgeHandler): void {
  if (['platform-billing', 'platform_billing', '06'].includes(h.module))
    throw new Error('Module 06 registers no purge handler (its tables are kept 8 years)');
  const bad = h.tables.filter(t => (FINANCIAL_TABLES as readonly string[]).includes(t));
  if (bad.length) throw new Error(`Purge handler ${h.module} targets financial tables: ${bad.join(', ')}`);
  purgeHandlers.set(h.module, h);
}
export function registerRetentionExpiryHandler(h: RetentionExpiryHandler): void {
  retentionHandlers.set(h.module, h);
}
export const purgeHandlerList = (): PurgeHandler[] =>
  [...purgeHandlers.values()].sort((a, b) => b.order - a.order);
export const retentionHandlerList = (): RetentionExpiryHandler[] =>
  [...retentionHandlers.values()].sort((a, b) => b.order - a.order);
/** Test helpers. */
export const unregisterPurgeHandler = (m: string) => purgeHandlers.delete(m);
export const unregisterRetentionExpiryHandler = (m: string) => retentionHandlers.delete(m);

const JOB_CTX: Ctx = { requestId: 'job', ip: '', userAgent: '' };
const SYSTEM_ACTOR = { userId: null, name: 'System', role: 'system' };

/** Purges one society. Each handler runs in its own transaction and is idempotent; `purgedAt` is set last. */
export async function purgeSociety(societyId: number): Promise<boolean> {
  const s = await Society.findByPk(societyId);
  if (!s || s.status !== 'CLOSED' || s.purgedAt || s.purgeHoldReason || !s.purgeAfter || s.purgeAfter > now())
    return false;
  const counts: Record<string, { deleted: number; anonymised: number }> = {};
  for (const h of purgeHandlerList()) counts[h.module] = await h.purge(societyId);
  const filesDeleted = await societyPorts().files.deleteNonFinancialFiles(societyId, FINANCIAL_FILE_PURPOSES);
  await sequelize.transaction(async t => {
    const row = await Society.findByPk(societyId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!row || row.purgedAt || row.purgeHoldReason || row.status !== 'CLOSED') return;
    const ended = await endAllMembersForSociety(JOB_CTX, societyId, 'SOCIETY_PURGED', t);
    row.purgedAt = now();
    row.version += 1;
    await row.save({ transaction: t });
    const metadata = { handlers: counts, filesDeleted, membersEnded: ended };
    await writeEvent(
      JOB_CTX,
      societyId,
      {
        eventType: 'PURGED',
        fromStatus: 'CLOSED',
        toStatus: 'CLOSED',
        triggerSource: 'SYSTEM_JOB',
        triggerCode: 'RETENTION_ELAPSED',
        metadata,
      },
      t,
    );
    await audit(
      JOB_CTX,
      {
        action: AUDIT.purged,
        entityType: 'society',
        entityId: societyId,
        entityLabel: row.name,
        societyId,
        after: metadata,
        actor: SYSTEM_ACTOR,
      },
      t,
    );
  });
  return true;
}

/** `societies:purge-closed` (daily 03:30): warnings 7 days ahead, then purges. A failed society is retried next run. */
export async function runPurge(): Promise<{ warned: number; purged: number; failed: number }> {
  const t0 = now();
  let warned = 0;
  const soon = await Society.findAll({
    where: {
      status: 'CLOSED',
      purgedAt: null,
      purgeHoldReason: null,
      purgeAfter: { [Op.gt]: t0, [Op.lte]: addDays(t0, 7) },
    },
  });
  for (const s of soon) {
    const already = await SocietyLifecycleEvent.count({
      where: { societyId: s.id!, eventType: 'PURGE_WARNED', createdAt: { [Op.gte]: s.closedAt! } },
    });
    if (already) continue;
    await sequelize.transaction(async t => {
      await writeEvent(
        JOB_CTX,
        s.id!,
        {
          eventType: 'PURGE_WARNED',
          fromStatus: 'CLOSED',
          toStatus: 'CLOSED',
          triggerSource: 'SYSTEM_JOB',
          triggerCode: 'RETENTION_ELAPSED',
          metadata: { purgeAfter: s.purgeAfter!.toISOString() },
        },
        t,
      );
      const sid = s.id!;
      notifyAfterCommit(
        t,
        'societies.purge_warning',
        async () => [
          ...(await groups.exportViewers(sid)),
          ...(await platformUsersWith('platform.societies.delete')),
        ],
        { societyName: s.name, purgeAfter: s.purgeAfter!.toISOString() },
      );
    });
    warned++;
  }
  const due = await Society.findAll({
    where: { status: 'CLOSED', purgedAt: null, purgeHoldReason: null, purgeAfter: { [Op.lte]: t0 } },
    attributes: ['id'],
    order: [['id', 'ASC']],
  });
  let purged = 0;
  let failed = 0;
  for (const s of due)
    try {
      if (await purgeSociety(s.id!)) purged++;
    } catch (err) {
      failed++;
      logger.error({ err, societyId: s.id }, 'society purge failed; retried next run');
    }
  return { warned, purged, failed };
}

/** `societies:expire-financial-retention` (yearly, 1 April 02:00 IST): BR-05-38. */
export async function runFinancialRetention(): Promise<{ done: number; failed: number }> {
  const today = istDate(now());
  const rows = await Society.findAll({
    where: {
      status: 'CLOSED',
      purgedAt: { [Op.ne]: null },
      financialPurgedAt: null,
      purgeHoldReason: null,
      financialRetainUntil: { [Op.lt]: today },
    },
    order: [['id', 'ASC']],
  });
  let done = 0;
  let failed = 0;
  for (const s of rows) {
    try {
      const counts: Record<string, { deleted: number }> = {};
      for (const h of retentionHandlerList()) counts[h.module] = await h.deleteRetained(s.id!);
      const filesDeleted = await societyPorts().files.deleteFinancialFiles(s.id!, FINANCIAL_FILE_PURPOSES);
      await sequelize.transaction(async t => {
        const row = await Society.findByPk(s.id!, { transaction: t, lock: t.LOCK.UPDATE });
        if (!row || row.financialPurgedAt || row.purgeHoldReason) return;
        row.financialPurgedAt = now();
        row.version += 1;
        await row.save({ transaction: t });
        const metadata = { handlers: counts, filesDeleted };
        await writeEvent(
          JOB_CTX,
          row.id!,
          {
            eventType: 'FINANCIAL_PURGED',
            fromStatus: 'CLOSED',
            toStatus: 'CLOSED',
            triggerSource: 'SYSTEM_JOB',
            triggerCode: 'RETENTION_ELAPSED',
            metadata,
          },
          t,
        );
        await audit(
          JOB_CTX,
          {
            action: AUDIT.financialDeleted,
            entityType: 'society',
            entityId: row.id!,
            entityLabel: row.name,
            societyId: row.id!,
            after: metadata,
            actor: SYSTEM_ACTOR,
          },
          t,
        );
      });
      done++;
    } catch (err) {
      failed++;
      logger.error({ err, societyId: s.id }, 'financial retention expiry failed; retried next run');
    }
  }
  return { done, failed };
}
