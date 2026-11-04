import { Op } from 'sequelize';
import { CommitteeTerm, User, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { ForbiddenError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { AUDIT, ENTITY, MAX_HANDOVER_ITEMS, type Designation } from './committee.constants';
import { seatedSeats } from './committee.planner';
import { committeePorts } from './committee.ports';
import type { HandoverItemJson } from './committee.schemas';
import { lockTerm } from './committee.service';
import { emitChanged, handoverItemNotFound, invalidState, rule, termNotFound } from './committee.shared';

/**
 * Hand-over checklist (8.10, BR-10-26 and BR-10-27). The list lives in the term's `handoverChecklist` JSON. An item update
 * locks the term row, does not need or bump `version` (BR-10-31) and sets `handoverCompletedAt` when every item is DONE or
 * NOT_APPLICABLE (and clears it when one goes back to PENDING or an item is added).
 */
const checklistOpen = (status: string): boolean => status === 'ACTIVE' || status === 'EXPIRED';
const allResolved = (items: HandoverItemJson[]): boolean =>
  items.length > 0 && items.every(i => i.status !== 'PENDING');

const canEditAll = (ctx: Ctx): boolean => ctx.permissions?.has('settings.members.edit') ?? false;
/** BR-10-27: `settings.members.edit`, or the SEATED holder of the item's owner designation in this term. */
function mayEditItem(ctx: Ctx, term: CommitteeTerm, item: HandoverItemJson): boolean {
  if (canEditAll(ctx)) return true;
  if (!item.ownerDesignation || !ctx.user) return false;
  return seatedSeats(term.members).some(
    s => s.designation === item.ownerDesignation && s.userId === ctx.user!.id,
  );
}

/** The response of 8.10 for a term (the GET shape, also returned by the two writes). */
export async function handoverView(ctx: Ctx, term: CommitteeTerm) {
  const items = term.handoverChecklist;
  const updaters = [...new Set(items.map(i => i.updatedByUserId).filter((v): v is number => v !== null))];
  const accounts = updaters.length
    ? await User.findAll({ where: { id: { [Op.in]: updaters } }, attributes: ['id', 'name'] })
    : [];
  const nameOf = new Map(accounts.map(u => [u.id!, u.name]));
  const seated = seatedSeats(term.members);
  const open = checklistOpen(term.status);
  return {
    termId: term.id!,
    completedAt: term.handoverCompletedAt,
    progress: {
      total: items.length,
      done: items.filter(i => i.status === 'DONE').length,
      notApplicable: items.filter(i => i.status === 'NOT_APPLICABLE').length,
      pending: items.filter(i => i.status === 'PENDING').length,
    },
    items: items.map(i => ({
      itemId: i.itemId,
      title: i.title,
      ownerDesignation: i.ownerDesignation,
      ownerName: seated.find(s => s.designation === i.ownerDesignation)?.name ?? null,
      status: i.status,
      note: i.note,
      evidenceFileIds: i.evidenceFileIds,
      updatedByName: i.updatedByUserId !== null ? (nameOf.get(i.updatedByUserId) ?? null) : null,
      updatedAt: i.updatedAt,
      canEdit: open && mayEditItem(ctx, term, i),
    })),
  };
}

/** `GET /committee/terms/:id/handover` (8.10). */
export async function getHandover(ctx: Ctx, societyId: number, id: number) {
  const term = await CommitteeTerm.findOne({ where: { id, societyId } });
  if (!term) throw termNotFound();
  return handoverView(ctx, term);
}

const progressOf = (items: HandoverItemJson[]) => ({
  done: items.filter(i => i.status === 'DONE').length,
  notApplicable: items.filter(i => i.status === 'NOT_APPLICABLE').length,
  pending: items.filter(i => i.status === 'PENDING').length,
});

/** `POST /committee/terms/:id/handover/items` (8.10): a new PENDING item, `itemId` = max + 1; clears the completion. */
export async function addItem(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { title: string; ownerDesignation: Designation | null },
) {
  const term = await sequelize.transaction(async t => {
    const term = await lockTerm(societyId, id, t);
    if (!checklistOpen(term.status))
      throw invalidState('The hand-over checklist is open only while the committee is in charge');
    const items = term.handoverChecklist;
    const next = items.reduce((m, i) => Math.max(m, Number(i.itemId.slice(1))), 0) + 1;
    if (items.length >= MAX_HANDOVER_ITEMS || next > 99)
      throw rule('HANDOVER_ITEM_LIMIT', `A checklist has at most ${MAX_HANDOVER_ITEMS} items`, 'title');
    const item: HandoverItemJson = {
      itemId: `H${next}`,
      title: input.title,
      ownerDesignation: input.ownerDesignation,
      status: 'PENDING',
      note: null,
      evidenceFileIds: [],
      updatedByUserId: null,
      updatedAt: null,
    };
    const wasComplete = term.handoverCompletedAt !== null;
    term.handoverChecklist = [...items, item];
    term.handoverCompletedAt = null;
    term.updatedBy = ctx.user?.id ?? null;
    await term.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.handoverItemAdded,
        entityType: ENTITY.term,
        entityId: id,
        entityLabel: `${term.name}: ${item.title}`,
        societyId,
        after: {
          itemId: item.itemId,
          title: item.title,
          ownerDesignation: item.ownerDesignation,
          completionCleared: wasComplete,
        },
      },
      t,
    );
    emitChanged(t, societyId, id, term.status, 'HANDOVER');
    return term;
  });
  return handoverView(ctx, term);
}

export interface ItemPatch {
  status?: HandoverItemJson['status'];
  note?: string | null;
  evidenceFileIds?: number[];
}

/** `PATCH /committee/terms/:id/handover/items/:itemId` (8.10). */
export async function updateItem(ctx: Ctx, societyId: number, id: number, itemId: string, input: ItemPatch) {
  const term = await sequelize.transaction(async t => {
    const term = await lockTerm(societyId, id, t);
    const items = term.handoverChecklist;
    const item = items.find(i => i.itemId === itemId);
    if (!item) throw handoverItemNotFound();
    if (!mayEditItem(ctx, term, item))
      throw new ForbiddenError(
        'PERMISSION_DENIED',
        'Only the owner of this item or a committee manager can update it',
      );
    if (!checklistOpen(term.status))
      throw invalidState('The hand-over checklist is open only while the committee is in charge');

    const status = input.status ?? item.status;
    const note = input.note !== undefined ? input.note : item.note;
    if (status === 'NOT_APPLICABLE' && (input.status !== undefined || input.note !== undefined)) {
      const len = (note ?? '').trim().length;
      if (len < 5)
        throw new ValidationError([
          { field: 'note', message: 'Say why this item does not apply (5 to 300 characters)' },
        ]);
    }
    if (input.evidenceFileIds !== undefined) {
      const added = input.evidenceFileIds.filter(f => !item.evidenceFileIds.includes(f));
      if (added.length)
        await committeePorts().files.linkEvidence(ctx, { fileIds: added, societyId, termId: id }, t);
    }
    const stamp = now().toISOString();
    const next: HandoverItemJson = {
      ...item,
      status,
      note: note === null ? null : (note ?? '').trim() || null,
      evidenceFileIds: input.evidenceFileIds ?? item.evidenceFileIds,
      updatedByUserId: ctx.user?.id ?? null,
      updatedAt: stamp,
    };
    const list = items.map(i => (i.itemId === itemId ? next : i));
    const wasComplete = term.handoverCompletedAt !== null;
    const complete = allResolved(list);
    term.handoverChecklist = list;
    term.handoverCompletedAt = complete ? (term.handoverCompletedAt ?? now()) : null;
    term.updatedBy = ctx.user?.id ?? null;
    await term.save({ transaction: t });
    const view = (i: HandoverItemJson) => ({
      itemId: i.itemId,
      status: i.status,
      note: i.note,
      evidenceFileIds: i.evidenceFileIds,
    });
    await audit(
      ctx,
      {
        action: AUDIT.handoverItemUpdated,
        entityType: ENTITY.term,
        entityId: id,
        entityLabel: `${term.name}: ${item.title}`,
        societyId,
        before: view(item),
        after: { ...view(next), ...progressOf(list) },
      },
      t,
    );
    if (complete && !wasComplete)
      await audit(
        ctx,
        {
          action: AUDIT.handoverCompleted,
          entityType: ENTITY.term,
          entityId: id,
          entityLabel: term.name,
          societyId,
          after: { completedOn: term.handoverCompletedAt, ...progressOf(list) },
        },
        t,
      );
    emitChanged(t, societyId, id, term.status, 'HANDOVER');
    return term;
  });
  return handoverView(ctx, term);
}
