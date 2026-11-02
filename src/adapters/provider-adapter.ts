import { randomBytes } from 'node:crypto';
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
  };
}
