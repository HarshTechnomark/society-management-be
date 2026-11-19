import type { NotificationTemplate } from '../../models';
import { NotificationTemplate as TemplateModel } from '../../models';
import { getLegacyTemplate, type Template } from '../../lib/notify';
import { ERR, LIMITS } from './communication.constants';
import { ensureKey, metaFor, type TemplateMeta } from './communication.registry';
import { NotifyError, escapeHtml, renderChannels, stripTags } from './communication.render';
import type { ChannelTexts, Rendered, VariablesSchema } from './communication.types';

/** In-process template cache (6.5 step 1, 60 s) over `notification_templates`, with the lazy sync of a missing key and the per-channel merge of locales (BR-16-23). */
export interface LoadedTemplate {
  key: string;
  /** Locale actually used (`en-IN` when the requested locale has no active row). */
  locale: string;
  meta: TemplateMeta;
  legacy: Template | null;
  texts: ChannelTexts;
  variables: VariablesSchema;
  /** The en-IN row (metadata of the key, identical on every row). */
  row: NotificationTemplate;
}

interface Entry {
  at: number;
  rows: NotificationTemplate[];
}
const cache = new Map<string, Entry>();
export const dropTemplateCache = (): void => cache.clear();

async function rowsOf(key: string): Promise<NotificationTemplate[]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < LIMITS.templateCacheSeconds * 1000) return hit.rows;
  let rows = await TemplateModel.findAll({ where: { templateKey: key } });
  if (!rows.some(r => r.locale === 'en-IN') && (await ensureKey(key)))
    rows = await TemplateModel.findAll({ where: { templateKey: key } });
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

/** Channel groups come from the requested locale row when it has the group's main text, else from en-IN (a DLT id belongs to its text). */
function mergeTexts(en: NotificationTemplate, loc: NotificationTemplate | undefined): ChannelTexts {
  const g = (
    group: (r: NotificationTemplate) => Record<string, unknown>,
    main: keyof NotificationTemplate,
  ) => {
    const src = loc && loc[main] ? loc : en;
    return group(src);
  };
  const out = {
    ...g(r => ({ inAppTitle: r.inAppTitle, inAppBody: r.inAppBody }), 'inAppTitle'),
    ...g(r => ({ pushTitle: r.pushTitle, pushBody: r.pushBody }), 'pushTitle'),
    ...g(
      r => ({ smsBody: r.smsBody, smsDltTemplateId: r.smsDltTemplateId, smsDltCategory: r.smsDltCategory }),
      'smsBody',
    ),
    ...g(
      r => ({
        whatsappTemplateName: r.whatsappTemplateName,
        whatsappCategory: r.whatsappCategory,
        whatsappParams: r.whatsappParams,
        whatsappButtonVar: r.whatsappButtonVar,
        whatsappStatus: r.whatsappStatus,
      }),
      'whatsappTemplateName',
    ),
    ...g(
      r => ({ emailSubject: r.emailSubject, emailHtml: r.emailHtml, emailText: r.emailText }),
      'emailSubject',
    ),
  };
  for (const k of Object.keys(out))
    if ((out as Record<string, unknown>)[k] === null) delete (out as Record<string, unknown>)[k];
  return out as ChannelTexts;
}

/** 6.5 step 1: the active template of a key for a locale. Throws `TEMPLATE_NOT_FOUND` when unknown or inactive. */
export async function getTemplate(key: string, locale = 'en-IN'): Promise<LoadedTemplate> {
  const rows = await rowsOf(key);
  const en = rows.find(r => r.locale === 'en-IN');
  const meta = metaFor(key);
  if (!en || !en.isActive || !meta)
    throw new NotifyError(ERR.templateNotFound, `Template "${key}" is unknown or inactive`, 404);
  const loc = locale !== 'en-IN' ? rows.find(r => r.locale === locale && r.isActive) : undefined;
  return {
    key,
    locale: loc ? locale : 'en-IN',
    meta,
    legacy: getLegacyTemplate(key) ?? null,
    texts: mergeTexts(en, loc),
    variables: en.variablesSchema ?? {},
    row: en,
  };
}

const firstUrl = (s: string | undefined) => s?.match(/https?:\/\/\S+/)?.[0] ?? null;
const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

/** Renders every channel the template has text for. Legacy templates use their own `render()` (preserved stand-in text). */
export function renderTemplate(
  t: LoadedTemplate,
  data: Record<string, unknown>,
  o: { tz?: string } = {},
): Rendered {
  if (t.legacy) {
    const msg = t.legacy.render(data);
    // the bare "Open it: /path" line is the e-mail's call to action; the inbox item has the deep link instead
    const body = (msg.email?.text ?? msg.sms ?? '').replace(/\n?[A-Za-z ]+: \/\S+\s*$/, '');
    const title = msg.email?.subject ?? cut(msg.sms ?? t.key, 60);
    const link = msg.link ?? firstUrl(msg.sms) ?? firstUrl(msg.email?.text);
    return {
      inApp: { title: cut(title, 150), body: cut(body, 1000) },
      push: { title: cut(title, 80), body: cut(body, LIMITS.pushBodyMax) },
      ...(msg.sms ? { sms: msg.sms } : {}),
      ...(msg.whatsappParams || msg.sms
        ? { whatsapp: { name: t.key, params: msg.whatsappParams ?? [msg.sms ?? ''] } }
        : {}),
      ...(msg.email
        ? {
            email: {
              subject: msg.email.subject,
              html: msg.email.html ?? `<p>${escapeHtml(msg.email.text).replace(/\n/g, '<br>')}</p>`,
              text: msg.email.html ? stripTags(msg.email.html) : msg.email.text,
            },
          }
        : {}),
      deepLink: link && link.startsWith('/') ? link : null,
    };
  }
  return renderChannels(t.texts, t.variables, data, { tz: o.tz, deepLink: t.meta.deepLink });
}
