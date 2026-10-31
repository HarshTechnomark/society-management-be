import { randomBytes } from 'node:crypto';
import { recordInbox } from '../../lib/inbox';

export interface WhatsAppSender {
  sendTemplate(
    to: string,
    template: string,
    lang: string,
    params: string[],
    buttons?: { url: string }[],
  ): Promise<{ providerId: string }>;
}

export class FakeWhatsAppSender implements WhatsAppSender {
  async sendTemplate(
    to: string,
    template: string,
    lang: string,
    params: string[],
    buttons?: { url: string }[],
  ) {
    await recordInbox({
      channel: 'WHATSAPP',
      to,
      subject: null,
      body: `[${template}/${lang}] ${params.join(' | ')}`,
      link: buttons?.[0]?.url ?? null,
      templateKey: template,
    });
    return { providerId: `fake_${randomBytes(4).toString('hex')}` };
  }
}
