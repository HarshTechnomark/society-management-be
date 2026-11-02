import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Module 01 section 10 `PaymentGateway` (platform account use of module 06). Only the fake ships in this build; the
 * Razorpay implementation comes with the real providers (it must keep this exact shape).
 */
export type GatewayPaymentStatus = 'captured' | 'failed' | 'pending';

export interface GatewayWebhookEvent {
  eventId: string;
  type: string;
  orderId?: string;
  paymentId?: string;
  refundId?: string;
  mandateId?: string;
  amountPaise?: number;
  method?: string;
}

export interface PaymentGateway {
  createOrder(input: {
    societyGatewayAccountId: string;
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }): Promise<{ orderId: string; checkout: Record<string, unknown> }>;
  verifyWebhook(rawBody: Buffer, signature: string, secret: string): boolean;
  fetchPayment(
    paymentId: string,
  ): Promise<{ status: GatewayPaymentStatus; amountPaise: number; method: string; orderId: string }>;
  refund(paymentId: string, amountPaise: number, reason: string): Promise<{ refundId: string }>;
  fetchOrderPayments(
    orderId: string,
  ): Promise<{ paymentId: string; status: GatewayPaymentStatus; amountPaise: number; method: string }[]>;
  fetchRefund(refundId: string): Promise<{ status: 'processed' | 'pending' | 'failed'; amountPaise: number }>;
  createMandate(input: {
    societyGatewayAccountId: string;
    customerRef: string;
    maxAmountPaise: number;
    frequency: 'MONTHLY' | 'AS_PRESENTED';
    startDate: string;
    endDate: string;
  }): Promise<{ mandateId: string; authUrl: string }>;
  chargeMandate(input: {
    mandateId: string;
    amountPaise: number;
    receipt: string;
  }): Promise<{ orderId: string; paymentId: string | null }>;
  cancelMandate(mandateId: string): Promise<void>;
  parseWebhook(rawBody: Buffer): GatewayWebhookEvent;
  readonly signatureHeader: string;
}

interface FakeOrder {
  orderId: string;
  amountPaise: number;
  receipt: string;
}
interface FakePayment {
  paymentId: string;
  orderId: string;
  status: GatewayPaymentStatus;
  amountPaise: number;
  method: string;
}

/** Hex HMAC-SHA256 of the raw body, as Razorpay signs webhooks. Tests use it to sign their own events. */
export const signWebhookBody = (rawBody: Buffer | string, secret: string): string =>
  createHmac('sha256', secret).update(rawBody).digest('hex');

const id = (prefix: string, n = 14): string => `${prefix}${randomBytes(12).toString('hex').slice(0, n)}`;

/**
 * Development and test gateway: keeps orders, payments, refunds and mandates in memory. `payOrder` is what the
 * checkout would do (reachable in development through `POST /api/v1/dev/payments/:orderId/pay`). Webhook bodies are
 * Razorpay-shaped JSON `{ id, event, payload: { payment|refund|order|mandate: { entity } } }`.
 */
export class FakePaymentGateway implements PaymentGateway {
  readonly signatureHeader = 'x-razorpay-signature';
  readonly orders = new Map<string, FakeOrder>();
  readonly payments = new Map<string, FakePayment>();
  readonly refunds = new Map<string, { status: 'processed' | 'pending' | 'failed'; amountPaise: number }>();
  readonly mandates = new Map<string, { status: 'created' | 'cancelled'; maxAmountPaise: number }>();
  /** Makes the next call of the named method throw (tests of GATEWAY_ERROR). */
  failNext: Partial<
    Record<'createOrder' | 'fetchPayment' | 'refund' | 'createMandate' | 'cancelMandate', boolean>
  > = {};
  private seq = 0;

  private maybeFail(name: keyof FakePaymentGateway['failNext']): void {
    if (this.failNext[name]) {
      this.failNext[name] = false;
      throw new Error(`fake gateway: ${name} failed`);
    }
  }

  async createOrder(input: {
    societyGatewayAccountId: string;
    amountPaise: number;
    receipt: string;
    notes: Record<string, string>;
  }) {
    this.maybeFail('createOrder');
    this.seq += 1;
    const orderId = `order_${id('', 12)}${this.seq}`;
    this.orders.set(orderId, { orderId, amountPaise: input.amountPaise, receipt: input.receipt });
    return { orderId, checkout: { order_id: orderId, amount: input.amountPaise, currency: 'INR' } };
  }

  /** What the customer does at checkout: a payment on the order (default the order amount, captured). */
  payOrder(
    orderId: string,
    o: { amountPaise?: number; status?: GatewayPaymentStatus; method?: string } = {},
  ): FakePayment {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`unknown fake order ${orderId}`);
    const p: FakePayment = {
      paymentId: `pay_${id('', 14)}`,
      orderId,
      status: o.status ?? 'captured',
      amountPaise: o.amountPaise ?? order.amountPaise,
      method: o.method ?? 'upi',
    };
    this.payments.set(p.paymentId, p);
    return p;
  }

  verifyWebhook(rawBody: Buffer, signature: string, secret: string): boolean {
    if (!signature) return false;
    const want = Buffer.from(signWebhookBody(rawBody, secret));
    const got = Buffer.from(signature);
    return want.length === got.length && timingSafeEqual(want, got);
  }

  async fetchPayment(paymentId: string) {
    this.maybeFail('fetchPayment');
    const p = this.payments.get(paymentId);
    if (!p) throw new Error(`fake gateway: payment ${paymentId} not found`);
    return { status: p.status, amountPaise: p.amountPaise, method: p.method, orderId: p.orderId };
  }

  async refund(paymentId: string, amountPaise: number, _reason: string) {
    this.maybeFail('refund');
    if (!this.payments.has(paymentId)) throw new Error(`fake gateway: payment ${paymentId} not found`);
    const refundId = `rfnd_${id('', 14)}`;
    this.refunds.set(refundId, { status: 'pending', amountPaise });
    return { refundId };
  }

  async fetchOrderPayments(orderId: string) {
    return [...this.payments.values()]
      .filter(p => p.orderId === orderId)
      .map(({ paymentId, status, amountPaise, method }) => ({ paymentId, status, amountPaise, method }));
  }

  async fetchRefund(refundId: string) {
    const r = this.refunds.get(refundId);
    if (!r) throw new Error(`fake gateway: refund ${refundId} not found`);
    return { ...r };
  }

  async createMandate(input: { maxAmountPaise: number }) {
    this.maybeFail('createMandate');
    const mandateId = `token_${id('', 14)}`;
    this.mandates.set(mandateId, { status: 'created', maxAmountPaise: input.maxAmountPaise });
    return { mandateId, authUrl: `https://fake-gateway.invalid/authorize/${mandateId}` };
  }

  async chargeMandate(input: { mandateId: string; amountPaise: number; receipt: string }) {
    if (!this.mandates.has(input.mandateId)) throw new Error('fake gateway: unknown mandate');
    const o = await this.createOrder({
      societyGatewayAccountId: 'platform',
      amountPaise: input.amountPaise,
      receipt: input.receipt,
      notes: {},
    });
    return { orderId: o.orderId, paymentId: this.payOrder(o.orderId).paymentId };
  }

  async cancelMandate(mandateId: string) {
    this.maybeFail('cancelMandate');
    const m = this.mandates.get(mandateId);
    if (m) m.status = 'cancelled';
  }

  parseWebhook(rawBody: Buffer): GatewayWebhookEvent {
    const j = JSON.parse(rawBody.toString('utf8')) as {
      id?: string;
      event?: string;
      payload?: Record<string, { entity?: Record<string, unknown> } | undefined>;
    };
    const p = j.payload ?? {};
    const pay = p.payment?.entity;
    const ref = p.refund?.entity;
    const ord = p.order?.entity;
    const man = p.mandate?.entity;
    const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    const n = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
    return {
      eventId: s(j.id) ?? '',
      type: s(j.event) ?? '',
      orderId: s(pay?.order_id) ?? s(ord?.id),
      paymentId: s(pay?.id) ?? s(ref?.payment_id),
      refundId: s(ref?.id),
      mandateId: s(man?.id),
      amountPaise: n(pay?.amount) ?? n(ref?.amount),
      method: s(pay?.method),
    };
  }
}
