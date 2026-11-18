import { adapters } from '../adapters';
import { logger } from './logger';

/**
 * Entry point every module uses: `notify(templateKey, recipients, data, options)` (module 02 section 10).
 * Module 16 installs the REAL engine with `setNotifyEngine()` (`registerCommunication()`): preferences, quiet hours, inbox items, delivery rows,
 * retries. Without an engine (unit tests of other modules) the original stand-in below renders the registered template and sends through the module 01
 * adapters. The stand-in never throws: a failed send is logged, so a notification problem cannot undo the action it reports.
 * The in-code `Template` objects registered here are the LEGACY templates: the real engine keeps their `render()` and mirrors them into
 * `notification_templates` (see `communication.registry.ts`).
 */
export type NotifyChannel = 'SMS' | 'WHATSAPP' | 'EMAIL' | 'PUSH';
export interface Recipient {
  userId?: number;
  mobile?: string | null;
  email?: string | null;
}
export interface NotifyOptions {
  channel?: 'SMS' | 'WHATSAPP';
  locale?: string;
  /** Restricts delivery to these channels (module 07 announcements); omitted = every channel of the template. */
  channels?: NotifyChannel[];
}
export interface RenderedMessage {
  sms?: string;
  email?: { subject: string; text: string; html?: string };
  whatsappParams?: string[];
  link?: string;
}
export interface Template {
  channels: NotifyChannel[];
  critical: boolean;
  render(data: Record<string, any>): RenderedMessage;
}

const templates = new Map<string, Template>();
export const registerTemplates = (t: Record<string, Template>): void => {
  for (const [k, v] of Object.entries(t)) templates.set(k, v);
};

export const hasTemplate = (key: string): boolean => templates.has(key);
/** Read access for module 16 (legacy bridge). */
export const getLegacyTemplate = (key: string): Template | undefined => templates.get(key);
export const legacyTemplateKeys = (): string[] => [...templates.keys()];

export type NotifyEngine = (
  templateKey: string,
  recipients: Recipient[],
  data: Record<string, any>,
  options: NotifyOptions,
) => Promise<unknown>;
let engine: NotifyEngine | undefined;
/** Installs (or removes with `undefined`) the real notification engine of module 16. */
export const setNotifyEngine = (e: NotifyEngine | undefined): void => {
  engine = e;
};
export const hasNotifyEngine = (): boolean => engine !== undefined;

type ContactResolver = (userId: number) => Promise<{ mobile: string | null; email: string | null } | null>;
let resolver: ContactResolver | undefined;
export const setContactResolver = (r: ContactResolver): void => {
  resolver = r;
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export async function notify(
  templateKey: string,
  recipients: Recipient[],
  data: Record<string, any> = {},
  options: NotifyOptions = {},
): Promise<void> {
  if (engine) {
    try {
      await engine(templateKey, recipients, data, options);
    } catch (err) {
      logger.error({ err, templateKey }, 'notify: engine failed');
    }
    return;
  }
  const tpl = templates.get(templateKey);
  if (!tpl) {
    logger.warn({ templateKey }, 'notify: unknown template');
    return;
  }
  const msg = tpl.render(data);
  for (const r of recipients) {
    try {
      let { mobile, email } = r;
      if (r.userId !== undefined && resolver) {
        const c = await resolver(r.userId);
        mobile = mobile ?? c?.mobile ?? null;
        email = email ?? c?.email ?? null;
      }
      const a = adapters();
      const wants = (c: NotifyChannel) =>
        tpl.channels.includes(c) && (!options.channels || options.channels.includes(c));
      if (wants('SMS') && mobile && msg.sms) {
        if (options.channel === 'WHATSAPP' && templateKey === 'auth.otp')
          await a.whatsapp.sendTemplate(
            mobile,
            templateKey,
            options.locale ?? 'en',
            msg.whatsappParams ?? [msg.sms],
          );
        else await a.sms.send(mobile, templateKey, msg.sms);
      }
      if (wants('EMAIL') && email && msg.email)
        await a.email.send(
          email,
          msg.email.subject,
          msg.email.html ?? `<p>${escapeHtml(msg.email.text).replace(/\n/g, '<br>')}</p>`,
          msg.email.text,
        );
    } catch (err) {
      logger.error({ err, templateKey }, 'notify: send failed');
    }
  }
}
