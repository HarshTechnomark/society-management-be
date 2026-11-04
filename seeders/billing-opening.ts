import { Op } from 'sequelize';
import { BillingRun, OpeningBalance, Society, Unit } from '../src/models';
import { istDate, now } from '../src/lib/clock';
import { residents } from '../src/modules/residents/residents.public';
import { postOpening } from '../src/modules/billing/billing.opening.service';
import { systemCtx, type Ctx } from '../src/types/context';

/**
 * Module 11.2 demo seed (not run in production): opening balances for Sky Heights CHS so the Settings > Billing > Opening
 * balances and statement screens have data. Three flats with arrears (one with interest) and one flat with an advance are
 * POSTED through the real post service (arrears invoices `OB/<flat>`, ledger entries, journals); one more arrears flat, one
 * more advance flat and one INVALID row (unknown flat) stay as an unposted import to show the DRAFT and INVALID states.
 * Idempotent: a society that already has any opening balance row is left alone. The as-of date is the day before the first
 * regular billing run when there is one (BR-11-65), else 31 March of the financial year, never after today.
 */
export interface BillingOpeningSeedReport {
  created: string[];
  skipped: string[];
}

const dayBefore = (ymd: string): string =>
  new Date(Date.parse(`${ymd}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);

async function asOfDateFor(societyId: number): Promise<string> {
  const run = await BillingRun.findOne({
    where: { societyId, runType: 'REGULAR', status: { [Op.notIn]: ['CANCELLED', 'FAILED'] } },
    attributes: ['periodStart'],
    order: [['periodStart', 'ASC']],
  });
  if (run) return dayBefore(run.periodStart);
  const today = istDate(now());
  const year = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) < 4 ? 1 : 0);
  const fyStart = `${year}-04-01`;
  return dayBefore(fyStart) > today ? today : dayBefore(fyStart);
}

export async function seedBillingOpening(): Promise<BillingOpeningSeedReport> {
  if (process.env.NODE_ENV === 'production')
    throw new Error('billing opening balance demo seed must not run in production');
  const report: BillingOpeningSeedReport = { created: [], skipped: [] };
  const society = await Society.findOne({ where: { slug: 'sky-heights' } });
  if (!society) return report;
  const societyId = society.id!;
  if ((await OpeningBalance.count({ where: { societyId } })) > 0) {
    report.skipped.push('sky-heights');
    return report;
  }
  const flats = await Unit.findAll({
    where: { societyId, status: 'ACTIVE' },
    attributes: ['id', 'label'],
    order: [['label', 'ASC']],
    limit: 40,
  });
  const billable: { id: number; label: string }[] = [];
  for (const f of flats) {
    if (billable.length >= 6) break;
    if (await residents.billToFor(Number(f.id), istDate(now())))
      billable.push({ id: Number(f.id), label: f.label });
  }
  if (billable.length < 5) {
    report.skipped.push('sky-heights (needs 5 flats with an owner: run the module 09 seed first)');
    return report;
  }
  const asOfDate = await asOfDateFor(societyId);
  const row = (
    unit: { id: number; label: string } | null,
    n: number,
    label: string,
    amounts: [number, number, number],
    status: 'DRAFT' | 'INVALID',
  ) => ({
    societyId,
    unitId: unit?.id ?? null,
    unitLabelInput: label,
    importFileId: 0, // demo rows have no uploaded file (module 01 files service is not built yet)
    importRowNo: n,
    asOfDate,
    arrearsPrincipalPaise: status === 'INVALID' ? 0 : amounts[0],
    arrearsInterestPaise: status === 'INVALID' ? 0 : amounts[1],
    advancePaise: status === 'INVALID' ? 0 : amounts[2],
    status,
    validationError: status === 'INVALID' ? 'Unknown flat' : null,
    activeKey: status === 'DRAFT' && unit ? `OB:${unit.id}` : null,
    invoiceId: null,
    postedAt: null,
    postedBy: null,
    reversedAt: null,
    reversedBy: null,
    reverseReason: null,
    createdBy: null,
    updatedBy: null,
    version: 1,
  });
  const [a, b, c, d, e, f] = billable;
  const ctx: Ctx = systemCtx('seed-billing-opening');
  const toPost: [number, { id: number; label: string }, [number, number, number]][] = [
    [2, a!, [1_250_000, 0, 0]],
    [3, b!, [820_050, 63_550, 0]],
    [4, c!, [538_000, 0, 0]],
    [5, d!, [0, 0, 300_000]],
  ];
  await OpeningBalance.bulkCreate(toPost.map(([n, u, amt]) => row(u, n, u.label, amt, 'DRAFT')) as never);
  const net = toPost.reduce((s, [, , x]) => s + x[0] + x[1] - x[2], 0);
  await postOpening(ctx, societyId, { confirmTotalPaise: net });
  report.created.push(`sky-heights: ${toPost.length} posted`);
  const rest = [
    row(e!, 6, e!.label, [275_000, 0, 0], 'DRAFT'),
    ...(f ? [row(f, 7, f.label, [0, 0, 150_000], 'DRAFT')] : []),
    row(null, 8, 'Z-999', [0, 0, 0], 'INVALID'),
  ];
  await OpeningBalance.bulkCreate(rest as never);
  report.created.push(`sky-heights: ${rest.length} left as an unposted import`);
  return report;
}
