import type { Transaction } from 'sequelize';
import type { Ctx } from '../../types/context';
import { residentPortCalls } from './residents.ports';

/**
 * Ports of module 09 part 2 to modules that are not built yet (BR-09-25, BR-09-42, BR-09-48, section 8.23):
 * module 14 `approvals` and module 13 `deposits`. Module 11 `unitLedger.balance` is the part 1 port in `residents.ports.ts`.
 * Each default is a placeholder that behaves as section 16 step 4 says: approvals auto-approve and call `onApproved`
 * inside the caller's transaction, deposits are treated as paid at once. Tests switch a placeholder to the manual mode
 * (`approvalStub.mode = 'manual'`, `depositStub.mode = 'pending'`) to drive the other branches. The owner module calls
 * `setPart2Ports({...})` at start-up and registers `joinRequestHandlers` and `moveHandlers` (see `residents.public.ts`).
 */
export interface ApprovalRef {
  id: number;
  societyId: number;
  entityId: number;
  type: string;
  reason?: string | null;
}
export interface ApprovalHandlers {
  onApproved(ctx: Ctx, req: ApprovalRef, t: Transaction): Promise<void>;
  onRejected(ctx: Ctx, req: ApprovalRef, t: Transaction): Promise<void>;
  describe?(
    societyId: number,
    entityId: number,
  ): Promise<{ title: string; lines: { label: string; value: string }[] }>;
  onChangesRequested?(ctx: Ctx, req: ApprovalRef, t: Transaction): Promise<void>;
  onCancelled?(ctx: Ctx, req: ApprovalRef, t: Transaction): Promise<void>;
}
export type ApprovalPublicStatus = 'PENDING' | 'CHANGES_REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

export interface Part2Ports {
  /** Module 14. `request` may approve at once (no rule matched) and then has already run `onApproved` in `t`. */
  approvals: {
    registerType(type: string, handlers: ApprovalHandlers): void;
    request(
      ctx: Ctx,
      input: {
        type: string;
        societyId: number;
        entityType: string;
        entityId: number;
        title: string;
        payload: Record<string, unknown>;
        unitId?: number;
      },
      t: Transaction,
    ): Promise<{ id: number; autoApproved: boolean }>;
    cancel(ctx: Ctx, approvalRequestId: number, reason: string, t: Transaction): Promise<void>;
    resubmit(
      ctx: Ctx,
      approvalRequestId: number,
      input: { title: string; summary: string },
      t: Transaction,
    ): Promise<void>;
    publicStatus(
      societyId: number,
      type: string,
      entityId: number,
    ): Promise<{ status: ApprovalPublicStatus } | null>;
  };
  /** Module 13. */
  deposits: {
    /** `paid: true` when the deposit is already settled; otherwise module 13 calls `residentsHooks.onDepositPaid` later. */
    request(
      ctx: Ctx,
      input: {
        societyId: number;
        refType: 'move_request';
        refId: number;
        unitId: number;
        amountPaise: number;
      },
      t: Transaction,
    ): Promise<{ depositId: number; paid: boolean }>;
    requestRefund(
      ctx: Ctx,
      depositId: number,
      input: { deductionPaise: number; reason: string },
      t: Transaction,
    ): Promise<void>;
  };
}

// ------------------------------------------------------------------ module 14 placeholder
interface StubRequest {
  id: number;
  societyId: number;
  type: string;
  entityId: number;
  status: ApprovalPublicStatus;
}
export const approvalStub = {
  /** `auto`: `request` approves at once. `manual`: it stays PENDING until `approve` or `reject`. */
  mode: 'auto' as 'auto' | 'manual',
  handlers: new Map<string, ApprovalHandlers>(),
  requests: new Map<number, StubRequest>(),
  seq: 0,
  reset(): void {
    this.mode = 'auto';
    this.requests.clear();
    this.seq = 0;
  },
  async approve(ctx: Ctx, id: number, t: Transaction): Promise<void> {
    const r = this.requests.get(id)!;
    r.status = 'APPROVED';
    await this.handlers.get(r.type)!.onApproved(ctx, ref(r), t);
  },
  async reject(ctx: Ctx, id: number, reason: string, t: Transaction): Promise<void> {
    const r = this.requests.get(id)!;
    r.status = 'REJECTED';
    await this.handlers.get(r.type)!.onRejected(ctx, ref(r, reason), t);
  },
  async requestChanges(ctx: Ctx, id: number, t: Transaction): Promise<void> {
    const r = this.requests.get(id)!;
    r.status = 'CHANGES_REQUESTED';
    await this.handlers.get(r.type)!.onChangesRequested?.(ctx, ref(r), t);
  },
  async cancelFromInbox(ctx: Ctx, id: number, t: Transaction): Promise<void> {
    const r = this.requests.get(id)!;
    r.status = 'CANCELLED';
    await this.handlers.get(r.type)!.onCancelled?.(ctx, ref(r), t);
  },
};
const ref = (r: StubRequest, reason: string | null = null): ApprovalRef => ({
  id: r.id,
  societyId: r.societyId,
  entityId: r.entityId,
  type: r.type,
  reason,
});

// ------------------------------------------------------------------ module 13 placeholder
export const depositStub = {
  /** `paid`: a deposit is settled at once (section 16 step 4). `pending`: wait for `residentsHooks.onDepositPaid`. */
  mode: 'paid' as 'paid' | 'pending',
  seq: 0,
  reset(): void {
    this.mode = 'paid';
    this.seq = 0;
  },
};

export const defaultPart2Ports: Part2Ports = {
  approvals: {
    registerType: (type, handlers) => {
      approvalStub.handlers.set(type, handlers);
    },
    request: async (ctx, input, t) => {
      const id = ++approvalStub.seq;
      const row: StubRequest = {
        id,
        societyId: input.societyId,
        type: input.type,
        entityId: input.entityId,
        status: 'PENDING',
      };
      approvalStub.requests.set(id, row);
      residentPortCalls.push({ fn: 'approvals.request', input, t });
      if (approvalStub.mode === 'auto') await approvalStub.approve(ctx, id, t);
      return { id, autoApproved: approvalStub.mode === 'auto' };
    },
    cancel: async (_ctx, id, reason, t) => {
      const r = approvalStub.requests.get(id);
      if (r) r.status = 'CANCELLED';
      residentPortCalls.push({ fn: 'approvals.cancel', input: { id, reason }, t });
    },
    resubmit: async (_ctx, id, input, t) => {
      const r = approvalStub.requests.get(id);
      if (r) r.status = 'PENDING';
      residentPortCalls.push({ fn: 'approvals.resubmit', input: { id, ...input }, t });
    },
    publicStatus: async (societyId, type, entityId) => {
      const rows = [...approvalStub.requests.values()].filter(
        r => r.societyId === societyId && r.type === type && r.entityId === entityId,
      );
      const last = rows[rows.length - 1];
      return last ? { status: last.status } : null;
    },
  },
  deposits: {
    request: async (_ctx, input, t) => {
      const depositId = ++depositStub.seq;
      residentPortCalls.push({ fn: 'deposits.request', input: { ...input, depositId }, t });
      return { depositId, paid: depositStub.mode === 'paid' };
    },
    requestRefund: async (_ctx, depositId, input, t) => {
      residentPortCalls.push({ fn: 'deposits.requestRefund', input: { depositId, ...input }, t });
    },
  },
};

let current: Part2Ports = defaultPart2Ports;
export const part2Ports = (): Part2Ports => current;

/** Replace some part 2 ports (the owner module at start-up, or tests). Pass nothing to restore the placeholders. */
export function setPart2Ports(p?: { [K in keyof Part2Ports]?: Partial<Part2Ports[K]> }): void {
  if (!p) {
    current = defaultPart2Ports;
    return;
  }
  const next = { ...current } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p))
    next[k] = { ...(current as unknown as Record<string, object>)[k], ...v };
  current = next as unknown as Part2Ports;
}
