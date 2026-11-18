import { UniqueConstraintError, type Transaction } from 'sequelize';
import { SlaPolicy, TicketCategory, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { ConflictError, NotFoundError, UnprocessableError } from '../../utils/errors';
import type { FieldError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { assertFeature } from '../subscriptions/entitlements.service';
import { AUDIT, ENT, ENTITY, ERR, LIMITS, type SlaCalendar } from './helpdesk.constants';
import { ensureSeededOnce } from './helpdesk.seed';
import { societyIdOf } from './helpdesk.shared';

/** SLA policies (spec 8.4, BR-15-62): one row of targets for all four priorities; exactly one ACTIVE default; edits never touch open tickets (they keep their snapshot). */
const P = [1, 2, 3, 4] as const;
type Field = `p${(typeof P)[number]}${'ResponseMinutes' | 'ResolutionMinutes'}`;
type CalField = `p${2 | 3 | 4}Calendar`;

export interface PolicyDto {
  id: number;
  name: string;
  description: string | null;
  isDefault: boolean;
  p1ResponseMinutes: number;
  p1ResolutionMinutes: number;
  p1Calendar: SlaCalendar;
  p2ResponseMinutes: number;
  p2ResolutionMinutes: number;
  p2Calendar: SlaCalendar;
  p3ResponseMinutes: number;
  p3ResolutionMinutes: number;
  p3Calendar: SlaCalendar;
  p4ResponseMinutes: number;
  p4ResolutionMinutes: number;
  p4Calendar: SlaCalendar;
  status: string;
  version: number;
}

const dto = (p: SlaPolicy): PolicyDto => ({
  id: p.id,
  name: p.name,
  description: p.description,
  isDefault: p.isDefault,
  p1ResponseMinutes: p.p1ResponseMinutes,
  p1ResolutionMinutes: p.p1ResolutionMinutes,
  p1Calendar: p.p1Calendar,
  p2ResponseMinutes: p.p2ResponseMinutes,
  p2ResolutionMinutes: p.p2ResolutionMinutes,
  p2Calendar: p.p2Calendar,
  p3ResponseMinutes: p.p3ResponseMinutes,
  p3ResolutionMinutes: p.p3ResolutionMinutes,
  p3Calendar: p.p3Calendar,
  p4ResponseMinutes: p.p4ResponseMinutes,
  p4ResolutionMinutes: p.p4ResolutionMinutes,
  p4Calendar: p.p4Calendar,
  status: p.status,
  version: p.version,
});

const FIELDS: (keyof PolicyDto)[] = [
  'name',
  'description',
  'isDefault',
  ...P.flatMap(n => [`p${n}ResponseMinutes`, `p${n}ResolutionMinutes`] as (keyof PolicyDto)[]),
  'p2Calendar',
  'p3Calendar',
  'p4Calendar',
];
const snapshot = (p: SlaPolicy) =>
  Object.fromEntries([...FIELDS, 'status'].map(k => [k, p[k as keyof SlaPolicy]]));

export async function listPolicies(ctx: Ctx, status: 'ACTIVE' | 'ARCHIVED' | 'ALL'): Promise<PolicyDto[]> {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  const rows = await SlaPolicy.findAll({
    where: { societyId, ...(status === 'ALL' ? {} : { status }) },
    order: [
      ['isDefault', 'DESC'],
      ['name', 'ASC'],
    ],
  });
  return rows.map(dto);
}

/** BR-15-62 for each priority: `5 <= response < resolution <= 129600`; `422 SLA_TARGETS_INVALID` names every failing field. */
function checkTargets(v: Record<string, unknown>): void {
  const errors: FieldError[] = [];
  for (const n of P) {
    const rf = `p${n}ResponseMinutes`;
    const sf = `p${n}ResolutionMinutes`;
    const r = v[rf] as number;
    const s = v[sf] as number;
    if (r < LIMITS.minResponseMinutes)
      errors.push({ field: rf, message: `At least ${LIMITS.minResponseMinutes} minutes` });
    if (s > LIMITS.maxSlaMinutes)
      errors.push({ field: sf, message: `At most ${LIMITS.maxSlaMinutes} minutes` });
    if (r >= s) errors.push({ field: sf, message: 'Resolution must be longer than response' });
  }
  if (errors.length)
    throw new UnprocessableError(ERR.slaTargetsInvalid, 'The SLA targets are not valid', errors);
}

const stale = () =>
  new ConflictError(ERR.staleVersion, 'The SLA policy was changed by someone else. Reload and try again.');
const nameTaken = () =>
  new ConflictError(ERR.slaPolicyNameTaken, 'An active SLA policy with this name exists');
const asNameTaken = (e: unknown): never => {
  if (e instanceof UniqueConstraintError) throw nameTaken();
  throw e;
};

const find = async (societyId: number, id: number, t: Transaction) => {
  const p = await SlaPolicy.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!p) throw new NotFoundError(ERR.slaPolicyNotFound, 'SLA policy not found');
  return p;
};

async function nameFree(societyId: number, name: string, selfId: number | null, t: Transaction) {
  const rows = await SlaPolicy.findAll({ where: { societyId, name, status: 'ACTIVE' }, transaction: t });
  if (rows.some(r => r.id !== selfId)) throw nameTaken();
}

/** Clears the flag of the current default (same transaction as the new default, BR-15-62). Returns its id. */
async function clearDefault(
  societyId: number,
  exceptId: number | null,
  t: Transaction,
): Promise<number | null> {
  const cur = await SlaPolicy.findOne({
    where: { societyId, isDefault: true, status: 'ACTIVE' },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!cur || cur.id === exceptId) return null;
  cur.isDefault = false;
  cur.version += 1;
  await cur.save({ transaction: t });
  return cur.id;
}

export type PolicyInput = {
  name: string;
  description?: string | null;
  isDefault?: boolean;
} & Partial<Record<Field, number>> &
  Partial<Record<CalField, SlaCalendar>>;

export async function createPolicy(ctx: Ctx, input: PolicyInput): Promise<PolicyDto> {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  if (
    Object.values({ a: input.p2Calendar, b: input.p3Calendar, c: input.p4Calendar }).includes(
      'BUSINESS_HOURS',
    )
  )
    await assertFeature(ctx, ENT.businessCalendar);
  return sequelize.transaction(async t => {
    checkTargets(input);
    const active = (
      await SlaPolicy.findAll({
        where: { societyId, status: 'ACTIVE' },
        attributes: ['id'],
        transaction: t,
        lock: t.LOCK.UPDATE,
      })
    ).length;
    if (active >= LIMITS.maxActivePolicies)
      throw new UnprocessableError(
        ERR.slaPolicyLimitReached,
        `At most ${LIMITS.maxActivePolicies} active policies`,
      );
    await nameFree(societyId, input.name, null, t);
    let previousDefault: number | null = null;
    if (input.isDefault) previousDefault = await clearDefault(societyId, null, t);
    const row = await SlaPolicy.create(
      {
        societyId,
        name: input.name,
        description: input.description ?? null,
        isDefault: input.isDefault ?? false,
        p1ResponseMinutes: input.p1ResponseMinutes!,
        p1ResolutionMinutes: input.p1ResolutionMinutes!,
        p1Calendar: 'TWENTY_FOUR_SEVEN',
        p2ResponseMinutes: input.p2ResponseMinutes!,
        p2ResolutionMinutes: input.p2ResolutionMinutes!,
        p2Calendar: input.p2Calendar ?? 'TWENTY_FOUR_SEVEN',
        p3ResponseMinutes: input.p3ResponseMinutes!,
        p3ResolutionMinutes: input.p3ResolutionMinutes!,
        p3Calendar: input.p3Calendar ?? 'TWENTY_FOUR_SEVEN',
        p4ResponseMinutes: input.p4ResponseMinutes!,
        p4ResolutionMinutes: input.p4ResolutionMinutes!,
        p4Calendar: input.p4Calendar ?? 'TWENTY_FOUR_SEVEN',
        status: 'ACTIVE',
        archivedAt: null,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: t },
    ).catch(asNameTaken);
    await audit(
      ctx,
      {
        action: AUDIT.slaPolicyCreated,
        entityType: ENTITY.slaPolicy,
        entityId: row.id,
        entityLabel: row.name,
        societyId,
        after: snapshot(row),
      },
      t,
    );
    if (input.isDefault)
      await audit(
        ctx,
        {
          action: AUDIT.slaPolicyDefaultChanged,
          entityType: ENTITY.slaPolicy,
          entityId: row.id,
          entityLabel: row.name,
          societyId,
          before: { defaultPolicyId: previousDefault },
          after: { defaultPolicyId: row.id },
        },
        t,
      );
    return dto(row);
  });
}

export async function updatePolicy(
  ctx: Ctx,
  id: number,
  input: Partial<PolicyInput> & { version: number },
): Promise<PolicyDto> {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  return sequelize.transaction(async t => {
    const row = await find(societyId, id, t);
    if (row.version !== input.version) throw stale();
    if (row.status === 'ARCHIVED')
      throw new ConflictError(ERR.invalidState, 'An archived SLA policy cannot be edited');
    const before = snapshot(row);
    const patch: Partial<SlaPolicy> = {};
    for (const k of FIELDS) {
      const v = (input as Record<string, unknown>)[k];
      if (v !== undefined && k !== 'isDefault') (patch as Record<string, unknown>)[k] = v;
    }
    for (const k of ['p2Calendar', 'p3Calendar', 'p4Calendar'] as const)
      if (patch[k] === 'BUSINESS_HOURS' && row[k] !== 'BUSINESS_HOURS')
        await assertFeature(ctx, ENT.businessCalendar);
    const merged = { ...snapshot(row), ...patch };
    checkTargets(merged);
    if (patch.name !== undefined && patch.name !== row.name) await nameFree(societyId, patch.name, row.id, t);
    let becameDefault = false;
    let previousDefault: number | null = null;
    if (input.isDefault === false && row.isDefault)
      throw new UnprocessableError(
        ERR.defaultPolicyRequired,
        'Make another policy the default instead of removing the default flag',
        [{ field: 'isDefault', message: 'Exactly one active policy is the default' }],
      );
    if (input.isDefault === true && !row.isDefault) {
      previousDefault = await clearDefault(societyId, row.id, t);
      patch.isDefault = true;
      becameDefault = true;
    }
    row.set(patch);
    if (!row.changed()) return dto(row);
    row.updatedBy = ctx.user?.id ?? null;
    row.version += 1;
    await row.save({ transaction: t }).catch(asNameTaken);
    await audit(
      ctx,
      {
        action: AUDIT.slaPolicyUpdated,
        entityType: ENTITY.slaPolicy,
        entityId: row.id,
        entityLabel: row.name,
        societyId,
        before,
        after: snapshot(row),
      },
      t,
    );
    if (becameDefault)
      await audit(
        ctx,
        {
          action: AUDIT.slaPolicyDefaultChanged,
          entityType: ENTITY.slaPolicy,
          entityId: row.id,
          entityLabel: row.name,
          societyId,
          before: { defaultPolicyId: previousDefault },
          after: { defaultPolicyId: row.id },
        },
        t,
      );
    return dto(row);
  });
}

export async function archivePolicy(ctx: Ctx, id: number, version: number): Promise<PolicyDto> {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  return sequelize.transaction(async t => {
    const row = await find(societyId, id, t);
    if (row.version !== version) throw stale();
    if (row.status === 'ARCHIVED')
      throw new ConflictError(ERR.invalidState, 'The SLA policy is already archived');
    if (row.isDefault)
      throw new UnprocessableError(
        ERR.defaultPolicyRequired,
        'Make another policy the default before archiving this one',
      );
    const used = await TicketCategory.count({
      where: { societyId, slaPolicyId: row.id, status: 'ACTIVE' },
      transaction: t,
    });
    if (used) throw new ConflictError(ERR.slaPolicyInUse, 'An active category uses this policy');
    row.set({ status: 'ARCHIVED', archivedAt: now(), updatedBy: ctx.user?.id ?? null });
    row.version += 1;
    await row.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.slaPolicyArchived,
        entityType: ENTITY.slaPolicy,
        entityId: row.id,
        entityLabel: row.name,
        societyId,
        before: { status: 'ACTIVE' },
        after: { status: 'ARCHIVED' },
      },
      t,
    );
    return dto(row);
  });
}
