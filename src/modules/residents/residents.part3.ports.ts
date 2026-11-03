import type { Transaction } from 'sequelize';
import type { Ctx } from '../../types/context';

/**
 * What module 09 part 3 needs from modules that are not built yet: module 11 `invoices`, module 13 `deposits`, module 14
 * `approvals`, module 23 `shareCertificates` and `ruleViolations`. Each default is a small placeholder that behaves as the
 * spec describes; the owner calls `setResidentPart3Ports({...})` at start-up (tests do the same). Module 11's
 * `unitLedger.balance` is the one port of part 1 (`residentPorts().unitLedger`). When the three parts are merged these
 * ports may move into `residents.ports.ts` unchanged.
 */
export type ApprovalType = 'RENOVATION_PERMIT' | 'OWNERSHIP_TRANSFER';
export interface ApprovalRequestRef {
  id?: number;
  entityId: number;
  societyId: number;
  reason?: string | null;
}
export interface ApprovalHandlers {
  onApproved(ctx: Ctx, req: ApprovalRequestRef, t: Transaction): Promise<void>;
  onRejected(ctx: Ctx, req: ApprovalRequestRef, t: Transaction): Promise<void>;
  onChangesRequested(ctx: Ctx, req: ApprovalRequestRef, t: Transaction): Promise<void>;
  onCancelled(ctx: Ctx, req: ApprovalRequestRef, t: Transaction): Promise<void>;
  describe(req: ApprovalRequestRef): Promise<{ title: string; lines: { label: string; value: string }[] }>;
}

export interface AdHocInvoice {
  unitId: number;
  chargeHeadKey: string;
  amountPaise: number;
  refType: 'renovation_permit' | 'ownership_transfer';
  refId: number;
  dueDate: string;
}

export interface ResidentPart3Ports {
  /** Module 14. */
  approvals: {
    registerType(type: ApprovalType, handlers: ApprovalHandlers): void;
    /** `approvals.request`: returns the request id. A module 14 rule that matches nothing auto-approves inside this call. */
    request(
      ctx: Ctx,
      input: {
        type: ApprovalType;
        entityId: number;
        unitId: number;
        title: string;
        summary: { label: string; value: string }[];
        payload: Record<string, unknown>;
      },
      t: Transaction,
    ): Promise<{ id: number }>;
    resubmit(
      ctx: Ctx,
      requestId: number,
      input: { title: string; summary: { label: string; value: string }[] },
      t: Transaction,
    ): Promise<void>;
    cancel(ctx: Ctx, requestId: number, reason: string, t: Transaction): Promise<void>;
    /** `approvals.publicStatus(societyId, type, entityId).status`. */
    publicStatus(
      societyId: number,
      type: ApprovalType,
      entityId: number,
    ): Promise<{ status: 'PENDING' | 'CHANGES_REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED' }>;
  };
  /** Module 11. */
  invoices: {
    createAdHoc(ctx: Ctx, input: AdHocInvoice, t: Transaction): Promise<{ invoiceId: number }>;
    /** Cancels (through the module 11 `INVOICE_CANCEL` request) the unpaid invoices raised for an entity. */
    cancelForRef(
      ctx: Ctx,
      input: { refType: AdHocInvoice['refType']; refId: number; reason: string },
      t: Transaction,
    ): Promise<void>;
    /** The invoices raised for an entity, for the transfer detail. */
    listForRef(
      societyId: number,
      refType: AdHocInvoice['refType'],
      refId: number,
    ): Promise<{ invoiceId: number; chargeHeadKey: string; amountPaise: number; status: string }[]>;
  };
  /** Module 13. */
  deposits: {
    request(
      ctx: Ctx,
      input: {
        unitId: number;
        kind: 'RENOVATION';
        refType: 'renovation_permit';
        refId: number;
        amountPaise: number;
        payerResidentId: number | null;
      },
      t: Transaction,
    ): Promise<{ depositId: number; paymentOrderId: number }>;
    /** Module 13 runs its `DEPOSIT_REFUND` approval. */
    requestRefund(
      ctx: Ctx,
      depositId: number,
      input: { deductionPaise: number; reason: string },
      t: Transaction,
    ): Promise<void>;
  };
  /** Module 23. */
  ruleViolations: {
    create(
      ctx: Ctx,
      input: {
        unitId: number;
        ruleKey: 'RENOVATION';
        description: string;
        finePaise: number;
        refType: 'renovation_permit';
        refId: number;
      },
      t: Transaction,
    ): Promise<void>;
  };
  shareCertificates: {
    /** The society's current certificate of the unit, or `null` when none was issued. */
    currentForUnit(societyId: number, unitId: number): Promise<{ id: number } | null>;
    /** Endorsement and member register entries (BR-09-67), in the transfer's transaction. */
    onOwnershipTransferred(
      ctx: Ctx,
      input: {
        transferId: number;
        unitId: number;
        sellerResidentIds: number[];
        buyers: { residentId: number; sharePercent: string; isPrimary: boolean }[];
        effectiveDate: string;
        transferType: string;
      },
      t: Transaction,
    ): Promise<void>;
  };
}

export interface Part3PortCall {
  fn: string;
  input: unknown;
  t?: Transaction;
}
/** Every call a placeholder received (tests assert the calls and that they ran in the caller's transaction). */
export const part3PortCalls: Part3PortCall[] = [];
/** The handlers module 14 would hold after `registerType`. */
export const approvalHandlers = new Map<ApprovalType, ApprovalHandlers>();
/** The in-memory module 14 request store of the placeholder (`approvals.request` fills it). */
export interface StoredApproval {
  id: number;
  type: ApprovalType;
  entityId: number;
  societyId: number;
  unitId: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
}
export const approvalStore = new Map<number, StoredApproval>();
/** Test switches of the placeholders. */
export const placeholderState = {
  /** `approvals.request` calls `onApproved` inside the same transaction, as module 14 does when no rule matches. */
  autoApprove: false,
  nextApprovalId: 9000,
  nextInvoiceId: 7000,
  nextDepositId: 5000,
  publicStatus: 'PENDING' as 'PENDING' | 'CHANGES_REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED',
  invoices: [] as {
    invoiceId: number;
    refType: string;
    refId: number;
    chargeHeadKey: string;
    amountPaise: number;
    status: string;
  }[],
};

export const defaultPart3Ports: ResidentPart3Ports = {
  approvals: {
    registerType: (type, handlers) => {
      approvalHandlers.set(type, handlers);
    },
    request: async (ctx, input, t) => {
      const id = placeholderState.nextApprovalId++;
      part3PortCalls.push({ fn: 'approvals.request', input: { ...input, id }, t });
      approvalStore.set(id, {
        id,
        type: input.type,
        entityId: input.entityId,
        societyId: ctx.society!.id,
        unitId: input.unitId,
        status: 'PENDING',
      });
      if (placeholderState.autoApprove) {
        const h = approvalHandlers.get(input.type);
        if (h) await h.onApproved(ctx, { id, entityId: input.entityId, societyId: ctx.society!.id }, t);
      }
      return { id };
    },
    resubmit: async (_ctx, requestId, input, t) => {
      part3PortCalls.push({ fn: 'approvals.resubmit', input: { requestId, ...input }, t });
    },
    cancel: async (_ctx, requestId, reason, t) => {
      const a = approvalStore.get(requestId);
      if (a) a.status = 'CANCELLED';
      part3PortCalls.push({ fn: 'approvals.cancel', input: { requestId, reason }, t });
    },
    publicStatus: async () => ({ status: placeholderState.publicStatus }),
  },
  invoices: {
    createAdHoc: async (_ctx, input, t) => {
      const invoiceId = placeholderState.nextInvoiceId++;
      part3PortCalls.push({ fn: 'invoices.createAdHoc', input: { ...input, invoiceId }, t });
      placeholderState.invoices.push({
        invoiceId,
        refType: input.refType,
        refId: input.refId,
        chargeHeadKey: input.chargeHeadKey,
        amountPaise: input.amountPaise,
        status: 'UNPAID',
      });
      return { invoiceId };
    },
    cancelForRef: async (_ctx, input, t) => {
      part3PortCalls.push({ fn: 'invoices.cancelForRef', input, t });
      for (const i of placeholderState.invoices)
        if (i.refType === input.refType && i.refId === input.refId && i.status === 'UNPAID')
          i.status = 'CANCEL_REQUESTED';
    },
    listForRef: async (_societyId, refType, refId) =>
      placeholderState.invoices
        .filter(i => i.refType === refType && i.refId === refId)
        .map(({ invoiceId, chargeHeadKey, amountPaise, status }) => ({
          invoiceId,
          chargeHeadKey,
          amountPaise,
          status,
        })),
  },
  deposits: {
    request: async (_ctx, input, t) => {
      const depositId = placeholderState.nextDepositId++;
      part3PortCalls.push({ fn: 'deposits.request', input: { ...input, depositId }, t });
      return { depositId, paymentOrderId: depositId + 90_000 };
    },
    requestRefund: async (_ctx, depositId, input, t) => {
      part3PortCalls.push({ fn: 'deposits.requestRefund', input: { depositId, ...input }, t });
    },
  },
  ruleViolations: {
    create: async (_ctx, input, t) => {
      part3PortCalls.push({ fn: 'ruleViolations.create', input, t });
    },
  },
  shareCertificates: {
    currentForUnit: async () => null,
    onOwnershipTransferred: async (_ctx, input, t) => {
      part3PortCalls.push({ fn: 'shareCertificates.onOwnershipTransferred', input, t });
    },
  },
};

let current: ResidentPart3Ports = defaultPart3Ports;
export const part3Ports = (): ResidentPart3Ports => current;

/** Replace some ports (the owner module at start-up, or tests). Pass nothing to restore the placeholders. */
export function setResidentPart3Ports(p?: {
  [K in keyof ResidentPart3Ports]?: Partial<ResidentPart3Ports[K]>;
}): void {
  if (!p) {
    current = defaultPart3Ports;
    return;
  }
  const next = { ...current } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p))
    next[k] = { ...(current as unknown as Record<string, object>)[k], ...v };
  current = next as unknown as ResidentPart3Ports;
}

/** Test helper: forget the recorded calls, invoices and switches. */
export function resetPart3Placeholders(): void {
  part3PortCalls.length = 0;
  placeholderState.autoApprove = false;
  placeholderState.publicStatus = 'PENDING';
  placeholderState.invoices.length = 0;
  approvalStore.clear();
  current = defaultPart3Ports;
}
