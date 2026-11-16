import {
  Op,
  UniqueConstraintError,
  fn,
  col,
  where as sqlWhere,
  type Transaction,
  type WhereOptions,
} from 'sequelize';
import { AuditLog, Building, Collection, Unit, sequelize } from '../../models';
import { audit } from '../../utils/audit';
import {
  ConflictError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
  type FieldError,
} from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import { addDaysYmd } from '../billing/billing.calc.period';
import { societyToday } from '../billing/billing.runs.shared';
import { AUDIT, ENTITY, ERR } from './payments.constants';
import { paymentsPorts } from './payments.ports';
import {
  collectionNotFound,
  emitProgress,
  escapeLike,
  expensesPort,
  invalidState,
  noAudience,
  percentOf,
  resolveAudience,
  societyIdOf,
  staleVersion,
  touchReports,
  userIdOf,
  userNames,
} from './payments.collections.shared';
import type { CreateInput, ListQuery, PatchInput } from './payments.collections.validation';
import type { Ctx } from '../../types/context';

/** Sub-module 12.5 reads and drafts (8.21): list, detail, create, edit, delete. Workflow routes are in `payments.collections.workflow.ts`. */
const EDITABLE = ['DRAFT', 'REJECTED', 'CHANGES_REQUESTED'];

export interface CollectionItemDto {
  id: number;
  title: string;
  kind: string;
  purpose: string;
  isMandatory: boolean;
  amountMode: string;
  amountPerUnitPaise: number;
  minAmountPaise: number;
  targetPaise: number;
  collectedPaise: number;
  percent: number;
  contributorCount: number;
  requestCount: number;
  paidCount: number;
  dueDate: string;
  status: string;
  fundId: number;
  fundName: string | null;
  createdByName: string | null;
  approvedByName: string | null;
  version: number;
}

const fundNameOf = async (societyId: number, fundId: number) => paymentsPorts().funds.name(societyId, fundId);

export async function itemDtos(societyId: number, rows: Collection[]): Promise<CollectionItemDto[]> {
  const names = await userNames(rows.flatMap(r => [r.createdBy, r.approvedBy]));
  const funds = new Map<number, string | null>();
  for (const f of new Set(rows.map(r => Number(r.fundId)))) funds.set(f, await fundNameOf(societyId, f));
  return rows.map(c => ({
    id: Number(c.id),
    title: c.title,
    kind: c.kind,
    purpose: c.purpose,
    isMandatory: Boolean(c.isMandatory),
    amountMode: c.amountMode,
    amountPerUnitPaise: Number(c.amountPerUnitPaise),
    minAmountPaise: Number(c.minAmountPaise),
    targetPaise: Number(c.targetPaise),
    collectedPaise: Number(c.collectedPaise),
    percent: percentOf(Number(c.collectedPaise), Number(c.targetPaise)),
    contributorCount: Number(c.contributorCount),
    requestCount: Number(c.requestCount),
    paidCount: Number(c.paidCount),
    dueDate: c.dueDate,
    status: c.status,
    fundId: Number(c.fundId),
    fundName: funds.get(Number(c.fundId)) ?? null,
    createdByName: c.createdBy ? (names.get(Number(c.createdBy)) ?? null) : null,
    approvedByName: c.approvedBy ? (names.get(Number(c.approvedBy)) ?? null) : null,
    version: Number(c.version),
  }));
}

export async function loadCollection(societyId: number, id: number, t?: Transaction): Promise<Collection> {
  const c = await Collection.findOne({ where: { id, societyId }, transaction: t });
  if (!c) throw collectionNotFound();
  return c;
}

export async function lockCollection(societyId: number, id: number, t: Transaction): Promise<Collection> {
  const c = await Collection.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!c) throw collectionNotFound();
  return c;
}

/** The detail of 8.21: the item plus purpose, audience, approval, spending and the audit timeline. */
export async function collectionDetail(societyId: number, id: number) {
  const c = await loadCollection(societyId, id);
  const [item] = await itemDtos(societyId, [c]);
  const spend = await expensesPort.listForCollection(societyId, id);
  const log = await AuditLog.findAll({
    where: { societyId, entityType: 'collection', entityId: String(id) },
    order: [['id', 'ASC']],
    attributes: ['action', 'actorName', 'createdAt'],
  });
  return {
    ...item!,
    purpose: c.purpose,
    audienceType: c.audienceType,
    audienceIds: c.audienceIds ?? null,
    includeVacant: Boolean(c.includeVacant),
    payListVisibility: c.payListVisibility,
    sendNotice: Boolean(c.sendNotice),
    reminderCount: Number(c.reminderCount),
    lastReminderAt: c.lastReminderAt ? c.lastReminderAt.toISOString() : null,
    publishedAt: c.publishedAt ? c.publishedAt.toISOString() : null,
    closedAt: c.closedAt ? c.closedAt.toISOString() : null,
    closeReason: c.closeReason,
    noticeId: c.noticeId ? Number(c.noticeId) : null,
    approval: {
      requestId: c.approvalRequestId ? Number(c.approvalRequestId) : null,
      status: c.approvalRequestId ? c.status : null,
      reason: c.rejectedReason,
    },
    spentPaise: spend.spentPaise,
    expenses: spend.expenses,
    timeline: log.map(l => ({
      at: (l.createdAt ?? new Date()).toISOString(),
      event: l.action,
      by: l.actorName,
    })),
  };
}

export async function listCollections(societyId: number, q: ListQuery) {
  const and: WhereOptions[] = [{ societyId }];
  if (q.status) and.push({ status: { [Op.in]: q.status } });
  if (q.kind) and.push({ kind: q.kind });
  if (q.isMandatory !== undefined) and.push({ isMandatory: q.isMandatory });
  if (q.q) and.push({ title: { [Op.like]: `%${escapeLike(q.q)}%` } });
  const { rows, count } = await Collection.findAndCountAll({
    where: { [Op.and]: and },
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { data: await itemDtos(societyId, rows), pagination: pageMeta(q.page, q.limit, count) };
}

// ------------------------------------------------------------------ create and edit

interface Draft {
  title: string;
  kind: Collection['kind'];
  purpose: string;
  amountMode: Collection['amountMode'];
  amountPerUnitPaise: number;
  minAmountPaise: number;
  isMandatory: boolean;
  audienceType: Collection['audienceType'];
  audienceIds: number[] | null;
  includeVacant: boolean;
  dueDate: string;
  fundId: number;
  targetPaise: number | undefined;
  payListVisibility: Collection['payListVisibility'];
  sendNotice: boolean;
}

/** Field rules of 8.21 that depend on several fields; returns the cleaned draft or throws 400 / 422. */
async function checkDraft(
  societyId: number,
  d: Draft,
  today: string,
  opts: { checkDue: boolean; recomputeTarget: boolean; selfId?: number },
): Promise<Draft & { targetPaise: number }> {
  const errors: FieldError[] = [];
  const out = { ...d };
  if (d.amountMode === 'VOLUNTARY') {
    if (d.targetPaise === undefined)
      errors.push({ field: 'targetPaise', message: 'Required for a voluntary collection' });
  } else if (d.amountPerUnitPaise < 100)
    errors.push({ field: 'amountPerUnitPaise', message: 'At least 100 paise' });
  if (d.amountMode === 'MIN_PER_UNIT') {
    if (d.minAmountPaise < 100 || d.minAmountPaise > d.amountPerUnitPaise)
      errors.push({ field: 'minAmountPaise', message: 'From 100 paise up to the suggested amount' });
  } else out.minAmountPaise = 0;
  if (d.audienceType === 'ALL') out.audienceIds = null;
  else if (!d.audienceIds || d.audienceIds.length === 0)
    errors.push({ field: 'audienceIds', message: 'Choose at least one building or flat' });
  else if (new Set(d.audienceIds).size !== d.audienceIds.length)
    errors.push({ field: 'audienceIds', message: 'Ids must be unique' });
  else {
    const found =
      d.audienceType === 'BUILDINGS'
        ? await Building.count({ where: { societyId, id: { [Op.in]: d.audienceIds } } })
        : await Unit.count({ where: { societyId, id: { [Op.in]: d.audienceIds } } });
    if (found !== d.audienceIds.length)
      errors.push({
        field: 'audienceIds',
        message: `Some ${d.audienceType === 'BUILDINGS' ? 'buildings' : 'flats'} are not in this society`,
      });
  }
  if (d.dueDate > addDaysYmd(today, 365))
    errors.push({ field: 'dueDate', message: 'Within one year from today' });
  if (errors.length) throw new ValidationError(errors);
  if (d.isMandatory && d.amountMode !== 'FIXED_PER_UNIT')
    throw new UnprocessableError(
      ERR.mandatoryMustBeFixed,
      'A mandatory collection must be a fixed amount per flat',
      [{ field: 'isMandatory', message: 'Requires amountMode FIXED_PER_UNIT' }],
    );
  if (opts.checkDue && d.dueDate < today)
    throw new UnprocessableError(ERR.collectionDuePast, 'The due date is in the past', [
      { field: 'dueDate', message: 'Today or later' },
    ]);
  if (!(await paymentsPorts().funds.exists(societyId, d.fundId)))
    throw new NotFoundError(ERR.fundNotFound, 'Fund not found');
  const clash = await Collection.findOne({
    where: {
      [Op.and]: [
        { societyId, status: { [Op.ne]: 'CANCELLED' } },
        sqlWhere(fn('LOWER', col('title')), d.title.toLowerCase()),
        ...(opts.selfId ? [{ id: { [Op.ne]: opts.selfId } }] : []),
      ],
    },
    attributes: ['id'],
  });
  if (clash)
    throw new ConflictError(ERR.collectionTitleExists, 'A collection with this title already exists');
  let target = out.targetPaise;
  if (target === undefined || (opts.recomputeTarget && d.amountMode !== 'VOLUNTARY')) {
    if (d.amountMode === 'VOLUNTARY')
      throw new ValidationError([{ field: 'targetPaise', message: 'Required' }]);
    const aud = await resolveAudience(societyId, out, today);
    if (aud.length === 0) throw noAudience();
    target = aud.length * d.amountPerUnitPaise;
  }
  if (target < 100 || target > 10_000_000_000)
    throw new ValidationError([{ field: 'targetPaise', message: '100 paise up to 10,000,000,000 paise' }]);
  return { ...out, targetPaise: target };
}

export async function createCollection(ctx: Ctx, input: CreateInput) {
  const societyId = societyIdOf(ctx);
  const today = await societyToday(societyId);
  const draft = await checkDraft(
    societyId,
    {
      title: input.title,
      kind: input.kind,
      purpose: input.purpose,
      amountMode: input.amountMode,
      amountPerUnitPaise: input.amountPerUnitPaise ?? 0,
      minAmountPaise: input.minAmountPaise ?? 0,
      isMandatory: input.isMandatory,
      audienceType: input.audienceType,
      audienceIds: input.audienceIds ?? null,
      includeVacant: input.includeVacant,
      dueDate: input.dueDate,
      fundId: input.fundId,
      targetPaise: input.targetPaise,
      payListVisibility: input.payListVisibility,
      sendNotice: input.sendNotice,
    },
    today,
    { checkDue: true, recomputeTarget: false },
  );
  const uid = userIdOf(ctx);
  const id = await sequelize
    .transaction(async t => {
      const c = await Collection.create(
        {
          societyId,
          ...draft,
          status: 'DRAFT',
          requestCount: 0,
          paidCount: 0,
          contributorCount: 0,
          collectedPaise: 0,
          reminderCount: 0,
          lastReminderAt: null,
          approvalRequestId: null,
          submittedAt: null,
          approvedBy: null,
          approvedAt: null,
          rejectedReason: null,
          publishedAt: null,
          publishedBy: null,
          noticeId: null,
          closedAt: null,
          closedBy: null,
          closeReason: null,
          createdBy: uid,
          updatedBy: uid,
          version: 1,
          deletedAt: null,
        },
        { transaction: t },
      );
      await audit(
        ctx,
        {
          action: AUDIT.collectionCreated,
          entityType: 'collection',
          entityId: Number(c.id),
          entityLabel: c.title,
          societyId,
          after: { title: c.title, kind: c.kind, targetPaise: draft.targetPaise, isMandatory: c.isMandatory },
        },
        t,
      );
      touchReports(t, societyId);
      return Number(c.id);
    })
    .catch(err => {
      if (err instanceof UniqueConstraintError)
        throw new ConflictError(ERR.collectionTitleExists, 'A collection with this title already exists');
      throw err;
    });
  return collectionDetail(societyId, id);
}

export async function patchCollection(ctx: Ctx, id: number, input: PatchInput) {
  const societyId = societyIdOf(ctx);
  const today = await societyToday(societyId);
  const { version, ...changes } = input;
  const pre = await loadCollection(societyId, id);
  if (!EDITABLE.includes(pre.status))
    throw invalidState('Only a draft, rejected or changes-requested collection can be edited');
  const merged: Draft = {
    title: changes.title ?? pre.title,
    kind: changes.kind ?? pre.kind,
    purpose: changes.purpose ?? pre.purpose,
    amountMode: changes.amountMode ?? pre.amountMode,
    amountPerUnitPaise: changes.amountPerUnitPaise ?? Number(pre.amountPerUnitPaise),
    minAmountPaise: changes.minAmountPaise ?? Number(pre.minAmountPaise),
    isMandatory: changes.isMandatory ?? Boolean(pre.isMandatory),
    audienceType: changes.audienceType ?? pre.audienceType,
    audienceIds: changes.audienceIds !== undefined ? changes.audienceIds : (pre.audienceIds ?? null),
    includeVacant: changes.includeVacant ?? Boolean(pre.includeVacant),
    dueDate: changes.dueDate ?? pre.dueDate,
    fundId: changes.fundId ?? Number(pre.fundId),
    targetPaise: changes.targetPaise ?? Number(pre.targetPaise),
    payListVisibility: changes.payListVisibility ?? pre.payListVisibility,
    sendNotice: changes.sendNotice ?? Boolean(pre.sendNotice),
  };
  const audienceChanged = [
    'amountMode',
    'amountPerUnitPaise',
    'audienceType',
    'audienceIds',
    'includeVacant',
  ].some(k => (changes as Record<string, unknown>)[k] !== undefined);
  const clean = await checkDraft(societyId, merged, today, {
    checkDue: changes.dueDate !== undefined,
    recomputeTarget: changes.targetPaise === undefined && audienceChanged,
    selfId: id,
  });
  const uid = userIdOf(ctx);
  await sequelize
    .transaction(async t => {
      await paymentsPorts().approvals.lockOpenForEntity(societyId, ENTITY.collection, id, t);
      const c = await lockCollection(societyId, id, t);
      if (!EDITABLE.includes(c.status))
        throw invalidState('Only a draft, rejected or changes-requested collection can be edited');
      if (Number(c.version) !== version) throw staleVersion();
      const before = { title: c.title, targetPaise: Number(c.targetPaise), status: c.status };
      await c.update(
        {
          ...clean,
          status: c.status === 'REJECTED' ? 'DRAFT' : c.status,
          updatedBy: uid,
          version: Number(c.version) + 1,
        },
        { transaction: t },
      );
      await audit(
        ctx,
        {
          action: AUDIT.collectionUpdated,
          entityType: 'collection',
          entityId: id,
          entityLabel: c.title,
          societyId,
          before,
          after: { title: c.title, targetPaise: Number(c.targetPaise), status: c.status },
        },
        t,
      );
      touchReports(t, societyId);
    })
    .catch(err => {
      if (err instanceof UniqueConstraintError)
        throw new ConflictError(ERR.collectionTitleExists, 'A collection with this title already exists');
      throw err;
    });
  return collectionDetail(societyId, id);
}

export async function deleteCollection(ctx: Ctx, id: number, version: number): Promise<void> {
  const societyId = societyIdOf(ctx);
  await sequelize.transaction(async t => {
    await paymentsPorts().approvals.lockOpenForEntity(societyId, ENTITY.collection, id, t);
    const c = await lockCollection(societyId, id, t);
    if (c.status !== 'DRAFT' && c.status !== 'REJECTED')
      throw invalidState('Only a draft or rejected collection can be deleted');
    if (Number(c.version) !== version) throw staleVersion();
    await c.destroy({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.collectionDeleted,
        entityType: 'collection',
        entityId: id,
        entityLabel: c.title,
        societyId,
        before: { title: c.title, status: c.status },
      },
      t,
    );
    touchReports(t, societyId);
  });
}

export { emitProgress };
