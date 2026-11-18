import { Role } from '../../models';
import { maskPhone, logger } from '../../lib/logger';
import type { Ctx } from '../../types/context';
import { roleLabel, typeMeta } from './approvals.catalogue';
import { PERM } from './approvals.constants';
import { seeRequest } from './approvals.history.service';
import { actionLine, actionNameIds, namesOf } from './approvals.inbox.rows';
import { REASON_TEXT, roundOf } from './approvals.inbox.eval';
import { slotsOf } from './approvals.match';
import { getHandlers } from './approvals.registry';
import { stepUpAboveOf } from './approvals.inbox.service';
import { evaluateStep, toView } from './approvals.shared';
import type { ApprovalDescription } from './approvals.types';

const n = (v: unknown): number => Number(v);

const PHONE_IN_TEXT = /(?:\+?91[\s-]?)?[6-9]\d{9}\b/g;
/** Phones inside facts are masked unless the viewer holds `residents.contacts.view` (8.6). */
const maskFacts = (d: ApprovalDescription, canSee: boolean): ApprovalDescription =>
  canSee
    ? d
    : { ...d, facts: d.facts.map(f => ({ ...f, value: f.value.replace(PHONE_IN_TEXT, m => maskPhone(m)) })) };

async function describeRequest(ctx: Ctx, req: Parameters<typeof toView>[0]): Promise<ApprovalDescription> {
  const h = getHandlers(req.type);
  try {
    if (!h) throw new Error('no handlers');
    const d = await h.describe(toView(req), ctx);
    return { facts: d.facts ?? [], link: d.link ?? null };
  } catch (err) {
    logger.error({ err, requestId: n(req.id) }, 'approvals describe failed; showing the payload');
    const facts = Object.entries(req.payload ?? {})
      .filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v))
      .map(([k, v]) => ({ label: k, value: String(v), kind: 'text' as const }));
    return { facts, link: null };
  }
}

/** 8.6: the detail with steps, description (from the owner module), the action timeline and what the caller can do. */
export async function requestDetail(ctx: Ctx, id: number) {
  const { req, ev, viewer, rows } = await seeRequest(ctx, id);
  const societyId = ctx.society!.id;
  const meta = typeMeta(req.type)!;
  const snap = req.ruleSnapshot;
  const names = await namesOf([...actionNameIds(rows), ...ev.my.options]);
  const roleKeys = new Set<string>();
  for (const s of snap?.steps ?? []) s.roleKeys.forEach(k => roleKeys.add(k));
  const roles = roleKeys.size ? await Role.findAll({ where: { societyId, key: [...roleKeys] } }) : [];
  const roleName = new Map(roles.map(r => [r.key, r.name]));
  const userSlotNames = await namesOf((snap?.steps ?? []).flatMap(s => s.userIds));
  const approvals = rows.filter(a => a.action === 'APPROVED' && n(a.round) === n(req.round));
  const open = req.status === 'PENDING';
  const stepEval = open ? evaluateStep(req, await viewer.approvers(req.type), roundOf(req, rows)) : null;
  const widened = Boolean(stepEval?.state.widened);
  const steps = (snap?.steps ?? []).map(step => {
    const given = approvals.filter(a => a.stepNo !== null && n(a.stepNo) === step.stepNo);
    const current = step.stepNo === n(req.currentStepNo);
    const state =
      req.status === 'APPROVED' || step.stepNo < n(req.currentStepNo)
        ? 'DONE'
        : current
          ? open || req.status === 'CHANGES_REQUESTED'
            ? 'CURRENT'
            : 'STOPPED'
          : 'UPCOMING';
    return {
      stepNo: step.stepNo,
      name: step.name,
      mode: step.mode,
      requiredCount: step.requiredCount,
      approvalsGiven: given.length,
      widened: current && open ? widened : false,
      approvedBy: given.map(a => a.actorName ?? 'Unknown'),
      slots: slotsOf(step, req.stepOverrides ?? [], n(req.round)).map(s => ({
        type: s.type,
        ref: s.ref,
        label:
          s.type === 'ROLE'
            ? (roleName.get(s.ref) ?? roleLabel(s.ref))
            : (userSlotNames.get(Number(s.ref)) ?? s.ref),
      })),
      state,
    };
  });
  const description = maskFacts(await describeRequest(ctx, req), viewer.has(PERM.contactsView));
  const isRequester = n(req.requesterUserId) === ctx.user!.id;
  const can = ev.my.canAct;
  const abovePaise = req.stepUpAbovePaise !== null ? n(req.stepUpAbovePaise) : await stepUpAboveOf(societyId);
  const requesterNames = await namesOf([n(req.requesterUserId)]);
  return {
    id: n(req.id),
    type: req.type,
    typeLabel: meta.label,
    entityType: req.entityType,
    entityId: n(req.entityId),
    title: req.title,
    summary: req.summary,
    amountPaise: n(req.amountPaise),
    categoryKey: req.categoryKey,
    unitId: req.unitId === null ? null : n(req.unitId),
    status: req.status,
    round: n(req.round),
    routing: req.routing,
    ruleName: snap?.name ?? null,
    ruleVersion: req.ruleVersion === null ? null : n(req.ruleVersion),
    requester: { userId: n(req.requesterUserId), name: requesterNames.get(n(req.requesterUserId)) ?? null },
    decisionReason: req.decisionReason,
    steps,
    description,
    actions: rows.map(a => actionLine(a, names)),
    dueAt: req.dueAt ? req.dueAt.toISOString() : null,
    stuckAt: req.stuckAt ? req.stuckAt.toISOString() : null,
    stepUpRequired: Boolean(req.stepUpRequired),
    stepUpAbovePaise: abovePaise,
    myAction: {
      canApprove: can,
      canReject: can,
      canRequestChanges: can && meta.allowsChanges,
      canCancel:
        isRequester &&
        (req.status === 'PENDING' || req.status === 'CHANGES_REQUESTED') &&
        Boolean(getHandlers(req.type)?.onCancelled),
      onBehalfOptions: ev.my.options.map(userId => ({ userId, name: names.get(userId) ?? null })),
      reason: ev.my.reason,
      ...(ev.my.reason ? { reasonText: REASON_TEXT[ev.my.reason] } : {}),
    },
    version: n(req.version),
  };
}
