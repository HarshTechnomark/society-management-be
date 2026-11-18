import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { now } from '../lib/clock';
import { recordInbox } from '../lib/inbox';

/**
 * What module 07 needs from a provider (section 8.13: `healthCheck` and, for messaging, `testSend`). The fake vendor is
 * built here; the real vendors (MSG91, Gupshup, SES, Razorpay, ...) are wired in by module 16 and answer with a clear
 * "not built" error until then, so nobody believes a check or a test message succeeded.
 */
export interface HealthResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}
export interface ProviderAdapter {
  healthCheck(): Promise<HealthResult>;
  /** Messaging channels only (SMS, WHATSAPP, EMAIL). Throws on failure. */
  testSend(to: string, text: string): Promise<{ providerMessageId: string }>;
  /** Gateway, storage, IVR: an authenticated read. Throws on failure. */
  connectionTest(): Promise<{ detail: string }>;
  /**
   * Module 01 section 10 (NEW, module 16 8.37): true when the signature over the raw body is valid and the timestamp is at most 5 minutes old.
   * `credentials` are the decrypted credentials of the provider row (null for the fake or an environment vendor).
   */
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | undefined>,
    credentials: Record<string, string> | null,
  ): boolean;
  /** Parses a verified webhook body into events (hashes only: no mobile number or e-mail address leaves the adapter). */
  parseWebhook(rawBody: Buffer): MessagingWebhookEvent[];
}

/** Events of a messaging provider webhook (module 16 8.37). Hashes are lower-case sha256 hex of the 10-digit mobile / the lower-cased e-mail. */
export type MessagingWebhookEvent =
  | {
      providerMessageId: string;
      status: 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
      at: string;
      errorCode?: string;
    }
  | { inbound: 'STOP'; mobileHash: string }
  | { inbound: 'BUTTON'; payload: string; mobileHash: string }
  | { bounce: 'HARD' | 'COMPLAINT'; emailHash: string };

export const WEBHOOK_REPLAY_SECONDS = 300;
export const FAKE_WEBHOOK_SECRET = 'fake-webhook-secret';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * Signature of the fake vendor: header `x-webhook-timestamp` (epoch milliseconds) and `x-webhook-signature` = hex HMAC-SHA256 of
 * `<timestamp>.<raw body>` with the credential `webhookSecret` (default `FAKE_WEBHOOK_SECRET`). Tests and the dev tools sign with `signFakeWebhook`.
 */
export function signFakeWebhook(
  rawBody: Buffer | string,
  timestampMs: number,
  secret = FAKE_WEBHOOK_SECRET,
): string {
  return createHmac('sha256', secret).update(`${timestampMs}.`).update(rawBody).digest('hex');
}
export function verifyFakeWebhook(
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
  credentials: Record<string, string> | null,
): boolean {
  const ts = Number(headers['x-webhook-timestamp']);
  const sig = headers['x-webhook-signature'];
  if (!sig || !Number.isFinite(ts)) return false;
  if (Math.abs(now().getTime() - ts) > WEBHOOK_REPLAY_SECONDS * 1000) return false;
  const want = Buffer.from(
    signFakeWebhook(rawBody, ts, credentials?.webhookSecret ?? FAKE_WEBHOOK_SECRET),
    'hex',
  );
  const got = Buffer.from(sig, 'hex');
  return got.length === want.length && timingSafeEqual(got, want);
}
/** Fake body: `{ events: [ { providerMessageId, status, at?, errorCode? } | { inbound: 'STOP', mobile } | { inbound: 'BUTTON', payload, mobile } | { bounce, email } ] }`. */
export function parseFakeWebhook(rawBody: Buffer): MessagingWebhookEvent[] {
  const body = JSON.parse(rawBody.toString('utf8')) as { events?: Record<string, unknown>[] };
  const out: MessagingWebhookEvent[] = [];
  for (const e of body.events ?? []) {
    if (e.inbound === 'STOP' && typeof e.mobile === 'string')
      out.push({ inbound: 'STOP', mobileHash: sha(e.mobile) });
    else if (e.inbound === 'BUTTON' && typeof e.mobile === 'string' && typeof e.payload === 'string')
      out.push({ inbound: 'BUTTON', payload: e.payload, mobileHash: sha(e.mobile) });
    else if ((e.bounce === 'HARD' || e.bounce === 'COMPLAINT') && typeof e.email === 'string')
      out.push({ bounce: e.bounce, emailHash: sha(e.email.toLowerCase()) });
    else if (
      typeof e.providerMessageId === 'string' &&
      ['SENT', 'DELIVERED', 'READ', 'FAILED'].includes(String(e.status))
    )
      out.push({
        providerMessageId: e.providerMessageId,
        status: e.status as 'SENT' | 'DELIVERED' | 'READ' | 'FAILED',
        at: typeof e.at === 'string' ? e.at : now().toISOString(),
        ...(typeof e.errorCode === 'string' ? { errorCode: e.errorCode } : {}),
      });
  }
  return out;
}

export type FailMode = 'none' | 'error' | 'slow';
export const FAKE_SLOW_LATENCY_MS = 5000;

export interface ProviderAdapterInput {
  channel: string;
  vendor: string;
  config: Record<string, unknown>;
  credentials: Record<string, string> | null;
}

/** Fake vendor: `failMode` `error` fails every call, `slow` reports a latency of 5 seconds (no real waiting). */
export class FakeProviderAdapter implements ProviderAdapter {
  constructor(
    private readonly channel: string,
    private readonly failMode: FailMode,
  ) {}

  async healthCheck(): Promise<HealthResult> {
    if (this.failMode === 'error') return { ok: false, latencyMs: 12, error: 'fake provider is set to fail' };
    return { ok: true, latencyMs: this.failMode === 'slow' ? FAKE_SLOW_LATENCY_MS : 12 };
  }

  async testSend(to: string, text: string): Promise<{ providerMessageId: string }> {
    if (this.failMode === 'error') throw new Error('fake provider is set to fail');
    await recordInbox({
      channel: this.channel === 'EMAIL' ? 'EMAIL' : this.channel === 'WHATSAPP' ? 'WHATSAPP' : 'SMS',
      to,
      subject: this.channel === 'EMAIL' ? 'SocietyApp test message' : null,
      body: text,
      templateKey: 'platform.provider.test',
    });
    return { providerMessageId: `fake_${randomBytes(4).toString('hex')}` };
  }

  async connectionTest(): Promise<{ detail: string }> {
    if (this.failMode === 'error') throw new Error('fake provider is set to fail');
    return { detail: 'fake connection ok' };
  }

  verifyWebhook = verifyFakeWebhook;
  parseWebhook = parseFakeWebhook;
}

/** Adapter for a provider row (credentials already decrypted by the caller). */
export function buildProviderAdapter(input: ProviderAdapterInput): ProviderAdapter {
  if (input.vendor === 'FAKE') {
    const m = input.config.failMode;
    return new FakeProviderAdapter(input.channel, m === 'error' || m === 'slow' ? m : 'none');
  }
  const notBuilt = () =>
    new Error(`The ${input.vendor} adapter is not built yet (module 16 wires the real providers)`);
  return {
    healthCheck: async () => ({ ok: false, latencyMs: 0, error: notBuilt().message }),
    testSend: async () => {
      throw notBuilt();
    },
    connectionTest: async () => {
      throw notBuilt();
    },
    verifyWebhook: () => false,
    parseWebhook: () => [],
  };
}
