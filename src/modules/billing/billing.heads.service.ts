import { Op, type Transaction } from 'sequelize';
import { BillingRule, BillingRuleVersion, ChargeHead, sequelize } from '../../models';
import { audit } from '../../utils/audit';
import { pageMeta } from '../../utils/pagination';
import { AppError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { AUDIT, NEVER_THRESHOLD_HEAD_TYPES, OWNER_ONLY_HEAD_TYPES } from './billing.constants';
import { billingPorts } from './billing.ports';
import { SEED_HEADS } from './billing.heads.seed';
import type { HeadCreateInput, HeadListQuery, HeadPatchInput } from './billing.heads.validation';
import {
  actorId,
  chargeHeadNotFound,
  invalidState,
  isUniqueViolation,
  staleVersion,
  societyToday,
  unprocessable,
} from './billing.setup.shared';

/** Charge heads (section 5.2, 8.1): the seed of 7.13, list, create, edit and archive. */
const ENTITY = 'charge_head';

export interface ChargeHeadDto {
  id: number;
  societyId: number;
  key: string;
  name: string;
  description: string | null;
  headType: string;
  payerRouting: string;
  gstTreatment: string;
  sacCode: string | null;
  prorate: boolean;
  interestBearing: boolean;
  ledgerAccountCode: string;
  fundId: number | null;
  isSystem: boolean;
  status: string;
  sortOrder: number;
  createdBy: number | null;
  updatedBy: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
export function headDto(h: ChargeHead): ChargeHeadDto {
  return {
    id: Number(h.id),
    societyId: Number(h.societyId),
    key: h.key,
    name: h.name,
    description: h.description,
    headType: h.headType,
    payerRouting: h.payerRouting,
    gstTreatment: h.gstTreatment,
    sacCode: h.sacCode,
    prorate: Boolean(h.prorate),
    interestBearing: Boolean(h.interestBearing),
    ledgerAccountCode: h.ledgerAccountCode,
    fundId: num(h.fundId),
    isSystem: Boolean(h.isSystem),
    status: h.status,
    sortOrder: Number(h.sortOrder),
    createdBy: num(h.createdBy),
    updatedBy: num(h.updatedBy),
    version: Number(h.version),
    createdAt: h.createdAt!.toISOString(),
    updatedAt: h.updatedAt!.toISOString(),
  };
}
const auditView = (h: ChargeHead) => ({
  name: h.name,
  description: h.description,
  payerRouting: h.payerRouting,
  gstTreatment: h.gstTreatment,
  sacCode: h.sacCode,
  prorate: h.prorate,
  interestBearing: h.interestBearing,
  ledgerAccountCode: h.ledgerAccountCode,
  fundId: num(h.fundId),
  sortOrder: Number(h.sortOrder),
  status: h.status,
});

/**
 * `chargeHeads.ensureSeeded(societyId, t)` (section 7.13): inserts the heads of the seed list that the society does not have yet
 * (by `key`; existing rows are never touched). Safe to call at any time and in parallel (a duplicate insert is ignored).
 */
export async function ensureSeeded(societyId: number, t?: Transaction): Promise<{ created: number }> {
  const have = new Set(
    (
      await ChargeHead.findAll({
        where: { societyId, key: { [Op.in]: SEED_HEADS.map(h => h.key) } },
        attributes: ['key'],
        transaction: t,
      })
    ).map(h => h.key),
  );
  const missing = SEED_HEADS.filter(h => !have.has(h.key));
  if (!missing.length) return { created: 0 };
  await ChargeHead.bulkCreate(
    missing.map(h => ({
      societyId,
      key: h.key,
      name: h.name,
      description: null,
      headType: h.headType,
      payerRouting: h.payerRouting,
      gstTreatment: h.gstTreatment,
      sacCode: null,
      prorate: h.prorate,
      interestBearing: h.interestBearing,
      ledgerAccountCode: h.ledgerAccountCode,
      fundId: null,
      isSystem: h.isSystem,
      status: 'ACTIVE' as const,
      sortOrder: h.sortOrder,
      createdBy: null,
      updatedBy: null,
      version: 1,
    })),
    { ignoreDuplicates: true, transaction: t },
  );
  return { created: missing.length };
}

/** A head of the society by id (404 CHARGE_HEAD_NOT_FOUND). `lock` takes `SELECT ... FOR UPDATE`. */
export async function getHead(
  societyId: number,
  id: number,
  t?: Transaction,
  lock = false,
): Promise<ChargeHead> {
  const h = await ChargeHead.findOne({
    where: { id, societyId },
    transaction: t,
    ...(lock && t ? { lock: t.LOCK.UPDATE } : {}),
  });
  if (!h) throw chargeHeadNotFound();
  return h;
}
/** A head by key (null when unknown), for other modules (`createAdHoc`, debit notes). */
export const findHeadByKey = (societyId: number, key: string, t?: Transaction) =>
  ChargeHead.findOne({ where: { societyId, key }, transaction: t });

/** `GET /billing/charge-heads`. */
export async function listHeads(societyId: number, q: HeadListQuery) {
  await ensureSeeded(societyId);
  const where: Record<string | symbol, unknown> = { societyId };
  if (q.status !== 'ALL') where.status = q.status;
  if (q.headType) where.headType = q.headType;
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
    where[Op.or] = [{ key: { [Op.like]: like } }, { name: { [Op.like]: like } }];
  }
  const total = await ChargeHead.count({ where });
  const rows = await ChargeHead.findAll({
    where,
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'ASC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { data: rows.map(headDto), pagination: pageMeta(q.page, q.limit, total) };
}

/** BR-11-9, BR-11-10, BR-11-31 on the resulting head. */
async function assertHeadRules(
  societyId: number,
  h: Pick<ChargeHead, 'headType' | 'payerRouting' | 'gstTreatment' | 'sacCode' | 'ledgerAccountCode'>,
  check: { ledger: boolean; sac: boolean },
): Promise<void> {
  if ((OWNER_ONLY_HEAD_TYPES as readonly string[]).includes(h.headType) && h.payerRouting !== 'OWNER')
    throw unprocessable(
      'CHARGE_HEAD_ROUTING_INVALID',
      'Sinking fund, repair fund and non-occupancy heads are always billed to the owner',
      'payerRouting',
    );
  if (
    h.gstTreatment === 'THRESHOLD' &&
    (NEVER_THRESHOLD_HEAD_TYPES as readonly string[]).includes(h.headType)
  )
    throw unprocessable(
      'RATE_TYPE_NOT_ALLOWED',
      'The GST threshold test never applies to this kind of head',
      'gstTreatment',
    );
  if (h.headType === 'DEPOSIT' && h.gstTreatment !== 'NONE')
    throw unprocessable(
      'RATE_TYPE_NOT_ALLOWED',
      'A refundable deposit is not a supply and stays untaxed',
      'gstTreatment',
    );
  if (check.sac && h.gstTreatment !== 'NONE' && h.gstTreatment !== 'FOLLOW_SOURCE' && !h.sacCode)
    throw new ValidationError([
      { field: 'sacCode', message: 'The SAC code is required when the head is taxed' },
    ]);
  if (check.ledger && !(await billingPorts().journal.accountExists(societyId, h.ledgerAccountCode)))
    throw unprocessable(
      'LEDGER_ACCOUNT_NOT_FOUND',
      'This account is not in the chart of accounts',
      'ledgerAccountCode',
    );
}

/** `POST /billing/charge-heads`. */
export async function createHead(
  ctx: Ctx,
  societyId: number,
  input: HeadCreateInput,
): Promise<ChargeHeadDto> {
  await ensureSeeded(societyId);
  const resolved = {
    headType: input.headType as ChargeHead['headType'],
    payerRouting: input.payerRouting ?? 'BILL_TO',
    gstTreatment: input.gstTreatment ?? 'NONE',
    sacCode: input.sacCode ?? null,
    ledgerAccountCode: input.ledgerAccountCode,
  };
  await assertHeadRules(societyId, resolved, { ledger: true, sac: true });
  try {
    return await sequelize.transaction(async t => {
      if (
        await ChargeHead.findOne({ where: { societyId, key: input.key }, transaction: t, attributes: ['id'] })
      )
        throw keyTaken();
      const row = await ChargeHead.create(
        {
          societyId,
          key: input.key,
          name: input.name,
          description: input.description ?? null,
          ...resolved,
          prorate: input.prorate ?? true,
          interestBearing: input.interestBearing ?? true,
          fundId: input.fundId ?? null,
          isSystem: false,
          status: 'ACTIVE',
          sortOrder: input.sortOrder ?? 100,
          createdBy: actorId(ctx),
          updatedBy: actorId(ctx),
          version: 1,
        },
        { transaction: t },
      );
      await audit(
        ctx,
        {
          action: AUDIT.chargeHeadCreated,
          entityType: ENTITY,
          entityId: row.id!,
          entityLabel: row.key,
          societyId,
          after: { key: row.key, headType: row.headType, ...auditView(row) },
        },
        t,
      );
      return headDto(row);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw keyTaken();
    throw err;
  }
}
const keyTaken = () =>
  new AppError(409, 'CHARGE_HEAD_KEY_TAKEN', 'A charge head with this key already exists');

/** System heads (BR-11-11): only these fields change. */
const SYSTEM_EDITABLE = new Set(['name', 'description', 'sortOrder', 'sacCode', 'version']);

/** `PATCH /billing/charge-heads/:id`. */
export async function updateHead(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: HeadPatchInput,
): Promise<ChargeHeadDto> {
  return sequelize.transaction(async t => {
    const h = await getHead(societyId, id, t, true);
    if (Number(h.version) !== input.version) throw staleVersion('charge head');
    const before = auditView(h);
    const { version: _v, ...patch } = input;
    void _v;
    if (h.isSystem) {
      const forbidden = Object.entries(patch).filter(
        ([k, v]) =>
          !SYSTEM_EDITABLE.has(k) && v !== undefined && v !== (h as unknown as Record<string, unknown>)[k],
      );
      if (forbidden.length)
        throw unprocessable(
          'CHARGE_HEAD_SYSTEM',
          'Only the name, description, sort order and SAC code of a system head can change',
          forbidden[0]![0],
        );
    }
    const next = {
      headType: h.headType,
      payerRouting: patch.payerRouting ?? h.payerRouting,
      gstTreatment: patch.gstTreatment ?? h.gstTreatment,
      sacCode: patch.sacCode === undefined ? h.sacCode : patch.sacCode,
      ledgerAccountCode: patch.ledgerAccountCode ?? h.ledgerAccountCode,
    };
    // Only what the request touches is re-checked, so a seeded head without a SAC stays editable (name, order).
    const touchesRules =
      patch.payerRouting !== undefined ||
      patch.gstTreatment !== undefined ||
      patch.sacCode !== undefined ||
      patch.ledgerAccountCode !== undefined;
    if (touchesRules)
      await assertHeadRules(societyId, next, {
        ledger: patch.ledgerAccountCode !== undefined && patch.ledgerAccountCode !== h.ledgerAccountCode,
        sac: patch.gstTreatment !== undefined || patch.sacCode !== undefined,
      });
    for (const [k, v] of Object.entries(patch))
      if (v !== undefined) (h as unknown as Record<string, unknown>)[k] = v;
    h.version = Number(h.version) + 1;
    h.updatedBy = actorId(ctx);
    await h.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.chargeHeadUpdated,
        entityType: ENTITY,
        entityId: h.id!,
        entityLabel: h.key,
        societyId,
        before,
        after: auditView(h),
      },
      t,
    );
    return headDto(h);
  });
}

/** BR-11-13: an approved version of a non-`NONE` rate that is effective today or later. */
export async function headHasLiveRule(
  societyId: number,
  headId: number,
  today: string,
  t: Transaction,
): Promise<boolean> {
  const rules = await BillingRule.findAll({
    where: { societyId, chargeHeadId: headId },
    attributes: ['id'],
    transaction: t,
  });
  if (!rules.length) return false;
  const n = await BillingRuleVersion.count({
    where: {
      societyId,
      billingRuleId: { [Op.in]: rules.map(r => r.id!) },
      status: 'APPROVED',
      rateType: { [Op.ne]: 'NONE' },
      [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gte]: today } }],
    },
    transaction: t,
  });
  return n > 0;
}

/** `DELETE /billing/charge-heads/:id`. */
export async function archiveHead(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { reason: string; version: number },
): Promise<ChargeHeadDto> {
  const today = await societyToday(societyId);
  return sequelize.transaction(async t => {
    const h = await getHead(societyId, id, t, true);
    if (Number(h.version) !== input.version) throw staleVersion('charge head');
    if (h.isSystem) throw unprocessable('CHARGE_HEAD_SYSTEM', 'A system head cannot be archived', 'id');
    if (h.status === 'ARCHIVED') throw invalidState('This charge head is already archived');
    if (await headHasLiveRule(societyId, Number(h.id), today, t))
      throw new AppError(409, 'CHARGE_HEAD_IN_USE', 'An approved billing rule still uses this head', [
        { field: 'id', message: 'Stop the rule with a NONE version first' },
      ]);
    const before = auditView(h);
    h.status = 'ARCHIVED';
    h.version = Number(h.version) + 1;
    h.updatedBy = actorId(ctx);
    await h.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.chargeHeadArchived,
        entityType: ENTITY,
        entityId: h.id!,
        entityLabel: h.key,
        societyId,
        before,
        after: auditView(h),
        reason: input.reason,
      },
      t,
    );
    return headDto(h);
  });
}

/** `chargeHeads` of the public file: what other modules and the seeder call. */
export const chargeHeads = { ensureSeeded, findByKey: findHeadByKey };
