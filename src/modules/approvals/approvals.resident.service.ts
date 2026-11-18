import { Op, type WhereOptions } from 'sequelize';
import { ApprovalAction, ApprovalRequest } from '../../models';
import type { Ctx } from '../../types/context';
import { NotFoundError } from '../../utils/errors';
import { computeAccess } from '../access-control/access-control.public';
import { APPROVAL_TYPES, CATALOGUE, roleLabel } from './approvals.catalogue';
import { ERR, PERM, STATUS_LABEL, type RequestStatus } from './approvals.constants';
import { loadActions } from './approvals.inbox.eval';
import { getHandlers } from './approvals.registry';

const n = (v: unknown): number => Number(v);

/** The resident view permission of a type: bookings use the amenities key, every other resident type the requests key. */
const viewKeyOf = (type: string): string =>
  type === 'BOOKING' ? PERM.residentAmenitiesView : PERM.residentRequestsView;

async function scope(ctx: Ctx): Promise<WhereOptions> {
  const societyId = ctx.society!.id;
  const userId = ctx.user!.id;
  const access = await computeAccess(societyId, userId);
  const held = new Set(access.permissions);
  const types = APPROVAL_TYPES.filter(t => CATALOGUE[t]!.residentVisible && held.has(viewKeyOf(t)));
  const units = ctx.unitIds ?? [];
  return {
    societyId,
    residentVisible: true,
    [Op.or]: [
      { requesterUserId: userId },
      ...(units.length && types.length ? [{ unitId: units, type: types }] : []),
    ],
  };
}

const waitingFor = (req: ApprovalRequest): string => {
  const step = req.ruleSnapshot?.steps[n(req.currentStepNo) - 1];
  return step ? `Waiting for ${step.name}` : 'Waiting for approval';
};

/** Role names only, never people: "Approved by Secretary". */
function timeline(rows: ApprovalAction[], round: number) {
  const out: { label: string; at: string }[] = [];
  for (const a of rows) {
    if (n(a.round) > round) continue;
    const at = a.createdAt.toISOString();
    const role = a.actorRoleKey && a.actorRoleKey !== 'system' ? roleLabel(a.actorRoleKey) : null;
    switch (a.action) {
      case 'SUBMITTED':
        out.push({ label: 'Submitted', at });
        break;
      case 'RESUBMITTED':
        out.push({ label: 'Resubmitted', at });
        break;
      case 'AUTO_APPROVED':
        out.push({ label: 'Approved', at });
        break;
      case 'APPROVED':
        out.push({ label: role ? `Approved by ${role}` : 'Approved', at });
        break;
      case 'REJECTED':
        out.push({ label: role ? `Rejected by ${role}` : 'Rejected', at });
        break;
      case 'CHANGES_REQUESTED':
        out.push({ label: 'Changes requested', at });
        break;
      case 'CANCELLED':
        out.push({ label: 'Cancelled', at });
        break;
      case 'EXPIRED':
        out.push({ label: 'Expired', at });
        break;
      default:
        break; // reminders, escalations and reassignments are internal
    }
  }
  return out;
}

function row(ctx: Ctx, req: ApprovalRequest, rows: ApprovalAction[]) {
  const meta = CATALOGUE[req.type]!;
  const open = req.status === 'PENDING' || req.status === 'CHANGES_REQUESTED';
  const decided = !open && req.decidedAt ? req.decidedAt.toISOString() : null;
  const showReason = ['REJECTED', 'CHANGES_REQUESTED', 'CANCELLED', 'EXPIRED'].includes(req.status);
  return {
    id: n(req.id),
    type: req.type,
    typeLabel: meta.label,
    title: req.title,
    status: req.status,
    statusLabel: req.status === 'PENDING' ? waitingFor(req) : STATUS_LABEL[req.status as RequestStatus],
    submittedAt: req.createdAt.toISOString(),
    decidedAt: decided,
    reason: showReason ? req.decisionReason : null,
    entityType: req.entityType,
    entityId: n(req.entityId),
    timeline: timeline(rows, n(req.round)),
    canCancel: open && n(req.requesterUserId) === ctx.user!.id && Boolean(getHandlers(req.type)?.onCancelled),
    version: n(req.version),
  };
}

/** 8.19 list. */
export async function listMine(ctx: Ctx, q: { status?: string; page: number; limit: number }) {
  const where: WhereOptions = { [Op.and]: [await scope(ctx), ...(q.status ? [{ status: q.status }] : [])] };
  const total = await ApprovalRequest.count({ where });
  const reqs = await ApprovalRequest.findAll({
    where,
    order: [['id', 'DESC']],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const actions = await loadActions(reqs.map(r => n(r.id)));
  return {
    data: reqs.map(r => row(ctx, r, actions.get(n(r.id)) ?? [])),
    pagination: {
      page: q.page,
      limit: q.limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / q.limit)),
    },
  };
}

/** 8.19 detail: not visible (or another unit's, or another society's) is 404. */
export async function getMine(ctx: Ctx, id: number) {
  const req = await ApprovalRequest.findOne({ where: { [Op.and]: [{ id }, await scope(ctx)] } });
  if (!req) throw new NotFoundError(ERR.notFound, 'Approval request not found');
  const actions = await loadActions([n(req.id)]);
  return row(ctx, req, actions.get(n(req.id)) ?? []);
}

/** Resident cancel: only for requests the caller can see; the engine enforces requester-only (`403 NOT_THE_REQUESTER`). */
export const assertMine = async (ctx: Ctx, id: number): Promise<void> => {
  await getMine(ctx, id);
};
