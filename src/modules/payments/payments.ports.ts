import type { Transaction } from 'sequelize';
import { paymentGateway } from '../../adapters';
import type { PaymentGateway } from '../../adapters/payments/payment-gateway';
import { logger } from '../../lib/logger';
import { notify } from '../../lib/notify';
import type { Ctx } from '../../types/context';
import { engineApprovals } from '../billing/billing.ports';
import type {
  ApprovalRequestInput,
  ApprovalResult,
  ApprovalTypeHooks,
  ApprovalsPort,
  JournalPort,
  NotificationsPort,
} from '../billing/billing.ports';

export type { ApprovalRequestInput, ApprovalResult, ApprovalTypeHooks, ApprovalsPort, JournalPort };

/**
 * What module 12 needs from modules 13 (journal, funds, bank accounts, society balance), 14 (approvals), 16 (notifications,
 * notices) and 29 (gateway accounts). Each port has a placeholder that behaves as the spec describes and records its calls;
 * the owning module replaces it at start-up with `setPaymentsPorts({...})` (tests do the same). Same pattern as
 * `billing.ports.ts`. In production `assertPaymentsPortsReady()` refuses to start while journal, gateway accounts (approvals is the real module 14)
 * or notifications are still placeholders.
 */

// ------------------------------------------------------------------ module 13 funds, bank accounts, balance
export interface FundsPort {
  /** FUND_NOT_FOUND check of `collections.fundId` (BR-12 collections). Placeholder: every id is a fund. */
  exists(societyId: number, fundId: number): Promise<boolean>;
  name(societyId: number, fundId: number): Promise<string | null>;
}
export interface BankAccountsPort {
  /** `BANK_ACCOUNT_NOT_FOUND` check for cheque deposit and refunds. Placeholder: every id is an account. */
  get(societyId: number, id: number): Promise<{ id: number; label: string } | null>;
}
export interface SocietyBalancePort {
  /** Module 13 `society_balances` of the collection account; placeholder sums what module 12 journalled. */
  get(societyId: number): Promise<{ balancePaise: number }>;
}

// ------------------------------------------------------------------ module 29 gateway accounts
export interface GatewayAccountDto {
  id: number;
  societyId: number;
  provider: string;
  enabledMethods: FeeMethodKey[];
  supportsMandates: boolean;
  /** Webhook signing secret (module 29 stores it encrypted). */
  webhookSecret: string;
  isActive: boolean;
}
export type FeeMethodKey = 'UPI' | 'CARD' | 'NETBANKING' | 'WALLET';
export interface GatewayPort {
  /** The society's active gateway account, or null (`GATEWAY_NOT_CONFIGURED`). Placeholder: a fake account per society (id = society id). */
  accountFor(societyId: number): Promise<GatewayAccountDto | null>;
  getAccount(gatewayAccountId: number): Promise<GatewayAccountDto | null>;
  /** The adapter that talks to this account's provider (module 01 `PaymentGateway`). */
  clientFor(account: GatewayAccountDto): PaymentGateway;
}

// ------------------------------------------------------------------ module 16 notices
export interface NoticesPort {
  createSystemNotice(
    ctx: Ctx,
    input: Record<string, unknown>,
  ): Promise<{ noticeId: number; created: boolean }>;
  recallBySource(ctx: Ctx, sourceRefType: string, sourceRefId: number, reason: string): Promise<void>;
}

export interface PaymentsPorts {
  approvals: ApprovalsPort;
  journal: JournalPort;
  funds: FundsPort;
  bankAccounts: BankAccountsPort;
  societyBalance: SocietyBalancePort;
  notifications: NotificationsPort;
  gateways: GatewayPort;
  notices: NoticesPort;
}
export type PaymentsPortName = keyof PaymentsPorts;

export interface PaymentsPortCall {
  fn: string;
  input: unknown;
  t?: Transaction;
}
/** Every call a placeholder received (tests assert the calls). */
export const paymentsPortCalls: PaymentsPortCall[] = [];
const record = (fn: string, input: unknown, t?: Transaction) => {
  paymentsPortCalls.push({ fn, input, t });
};

let fakeSeq = 0;
/** Journal lines the placeholder accepted, so the placeholder society balance and the tests can read them. */
export const placeholderJournal: { id: number; societyId: number | null; input: unknown }[] = [];

/** One fake gateway account per society (module 29 placeholder). */
export const FAKE_WEBHOOK_SECRET = 'fake-webhook-secret';
export const fakeGatewayAccount = (societyId: number): GatewayAccountDto => ({
  id: societyId,
  societyId,
  provider: 'FAKE',
  enabledMethods: ['UPI', 'CARD', 'NETBANKING', 'WALLET'],
  supportsMandates: true,
  webhookSecret: FAKE_WEBHOOK_SECRET,
  isActive: true,
});

export const defaultPaymentsPorts: PaymentsPorts = {
  approvals: engineApprovals, // module 14 is real (billing.ports.ts)
  journal: {
    post: async (ctx, input, t) => {
      const dr = input.lines.reduce((a, l) => a + l.debitPaise, 0);
      const cr = input.lines.reduce((a, l) => a + l.creditPaise, 0);
      if (dr !== cr) throw new Error(`journal does not balance: Dr ${dr} Cr ${cr}`);
      record('journal.post', input, t);
      const id = ++fakeSeq;
      placeholderJournal.push({ id, societyId: ctx.society?.id ?? null, input });
      return { id };
    },
    accountExists: async (_s, code) => /^\d{4}(-\d{3})?$/.test(code) || /^[A-Z][A-Z_]{2,39}$/.test(code),
    isDateLocked: async () => false,
  },
  funds: {
    exists: async () => true,
    name: async (_s, fundId) => `Fund ${fundId}`,
  },
  bankAccounts: {
    get: async (_s, id) => ({ id, label: `Bank account ${id}` }),
  },
  societyBalance: {
    get: async societyId => {
      let balance = 0;
      for (const j of placeholderJournal) {
        const inp = j.input as { lines: { accountCode: string; debitPaise: number; creditPaise: number }[] };
        if (j.societyId !== societyId) continue;
        for (const l of inp.lines)
          if (
            l.accountCode === 'BANK' ||
            l.accountCode === 'GATEWAY_CLEARING' ||
            l.accountCode === 'CASH_IN_HAND'
          )
            balance += l.debitPaise - l.creditPaise;
      }
      return { balancePaise: balance };
    },
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
        logger.error({ err, template }, 'payments notify failed');
      }
    },
  },
  gateways: {
    accountFor: async societyId => fakeGatewayAccount(societyId),
    getAccount: async id => fakeGatewayAccount(id),
    clientFor: () => paymentGateway(),
  },
  notices: {
    createSystemNotice: async (_ctx, input) => {
      record('notices.createSystemNotice', input);
      return { noticeId: ++fakeSeq, created: true };
    },
    recallBySource: async (_ctx, type, id, reason) => record('notices.recallBySource', { type, id, reason }),
  },
};

let current: PaymentsPorts = defaultPaymentsPorts;
const replaced = new Set<PaymentsPortName>();
export const paymentsPorts = (): PaymentsPorts => current;

/** Replace some ports (the owner module at start-up, or tests). Pass nothing to restore the placeholders. */
export function setPaymentsPorts(p?: { [K in keyof PaymentsPorts]?: Partial<PaymentsPorts[K]> }): void {
  if (!p) {
    current = defaultPaymentsPorts;
    replaced.clear();
    paymentsPortCalls.length = 0;
    placeholderJournal.length = 0;
    return;
  }
  const next = { ...current } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p)) {
    next[k] = { ...(current as unknown as Record<string, object>)[k], ...v };
    replaced.add(k as PaymentsPortName);
  }
  current = next as unknown as PaymentsPorts;
}

/** Ports whose placeholder is not allowed in production. */
export const PRODUCTION_REQUIRED_PORTS: readonly PaymentsPortName[] = [
  'journal',
  'gateways',
  'notifications',
];
export const fakePortsInUse = (): PaymentsPortName[] =>
  PRODUCTION_REQUIRED_PORTS.filter(n => !replaced.has(n));
export function assertPaymentsPortsReady(nodeEnv: string | undefined = process.env.NODE_ENV): void {
  if (nodeEnv !== 'production') return;
  const fakes = fakePortsInUse();
  if (fakes.length)
    throw new Error(`Payments ports still use the placeholder in production: ${fakes.join(', ')}`);
}
