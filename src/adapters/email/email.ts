import { randomBytes } from 'node:crypto';
import { recordInbox } from '../../lib/inbox';

export interface EmailSender {
  send(to: string, subject: string, html: string, text: string): Promise<{ providerId: string }>;
}

export class FakeEmailSender implements EmailSender {
  async send(to: string, subject: string, _html: string, text: string) {
    await recordInbox({ channel: 'EMAIL', to, subject, body: text, templateKey: null });
    return { providerId: `fake_${randomBytes(4).toString('hex')}` };
  }
}
