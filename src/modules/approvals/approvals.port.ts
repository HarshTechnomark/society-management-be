import type { Transaction } from 'sequelize';
import type {
  ApprovalRequestInput,
  ApprovalResult,
  ApprovalTypeHooks,
  ApprovalsPort,
} from '../billing/billing.ports';
import type { Ctx } from '../../types/context';
import { request, resubmit, cancel, lockOpenForEntityType } from './approvals.engine';
import { registerType } from './approvals.registry';
import type { ApprovalCtx, ApprovalRequestView, TypeHandlers } from './approvals.types';

/**
 * The real module 14 behind the `ApprovalsPort` of modules 11, 12 and 13 (`billing.ports.ts`, `payments.ports.ts`,
 * `accounts.ports.ts`: the same interface). It is the default of those ports (`approvalsPortDefault`).
 *
 * Differences from the native API (section 8.20) that this adapter hides:
 * - the hooks take an entity id, not the request: `onApproved(ctx, entityId, t)`, `onRejected(ctx, entityId, reason, t)`; the
 *   request id and payload travel on `ctx.approval` (`{ requestId, payload, ... }`, read with `approvalOf(ctx)`);
 * - `describe(entityId)` returns a flat list of facts;
 * - `cancel(ctx, id, reason, t)` is the owner-initiated cancel, which never calls a handler back.
 * As in the native API (BR-14-4), the engine runs `onApproved` inside `request` / `resubmit` when a rule auto-approves: callers
 * never apply the action themselves.
 */
type ExtendedHooks = ApprovalTypeHooks & {
  onExpired?: (ctx: Ctx, entityId: number, t: Transaction) => Promise<void>;
};

/** `ctx.approval` plus the request payload, so entity-id hooks can read what was asked (`approvalOf(ctx)`). */
const withPayload = (ctx: ApprovalCtx, req: ApprovalRequestView): ApprovalCtx => ({
  ...ctx,
  approval: { ...ctx.approval, requestId: req.id, payload: req.payload },
});

export function wrapHooks(def: ApprovalTypeHooks): TypeHandlers {
  const ext = def as ExtendedHooks;
  const h: TypeHandlers = {
    onApproved: (ctx: ApprovalCtx, req: ApprovalRequestView, t) =>
      def.onApproved(withPayload(ctx, req), req.entityId, t),
    onRejected: (ctx, req, t) =>
      def.onRejected(withPayload(ctx, req), req.entityId, ctx.approval.reason ?? req.decisionReason ?? '', t),
    describe: async req => ({
      facts: (await def.describe(req.entityId)).map(f => ({
        label: f.label,
        value: f.value,
        kind: f.kind ?? 'text',
      })),
      link: null,
    }),
  };
  if (def.onChangesRequested)
    h.onChangesRequested = (ctx, req, t) => def.onChangesRequested!(withPayload(ctx, req), req.entityId, t);
  if (def.onCancelled)
    h.onCancelled = (ctx, req, t) => def.onCancelled!(withPayload(ctx, req), req.entityId, t);
  if (ext.onExpired) h.onExpired = (ctx, req, t) => ext.onExpired!(withPayload(ctx, req), req.entityId, t);
  return h;
}

export const realApprovals: ApprovalsPort = {
  registerType: def => registerType(def.type, wrapHooks(def), { replace: true }),
  request: async (ctx, input: ApprovalRequestInput, t): Promise<ApprovalResult> => {
    const r = await request(ctx, { ...input, payload: input.payload ?? {} }, t);
    return { id: Number(r.id), status: r.status === 'APPROVED' ? 'APPROVED' : 'PENDING' };
  },
  resubmit: async (ctx, id, input, t) => {
    await resubmit(ctx, id, input, t);
  },
  cancel: (ctx, id, reason, t) => cancel(ctx, id, reason, t),
  lockOpenForEntity: async (societyId, entityType, entityId, t) => {
    const r = await lockOpenForEntityType(societyId, entityType, entityId, t);
    return r ? { id: Number(r.id), type: r.type } : null;
  },
};
