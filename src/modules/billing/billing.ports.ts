import type { Transaction } from 'sequelize';
import { logger } from '../../lib/logger';
import { notify } from '../../lib/notify';
import type { Ctx } from '../../types/context';
import { UnprocessableError } from '../../utils/errors';
import type { MeterSource, MeterSourceType, YmdString } from './billing.types';
import type { MeterType } from './billing.constants';

/**
 * What module 11 needs from modules 12, 13, 14, 16 and 21 (section 1.1, build step 4). Each port has a placeholder (the
 * "fake") that behaves as the spec describes and records its calls; the owning module replaces it at start-up with
 * `setBillingPorts({...})` (tests do the same). In production `assertBillingPortsReady()` (called by `registerBilling()`)
 * refuses to start while the approvals, journal or notification port is still a placeholder (section 1.1). The advances
 * and meter ports have safe production defaults: no advance to apply, and `METERED` rules rejected with
 * `422 METER_SOURCE_NOT_AVAILABLE`.
 */

// ------------------------------------------------------------------ module 14 approvals
export interface ApprovalRequestInput {
  type: string;
  entityType: string;
  entityId: number;
  title: string;
  amountPaise?: number;
  summary?: string;
  payload?: Record<string, unknown>;
}
export interface ApprovalResult {
  id: number;
  /** `PENDING`, or `APPROVED` when module 14 auto-approved inside the caller's transaction. */
  status: 'PENDING' | 'APPROVED';
}
/** BR-11 module 14 type definition; the real `approvals.registerType` takes the callbacks of section 9.2. */
export interface ApprovalTypeHooks {
  type: string;
  onApproved(ctx: Ctx, entityId: number, t: Transaction): Promise<void>;
  onRejected(ctx: Ctx, entityId: number, reason: string, t: Transaction): Promise<void>;
  onChangesRequested?(ctx: Ctx, entityId: number, t: Transaction): Promise<void>;
  onCancelled?(ctx: Ctx, entityId: number, t: Transaction): Promise<void>;
  describe(entityId: number): Promise<{ label: string; value: string; kind?: 'money' | 'date' | 'text' }[]>;
}
export interface ApprovalsPort {
  registerType(def: ApprovalTypeHooks): void;
  request(ctx: Ctx, input: ApprovalRequestInput, t: Transaction): Promise<ApprovalResult>;
  resubmit(
    ctx: Ctx,
    approvalRequestId: number,
    input: { title: string; amountPaise?: number; payload?: Record<string, unknown> },
    t: Transaction,
  ): Promise<void>;
  cancel(ctx: Ctx, approvalRequestId: number, reason: string, t: Transaction): Promise<void>;
  /** Lock order step 1 (BR-14-14): the open request of an entity, or null. */
  lockOpenForEntity(
    societyId: number,
    entityType: string,
    entityId: number,
    t: Transaction,
  ): Promise<{ id: number; type: string } | null>;
}

// ------------------------------------------------------------------ module 13 journal and chart
export interface JournalLine {
  accountCode: string;
  debitPaise: number;
  creditPaise: number;
  unitId?: number;
  fundId?: number | null;
  narration?: string;
}
export interface JournalInput {
  date: YmdString;
  voucherType: string;
  refType: string;
  refId: number;
  narration: string;
  lines: JournalLine[];
}
export interface JournalPort {
  /** BR-11-68: lines always balance; an imbalance is a programming error. */
  post(ctx: Ctx, input: JournalInput, t: Transaction): Promise<{ id: number }>;
  /** BR-11-12 (`ledgerAccounts.exists`): code or system key of an active leaf account. */
  accountExists(societyId: number, code: string): Promise<boolean>;
  /** Module 13 `accounts.isDateLocked`: false in the placeholder. */
  isDateLocked(societyId: number, date: YmdString): Promise<boolean>;
}

// ------------------------------------------------------------------ module 16 notifications
export interface NotificationsPort {
  send(template: string, userIds: number[], data: Record<string, unknown>): Promise<void>;
}

// ------------------------------------------------------------------ module 12 payments and advances
export interface PaymentsPort {
  /** Module 12 `unit_advances` balance of the flat (paise, ≥ 0). Safe default: 0. */
  advanceBalance(societyId: number, unitId: number): Promise<number>;
  /** Advance to apply to a freshly issued invoice (F18). Safe default: nothing to apply. */
  applyAdvanceToInvoice(
    ctx: Ctx,
    input: { unitId: number; invoiceId: number; outstandingPaise: number },
    t: Transaction,
  ): Promise<{ appliedPaise: number }>;
  /** BR-11-65 opening advance; module 12 posts no journal or ledger entry for it. */
  creditOpeningAdvance(
    ctx: Ctx,
    input: { unitId: number; amountPaise: number; asOfDate: YmdString; openingBalanceId: number },
    t: Transaction,
  ): Promise<{ advanceId: number }>;
  /** After commit: module 12 applies the advances of these flats to their open invoices (`payments:apply-advances`). Safe default: no-op. */
  queueAdvanceApply(societyId: number, unitIds: number[]): Promise<void>;
  /** Called before a credit note larger than the outstanding and on cancellation (BR-11-42). Safe default: no-op. */
  onInvoiceCancelled(ctx: Ctx, invoiceId: number, t: Transaction): Promise<void>;
  listAllocationsForInvoice(
    societyId: number,
    invoiceId: number,
  ): Promise<{ paymentId: number; amountPaise: number }[]>;
  /** Module 12 (NEW, section 17): returned cheques of a flat since a date, for module 24. */
  chequeReturnCount(societyId: number, unitId: number, since: YmdString): Promise<number>;
}

// ------------------------------------------------------------------ module 21 meters
export interface MetersPort {
  getSource(meterType: MeterType): MeterSource | undefined;
  /** BR-11-17: marks readings billed when an issued invoice has METERED lines. Safe default: no-op. */
  markBilled(ctx: Ctx, readingIds: number[], billingRunRef: string, t: Transaction): Promise<void>;
}

export interface BillingPorts {
  approvals: ApprovalsPort;
  journal: JournalPort;
  notifications: NotificationsPort;
  payments: PaymentsPort;
  meters: MetersPort;
}
export type BillingPortName = keyof BillingPorts;

export interface BillingPortCall {
  fn: string;
  input: unknown;
  t?: Transaction;
}
/** Every call a placeholder received (tests assert the calls). */
export const billingPortCalls: BillingPortCall[] = [];
const record = (fn: string, input: unknown, t?: Transaction) => {
  billingPortCalls.push({ fn, input, t });
};

let fakeSeq = 0;
/** Registered type hooks (placeholder); the real module 14 keeps its own registry. */
export const placeholderApprovalTypes = new Map<string, ApprovalTypeHooks>();

export const defaultBillingPorts: BillingPorts = {
  approvals: {
    registerType: def => {
      placeholderApprovalTypes.set(def.type, def);
    },
    request: async (_ctx, input, t) => {
      record('approvals.request', input, t);
      return { id: ++fakeSeq, status: 'PENDING' };
    },
    resubmit: async (_ctx, id, input, t) => record('approvals.resubmit', { id, ...input }, t),
    cancel: async (_ctx, id, reason, t) => record('approvals.cancel', { id, reason }, t),
    lockOpenForEntity: async () => null,
  },
  journal: {
    post: async (_ctx, input, t) => {
      const dr = input.lines.reduce((a, l) => a + l.debitPaise, 0);
      const cr = input.lines.reduce((a, l) => a + l.creditPaise, 0);
      if (dr !== cr) throw new Error(`journal does not balance: Dr ${dr} Cr ${cr}`);
      record('journal.post', input, t);
      return { id: ++fakeSeq };
    },
    // Until module 13 exists only the format of BR-11-12 is checked.
    accountExists: async (_societyId, code) =>
      /^\d{4}(-\d{3})?$/.test(code) || /^[A-Z][A-Z_]{2,39}$/.test(code),
    isDateLocked: async () => false,
  },
  notifications: {
    send: async (template, userIds, data) => {
      record('notifications.send', { template, userIds, data });
      try {
        await notify(
          template,
          userIds.map(userId => ({ userId })),
          data,
        );
      } catch (err) {
        logger.error({ err, template }, 'billing notify failed');
      }
    },
  },
  payments: {
    advanceBalance: async () => 0,
    applyAdvanceToInvoice: async () => ({ appliedPaise: 0 }),
    creditOpeningAdvance: async (_ctx, input, t) => {
      record('payments.creditOpeningAdvance', input, t);
      return { advanceId: ++fakeSeq };
    },
    queueAdvanceApply: async (societyId, unitIds) =>
      record('payments.queueAdvanceApply', { societyId, unitIds }),
    onInvoiceCancelled: async (_ctx, invoiceId, t) => record('payments.onInvoiceCancelled', { invoiceId }, t),
    listAllocationsForInvoice: async () => [],
    chequeReturnCount: async () => 0,
  },
  meters: {
    getSource: () => undefined,
    markBilled: async (_ctx, readingIds, billingRunRef, t) =>
      record('meters.markBilled', { readingIds, billingRunRef }, t),
  },
};

let current: BillingPorts = defaultBillingPorts;
/** Ports a real module has replaced (the fake check of `assertBillingPortsReady`). */
const replaced = new Set<BillingPortName>();
export const billingPorts = (): BillingPorts => current;

/** Replace some ports (the owner module at start-up, or tests). Pass nothing to restore the placeholders. */
export function setBillingPorts(p?: { [K in keyof BillingPorts]?: Partial<BillingPorts[K]> }): void {
  if (!p) {
    current = defaultBillingPorts;
    replaced.clear();
    billingPortCalls.length = 0;
    return;
  }
  const next = { ...current } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    next[k] = { ...(current as unknown as Record<string, object>)[k], ...v };
    replaced.add(k as BillingPortName);
  }
  current = next as unknown as BillingPorts;
}

/** Ports whose placeholder is not allowed in production (section 1.1). */
export const PRODUCTION_REQUIRED_PORTS: readonly BillingPortName[] = [
  'approvals',
  'journal',
  'notifications',
];

/** Names of the production-required ports that are still placeholders. */
export const fakePortsInUse = (): BillingPortName[] =>
  PRODUCTION_REQUIRED_PORTS.filter(n => !replaced.has(n));

/** Section 1.1: in production the server refuses to start while approvals, journal or notifications are placeholders. */
export function assertBillingPortsReady(nodeEnv: string | undefined = process.env.NODE_ENV): void {
  if (nodeEnv !== 'production') return;
  const fakes = fakePortsInUse();
  if (fakes.length)
    throw new Error(`Billing ports still use the placeholder in production: ${fakes.join(', ')}`);
}

// ------------------------------------------------------------------ meter source registry (module 21 registers here)
const meterSources = new Map<MeterType, MeterSource>();
/** `meterSources.register(type, source)` of section 8.24; module 21 calls it at start-up. */
export function registerMeterSource(meterType: MeterSourceType, source: MeterSource): void {
  meterSources.set(meterType, source);
  setBillingPorts({ meters: { getSource: t => meterSources.get(t) } });
}
export const clearMeterSources = (): void => meterSources.clear();
/** BR-11 `422 METER_SOURCE_NOT_AVAILABLE`: thrown when a `METERED` rule needs a source nobody registered. */
export function requireMeterSource(meterType: MeterType): MeterSource {
  const s = billingPorts().meters.getSource(meterType);
  if (!s)
    throw new UnprocessableError('METER_SOURCE_NOT_AVAILABLE', 'Metered billing is not available yet', [
      { field: 'meterType', message: `No meter source is registered for ${meterType}` },
    ]);
  return s;
}
