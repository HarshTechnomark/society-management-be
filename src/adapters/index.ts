import { env } from '../lib/env';
import { FakeSmsSender, type SmsSender } from './sms/sms';
import { FakeWhatsAppSender, type WhatsAppSender } from './whatsapp/whatsapp';
import { FakeEmailSender, type EmailSender } from './email/email';

export interface Adapters {
  sms: SmsSender;
  whatsapp: WhatsAppSender;
  email: EmailSender;
}

let current: Adapters | undefined;

/**
 * Adapter set chosen by PROVIDERS_MODE (BR-01-17). Only the fake implementations ship in this build; the real
 * providers are wired in by module 16 and fail loudly here so nobody believes a message was sent.
 */
export function adapters(): Adapters {
  if (!current) {
    if (env().PROVIDERS_MODE !== 'fake')
      throw new Error('Real SMS, WhatsApp and email providers are not built yet');
    current = { sms: new FakeSmsSender(), whatsapp: new FakeWhatsAppSender(), email: new FakeEmailSender() };
  }
  return current;
}

/** Test helper. */
export function setAdapters(a: Adapters | undefined): void {
  current = a;
}
