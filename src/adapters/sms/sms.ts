import { recordInbox } from '../../lib/inbox';
import { randomBytes } from 'node:crypto';

/** Module 01 section 10. */
export interface SmsSender {
  send(to: string, templateId: string, text: string): Promise<{ providerId: string }>;
}

/** Records the message in the dev inbox instead of sending it. */
export class FakeSmsSender implements SmsSender {
  async send(to: string, templateId: string, text: string) {
    await recordInbox({ channel: 'SMS', to, subject: null, body: text, templateKey: templateId });
    return { providerId: `fake_${randomBytes(4).toString('hex')}` };
  }
}
