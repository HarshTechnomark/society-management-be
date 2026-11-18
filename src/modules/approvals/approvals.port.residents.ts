import type { Transaction } from 'sequelize';
import { Society } from '../../models';
import type { Ctx } from '../../types/context';
import type { ApprovalRef, Part2Ports } from '../residents/residents.part2.ports';
import type { ResidentPart3Ports } from '../residents/residents.part3.ports';
import { typeMeta } from './approvals.catalogue';
import { cancel, publicStatus, request, resubmit } from './approvals.engine';
import { registerType } from './approvals.registry';
import type { ApprovalRequestView, TypeHandlers } from './approvals.types';

/**
 * Adapters of the real module 14 to the two other placeholder shapes of module 09 (`part2Ports().approvals` and
 * `part3Ports().approvals`). Module 09 passes a request reference `{ id, societyId, entityId, type, reason }` to its handlers
 * and the engine runs `onApproved` inside `request` when a rule auto-approves (module 09 relies on that: its placeholder
 * does the same), so these adapters keep the native behaviour. Switch with
 * `setPart2Ports({ approvals: realPart2Approvals })` and `setResidentPart3Ports({ approvals: realPart3Approvals })`.
 */
const ref = (req: ApprovalRequestView, reason: string | null): ApprovalRef => ({
  id: req.id,
  societyId: req.societyId,
  entityId: req.entityId,
  type: req.type,
  reason,
});

type Handlers2 = Parameters<Part2Ports['approvals']['registerType']>[1];
type Handlers3 = Parameters<ResidentPart3Ports['approvals']['registerType']>[1];

function wrap(h: Handlers2 | Handlers3): TypeHandlers {
  const out: TypeHandlers = {
    onApproved: (ctx, req, t) => h.onApproved(ctx, ref(req, null), t),
    onRejected: (ctx, req, t) => h.onRejected(ctx, ref(req, ctx.approval.reason ?? req.decisionReason), t),
    describe: async req => {
      const d = h.describe
        ? await (h.describe as (...a: unknown[]) => Promise<{ lines: { label: string; value: string }[] }>)(
            // part 2 describes by (societyId, entityId); part 3 by the reference
            ...(h.describe.length >= 2 ? [req.societyId, req.entityId] : [ref(req, null)]),
          )
        : { lines: [] };
      return {
        facts: d.lines.map(l => ({ label: l.label, value: l.value, kind: 'text' as const })),
        link: null,
      };
    },
  };
  if (h.onChangesRequested)
    out.onChangesRequested = (ctx, req, t) => h.onChangesRequested!(ctx, ref(req, null), t);
  if (h.onCancelled) out.onCancelled = (ctx, req, t) => h.onCancelled!(ctx, ref(req, ctx.approval.reason), t);
  return out;
}

/** Module 09 raises some requests with a system context that carries no society (join requests): the input names it. */
async function withSociety(ctx: Ctx, societyId: number, t: Transaction): Promise<Ctx> {
  if (ctx.society?.id === societyId) return ctx;
  const s = await Society.findByPk(societyId, { transaction: t });
  return {
    ...ctx,
    society: {
      id: societyId,
      name: s?.name ?? '',
      status: s?.status ?? 'ACTIVE',
      timezone: s?.timezone ?? 'Asia/Kolkata',
      planKey: '',
    },
  };
}

export const realPart2Approvals: Part2Ports['approvals'] = {
  registerType: (type, handlers) => registerType(type, wrap(handlers), { replace: true }),
  request: async (ctx, input, t) => {
    const { societyId, ...rest } = input;
    const r = await request(await withSociety(ctx, societyId, t), rest, t);
    return { id: Number(r.id), autoApproved: r.status === 'APPROVED' };
  },
  cancel: (ctx, id, reason, t) => cancel(ctx, id, reason, t),
  resubmit: async (ctx, id, input, t) => {
    await resubmit(ctx, id, input, t);
  },
  publicStatus: async (societyId, type, entityId) => {
    const s = await publicStatus(societyId, type, entityId);
    return s ? { status: s.status as 'PENDING' } : null;
  },
};

export const realPart3Approvals: ResidentPart3Ports['approvals'] = {
  registerType: (type, handlers) => registerType(type, wrap(handlers), { replace: true }),
  request: async (ctx, input, t) => {
    const meta = typeMeta(input.type)!;
    const summary = input.summary
      .map(s => `${s.label}: ${s.value}`)
      .join(' · ')
      .slice(0, 500);
    const r = await request(
      ctx,
      {
        type: input.type,
        entityType: meta.entityType,
        entityId: input.entityId,
        unitId: input.unitId,
        title: input.title,
        summary,
        payload: { ...input.payload, facts: input.summary },
      },
      t,
    );
    return { id: Number(r.id) };
  },
  resubmit: async (ctx, id, input, t) => {
    await resubmit(
      ctx,
      id,
      {
        title: input.title,
        summary: input.summary
          .map(s => `${s.label}: ${s.value}`)
          .join(' · ')
          .slice(0, 500),
      },
      t,
    );
  },
  cancel: (ctx, id, reason, t) => cancel(ctx, id, reason, t),
  publicStatus: async (societyId, type, entityId) => {
    const s = await publicStatus(societyId, type, entityId);
    return { status: (s?.status ?? 'PENDING') as 'PENDING' };
  },
};
