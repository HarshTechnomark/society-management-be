import type { Ctx } from '../../types/context';
import { audit } from '../../utils/audit';
import { pageMeta } from '../../utils/pagination';
import { toCsv } from '../society-setup/society-setup.csv';
import { AUDIT } from './billing.constants';
import { cachedSummary } from './billing.dues.cache';
import { defaultersOf, summaryOf, type DefaulterRow, type SummaryDto } from './billing.dues.queries';
import { societyToday } from './billing.setup.shared';
import { rupeeText } from './billing.statement.service';

/** Dues dashboard and defaulter list (section 8.22); the notes reads of 8.19 are `billing.notes.queries.ts` (11.4). The measures live in `billing.dues.queries.ts`. */

/** `GET /billing/summary`: cached 30 seconds per society and month. */
export async function getSummary(societyId: number, month?: string): Promise<SummaryDto & { month: string }> {
  const today = await societyToday(societyId);
  const m = month ?? today.slice(0, 7);
  const data = await cachedSummary(societyId, m, () => summaryOf(societyId, m, today));
  return { month: m, ...data };
}

export interface DefaultersInput {
  minDaysOverdue: number;
  minAmountPaise: number;
  buildingId?: number;
  sortBy: 'overduePaise' | 'daysOverdue' | 'unitLabel';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}
export type DefaulterItem = Omit<DefaulterRow, 'ownerMobile'>;

/** `GET /billing/defaulters` JSON: BR-11-64, items of 8.22 (the owner's mobile is not part of the endpoint). */
export async function listDefaulters(societyId: number, q: DefaultersInput) {
  const today = await societyToday(societyId);
  const r = await defaultersOf(
    societyId,
    {
      minDaysOverdue: q.minDaysOverdue,
      minAmountPaise: q.minAmountPaise,
      buildingIds: q.buildingId ? [q.buildingId] : undefined,
      sortBy: q.sortBy,
      sortDir: q.sortOrder,
      page: q.page,
      limit: q.limit,
    },
    today,
  );
  return {
    items: r.rows.map(({ ownerMobile: _m, ...row }): DefaulterItem => row),
    totals: r.totals,
    pagination: pageMeta(q.page, q.limit, r.total),
  };
}

/** The whole defaulter list as CSV (audited by the controller); at most 50,000 flats. */
export async function defaultersCsv(
  ctx: Ctx,
  societyId: number,
  q: DefaultersInput,
): Promise<{ file: Buffer; flats: number }> {
  const today = await societyToday(societyId);
  const r = await defaultersOf(
    societyId,
    {
      minDaysOverdue: q.minDaysOverdue,
      minAmountPaise: q.minAmountPaise,
      buildingIds: q.buildingId ? [q.buildingId] : undefined,
      sortBy: q.sortBy,
      sortDir: q.sortOrder,
      page: 1,
      limit: 50_000,
    },
    today,
  );
  await audit(ctx, {
    action: AUDIT.defaultersExported,
    entityType: 'defaulter_list',
    entityId: societyId,
    societyId,
    after: {
      flats: r.rows.length,
      minDaysOverdue: q.minDaysOverdue,
      minAmountPaise: q.minAmountPaise,
      buildingId: q.buildingId ?? null,
    },
  });
  const file = toCsv(
    ['Flat', 'Owner', 'Billed to', 'Overdue (INR)', 'Oldest due date', 'Days overdue', 'Open invoices'],
    r.rows.map(x => [
      x.unitLabel,
      x.ownerName,
      x.billToNames,
      rupeeText(x.overduePaise),
      x.oldestDueDate,
      x.daysOverdue,
      x.invoiceCount,
    ]),
  );
  return { file, flats: r.rows.length };
}
