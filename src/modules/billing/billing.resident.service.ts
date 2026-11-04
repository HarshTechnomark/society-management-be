import { ensureStoredOutsideProduction } from './billing.pdf.service';
import { Op, type WhereOptions } from 'sequelize';
import { Invoice, Resident, Tenancy, Unit, UnitResident } from '../../models';
import type { Ctx } from '../../types/context';
import { AppError, NotFoundError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import { isFeatureOn } from '../subscriptions/entitlements.service';
import { societyPorts } from '../societies/societies.ports';
import { FEATURES } from './billing.constants';
import { invoiceDetailDto, invoiceItemDto, isOverdueOn } from './billing.resident.dto';
import { societyToday } from './billing.setup.shared';
import { getStatement } from './billing.statement.service';

/**
 * Resident routes of section 8.21 (BR-11-61, BR-11-62). A resident sees an invoice when (a) they are its bill-to resident, even
 * after the link ended; or (b) the flat is one of their units and their relation is owner (all invoices of the flat), or they are
 * a household member of an owner (all invoices of the flat) or of the bill-to tenant (that tenant's invoices). Tenants never see
 * owner invoices. The statement mixes owner and tenant documents, so only the owner side sees it. Anything else is a 404.
 */
interface Scope {
  societyId: number;
  userId: number;
  residentIds: number[];
  ownerUnitIds: number[];
  /** Household of a tenant: the flat and the tenant resident whose invoices the member sees. */
  tenantHouseholds: { unitId: number; tenantResidentId: number }[];
}

export async function scopeOf(ctx: Ctx): Promise<Scope> {
  const societyId = ctx.society!.id;
  const userId = ctx.user!.id;
  const today = await societyToday(societyId);
  const residents = await Resident.findAll({
    where: { societyId, userId },
    attributes: ['id'],
    paranoid: false,
  });
  const residentIds = residents.map(r => Number(r.id));
  const owner = new Set<number>((ctx.unitLinks ?? []).filter(l => l.relation === 'OWNER').map(l => l.unitId));
  const tenantHouseholds: Scope['tenantHouseholds'] = [];
  const family = residentIds.length
    ? await UnitResident.findAll({
        where: {
          societyId,
          residentId: { [Op.in]: residentIds },
          relation: { [Op.in]: ['FAMILY', 'CARETAKER'] },
          fromDate: { [Op.lte]: today },
          [Op.or]: [{ toDate: null }, { toDate: { [Op.gte]: today } }],
        },
      })
    : [];
  for (const l of family) {
    if (!l.tenancyId) owner.add(Number(l.unitId));
    else {
      const tn = await Tenancy.findOne({
        where: { id: l.tenancyId, societyId },
        attributes: ['tenantResidentId'],
      });
      if (tn)
        tenantHouseholds.push({ unitId: Number(l.unitId), tenantResidentId: Number(tn.tenantResidentId) });
    }
  }
  return { societyId, userId, residentIds, ownerUnitIds: [...owner], tenantHouseholds };
}

/** The Sequelize condition for the invoices of the society that the caller may see (BR-11-61). */
export function visibleWhere(s: Scope): WhereOptions {
  const or: WhereOptions[] = [];
  if (s.residentIds.length) or.push({ billToResidentId: { [Op.in]: s.residentIds } });
  if (s.ownerUnitIds.length) or.push({ unitId: { [Op.in]: s.ownerUnitIds } });
  for (const h of s.tenantHouseholds) or.push({ unitId: h.unitId, billToResidentId: h.tenantResidentId });
  return { societyId: s.societyId, [Op.or]: or.length ? or : [{ id: 0 }] };
}

const notFound = () => new NotFoundError('INVOICE_NOT_FOUND', 'Invoice not found');

/** `GET /me/dues`. */
export async function myDues(ctx: Ctx) {
  const s = await scopeOf(ctx);
  const today = await societyToday(s.societyId);
  const open = await Invoice.findAll({
    where: {
      ...visibleWhere(s),
      status: { [Op.in]: ['ISSUED', 'PARTIALLY_PAID'] },
      outstandingPaise: { [Op.gt]: 0 },
    },
    attributes: ['unitId', 'unitLabel', 'dueDate', 'outstandingPaise', 'status'],
  });
  const relationOf = new Map((ctx.unitLinks ?? []).map(l => [l.unitId, l.relation]));
  const unitIds = new Set<number>([...(ctx.unitIds ?? []), ...open.map(i => Number(i.unitId))]);
  const labels = new Map<number, string>(open.map(i => [Number(i.unitId), i.unitLabel]));
  const missing = [...unitIds].filter(u => !labels.has(u));
  if (missing.length) {
    for (const u of await Unit.findAll({
      where: { societyId: s.societyId, id: { [Op.in]: missing } },
      attributes: ['id', 'label'],
    }))
      labels.set(Number(u.id), u.label);
  }
  const units = [...unitIds]
    .map(unitId => {
      const mine = open.filter(i => Number(i.unitId) === unitId);
      const upcoming =
        mine
          .map(i => i.dueDate)
          .filter(d => d >= today)
          .sort()[0] ?? null;
      return {
        unitId,
        unitLabel: labels.get(unitId) ?? '',
        relation: relationOf.get(unitId) ?? 'FORMER',
        outstandingPaise: mine.reduce((a, i) => a + Number(i.outstandingPaise), 0),
        overduePaise: mine
          .filter(i => isOverdueOn(i, today))
          .reduce((a, i) => a + Number(i.outstandingPaise), 0),
        nextDueDate: upcoming,
        openInvoiceCount: mine.length,
      };
    })
    .sort((a, b) => a.unitLabel.localeCompare(b.unitLabel));
  return { units };
}

export interface MyInvoicesQuery {
  unitId?: number;
  status: 'OPEN' | 'PAID' | 'ALL';
  financialYear?: string;
  page: number;
  limit: number;
}

/** `GET /me/invoices`: `404 UNIT_NOT_FOUND` for a unit that is neither the caller's nor one where they were billed. */
export async function myInvoices(ctx: Ctx, q: MyInvoicesQuery) {
  const s = await scopeOf(ctx);
  const today = await societyToday(s.societyId);
  const where: Record<string, unknown> = {};
  if (q.unitId !== undefined) {
    const own = (ctx.unitIds ?? []).includes(q.unitId);
    const billed =
      !own && s.residentIds.length
        ? await Invoice.count({
            where: { societyId: s.societyId, unitId: q.unitId, billToResidentId: { [Op.in]: s.residentIds } },
          })
        : 0;
    if (!own && !billed) throw new NotFoundError('UNIT_NOT_FOUND', 'Unit not found');
    where.unitId = q.unitId;
  }
  if (q.status === 'OPEN') {
    where.status = { [Op.in]: ['ISSUED', 'PARTIALLY_PAID'] };
    where.outstandingPaise = { [Op.gt]: 0 };
  } else if (q.status === 'PAID') where.status = 'PAID';
  if (q.financialYear) where.financialYear = q.financialYear;
  const full = { [Op.and]: [visibleWhere(s), where] };
  const total = await Invoice.count({ where: full });
  const rows = await Invoice.findAll({
    where: full,
    order: [
      ['invoiceDate', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { items: rows.map(r => invoiceItemDto(r, today)), pagination: pageMeta(q.page, q.limit, total) };
}

async function visibleInvoice(ctx: Ctx, id: number): Promise<{ inv: Invoice; scope: Scope }> {
  const scope = await scopeOf(ctx);
  const inv = await Invoice.findOne({ where: { [Op.and]: [visibleWhere(scope), { id }] } });
  if (!inv) throw notFound();
  return { inv, scope };
}

/** `GET /me/invoices/:id`: the detail of 8.12; `computation` only with `billing.explain_my_bill`. */
export async function myInvoice(ctx: Ctx, id: number) {
  const { inv, scope } = await visibleInvoice(ctx, id);
  const today = await societyToday(scope.societyId);
  const explain = await isFeatureOn(scope.societyId, FEATURES.explainMyBill);
  const dto = await invoiceDetailDto(inv, today, { explain });
  return {
    ...dto,
    pdfUrl: inv.pdfStatus === 'READY' && inv.pdfFileId ? `/me/invoices/${dto.id}/pdf-url` : null,
  };
}

/** `GET /me/invoices/:id/pdf-url`: `409 PDF_NOT_READY` while pending, failed or for an opening balance (no file). */
export async function myInvoicePdfUrl(ctx: Ctx, id: number) {
  const inv = await ensureStoredOutsideProduction('invoice', (await visibleInvoice(ctx, id)).inv);
  if (inv.pdfStatus !== 'READY' || !inv.pdfFileId)
    throw new AppError(409, 'PDF_NOT_READY', 'The bill PDF is not ready yet');
  const link = await societyPorts().files.downloadUrl(Number(inv.pdfFileId), 5);
  return { url: link.url, expiresAt: link.expiresAt.toISOString() };
}

/** `GET /me/units/:unitId/statement`: owner side only (BR-11-62), else `404 UNIT_NOT_FOUND`. */
export async function myStatement(ctx: Ctx, unitId: number, range: { from?: string; to?: string }) {
  const s = await scopeOf(ctx);
  if (!s.ownerUnitIds.includes(unitId)) throw new NotFoundError('UNIT_NOT_FOUND', 'Unit not found');
  return getStatement(s.societyId, unitId, range);
}
