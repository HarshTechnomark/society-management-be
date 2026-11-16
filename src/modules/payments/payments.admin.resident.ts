import { Op, literal, type WhereOptions } from 'sequelize';
import { Payment, Refund, Unit } from '../../models';
import type { Ctx } from '../../types/context';
import { NotFoundError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import { scopeOf } from '../billing/billing.resident.service';
import { ERR } from './payments.constants';
import { allocationsOf } from './payments.admin.queries';
import { dateOnly, isoOrNull, residentItem } from './payments.admin.dto';
import { receiptUrlOf } from './payments.receipts.service';
import { n } from './payments.shared';

/**
 * Resident payments (8.5): the payments of the caller's flats that did not fail. An owner (and an owner's household) sees every
 * payment of the flat; a tenant sees the payments they made or that went to bills addressed to them (same rule as module 11 bills).
 */
async function visibleWhere(ctx: Ctx): Promise<WhereOptions> {
  const s = await scopeOf(ctx);
  const tenantUnits = (ctx.unitIds ?? []).filter(u => !s.ownerUnitIds.includes(u));
  const billedTo = [...new Set([...s.residentIds, ...s.tenantHouseholds.map(h => h.tenantResidentId)])];
  const or: WhereOptions[] = [];
  if (s.ownerUnitIds.length) or.push({ unitId: { [Op.in]: s.ownerUnitIds } });
  if (tenantUnits.length) {
    const mine: WhereOptions[] = [{ payerUserId: s.userId }];
    if (billedTo.length)
      mine.push(
        literal(
          `Payment.id IN (SELECT a.paymentId FROM payment_allocations a JOIN invoices i ON i.id = a.invoiceId
             WHERE a.paymentId IS NOT NULL AND i.billToResidentId IN (${billedTo.map(Number).join(',')}))`,
        ),
      );
    or.push({ unitId: { [Op.in]: tenantUnits }, [Op.or]: mine });
  }
  return {
    societyId: s.societyId,
    status: { [Op.ne]: 'FAILED' },
    [Op.or]: or.length ? or : [{ id: 0 }],
  };
}

const notFound = () => new NotFoundError(ERR.paymentNotFound, 'Payment not found');

export async function myPayments(
  ctx: Ctx,
  q: {
    unitId?: number;
    from?: string;
    to?: string;
    sortBy: 'paymentDate' | 'amountPaise';
    sortOrder: 'asc' | 'desc';
    page: number;
    limit: number;
  },
) {
  if (q.unitId !== undefined && !(ctx.unitIds ?? []).includes(q.unitId))
    throw new NotFoundError(ERR.unitNotFound, 'Unit not found');
  const and: WhereOptions[] = [await visibleWhere(ctx)];
  if (q.unitId) and.push({ unitId: q.unitId });
  if (q.from) and.push({ paymentDate: { [Op.gte]: q.from } });
  if (q.to) and.push({ paymentDate: { [Op.lte]: q.to } });
  const { rows, count } = await Payment.findAndCountAll({
    where: { [Op.and]: and },
    include: [{ model: Unit, attributes: ['label'], required: false }],
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
    distinct: true,
  });
  return {
    items: rows.map(p => residentItem(p, (p as unknown as { Unit?: { label: string } }).Unit?.label ?? '')),
    pagination: pageMeta(q.page, q.limit, count),
  };
}

async function visiblePayment(ctx: Ctx, id: number): Promise<Payment> {
  const p = await Payment.findOne({
    where: { [Op.and]: [await visibleWhere(ctx), { id }] },
    include: [{ model: Unit, attributes: ['label'], required: false }],
  });
  if (!p) throw notFound();
  return p;
}

export async function myPayment(ctx: Ctx, id: number) {
  const p = await visiblePayment(ctx, id);
  const [allocations, refunds] = await Promise.all([
    allocationsOf(n(p.id)),
    Refund.findAll({ where: { paymentId: id }, order: [['id', 'ASC']] }),
  ]);
  return {
    ...residentItem(p, (p as unknown as { Unit?: { label: string } }).Unit?.label ?? ''),
    receiptRevision: n(p.receiptRevision),
    allocations: allocations.map(({ id: aid, ...a }) => ({ id: aid, ...a })),
    cheque:
      p.method === 'CHEQUE'
        ? {
            bankName: p.chequeBankName,
            chequeNo: p.referenceNo,
            chequeDate: dateOnly(p.chequeDate),
            depositedOn: dateOnly(p.depositedOn),
            clearedOn: dateOnly(p.clearedOn),
            bouncedOn: dateOnly(p.bouncedOn),
          }
        : null,
    refunds: refunds.map(r => ({
      id: n(r.id),
      amountPaise: n(r.amountPaise),
      status: r.status,
      createdAt: isoOrNull(r.createdAt),
    })),
  };
}

export async function myReceiptUrl(ctx: Ctx, id: number) {
  return receiptUrlOf(await visiblePayment(ctx, id));
}
