import { EventEmitter } from 'node:events';
import { Op, literal, type WhereOptions } from 'sequelize';
import { NotificationTemplate, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, NotFoundError, UnprocessableError, type FieldError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { AUDIT, BUS, ENTITY, ERR, LIMITS } from './communication.constants';
import { metaFor } from './communication.registry';
import { placeholdersOf, renderChannels, smsSegments } from './communication.render';
import { dropTemplateCache, getTemplate, renderTemplate } from './communication.templates';
import type { ChannelTexts, VariablesSchema } from './communication.types';

/** 8.35 platform template registry: list, read, edit (text, DLT, WhatsApp) and preview. Code owns metadata, the editor owns text (BR-16-50). */

/** In-process bus (`communication:templates-changed`, 9.4): every cache listens. A multi-process deployment forwards it over Redis. */
export const communicationEvents = new EventEmitter();
communicationEvents.on(BUS.templatesChanged, () => dropTemplateCache());

const TEXT_FIELDS = [
  'inAppTitle',
  'inAppBody',
  'pushTitle',
  'pushBody',
  'smsBody',
  'emailSubject',
  'emailHtml',
  'emailText',
] as const;
const META_FIELDS = [
  'smsDltTemplateId',
  'smsDltCategory',
  'whatsappTemplateName',
  'whatsappCategory',
  'whatsappStatus',
  'whatsappParams',
] as const;

export interface TemplateListQuery {
  module?: string;
  category?: string;
  deliveryClass?: string;
  locale?: string;
  q?: string;
  missing?: 'SMS_DLT' | 'WHATSAPP' | 'LOCALE';
  page: number;
  limit: number;
  sortBy: 'templateKey';
  sortOrder: 'asc' | 'desc';
}

const isLegacy = (key: string): boolean => metaFor(key)?.legacy != null;

const listItem = (r: NotificationTemplate) => ({
  id: r.id,
  templateKey: r.templateKey,
  locale: r.locale,
  module: r.module,
  category: r.category,
  deliveryClass: r.deliveryClass,
  defaultChannels: r.defaultChannels,
  smsDltTemplateId: r.smsDltTemplateId,
  whatsappTemplateName: r.whatsappTemplateName,
  whatsappStatus: r.whatsappStatus,
  isActive: r.isActive,
  textEditedAt: r.textEditedAt,
  version: r.version,
  legacy: isLegacy(r.templateKey),
});

export async function listTemplates(q: TemplateListQuery) {
  const and: WhereOptions[] = [];
  if (q.module) and.push({ module: q.module });
  if (q.category) and.push({ category: q.category });
  if (q.deliveryClass) and.push({ deliveryClass: q.deliveryClass });
  if (q.q) and.push({ templateKey: { [Op.like]: `${q.q.replace(/[%_\\]/g, m => `\\${m}`)}%` } });
  if (q.missing === 'SMS_DLT')
    and.push(literal(`JSON_CONTAINS(allowedChannels, '"SMS"')`), { smsDltTemplateId: null });
  else if (q.missing === 'WHATSAPP')
    and.push(literal(`JSON_CONTAINS(allowedChannels, '"WHATSAPP"')`), {
      [Op.or]: [
        { whatsappTemplateName: null },
        { whatsappStatus: { [Op.ne]: 'APPROVED' } },
        { whatsappStatus: null },
      ],
    });
  else if (q.missing === 'LOCALE') {
    const target = q.locale && q.locale !== 'en-IN' ? q.locale : 'hi-IN';
    and.push(
      { locale: 'en-IN' },
      literal(
        `NOT EXISTS (SELECT 1 FROM notification_templates t2 WHERE t2.templateKey = NotificationTemplate.templateKey AND t2.locale = ${sequelize.escape(target)})`,
      ),
    );
  }
  if (q.locale && q.missing !== 'LOCALE') and.push({ locale: q.locale });
  const where = and.length ? { [Op.and]: and } : {};
  const { rows, count } = await NotificationTemplate.findAndCountAll({
    where,
    order: [
      ['templateKey', q.sortOrder.toUpperCase()],
      ['locale', 'ASC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { data: rows.map(listItem), pagination: pageMeta(q.page, q.limit, count) };
}

const must = async (id: number): Promise<NotificationTemplate> => {
  const r = await NotificationTemplate.findByPk(id);
  if (!r) throw new NotFoundError(ERR.templateNotFound, 'Template not found');
  return r;
};

/** The full row incl. `variablesSchema`, `allowedChannels` and the sample data the preview uses. */
export async function getTemplateRow(id: number) {
  const r = await must(id);
  return { ...r.toJSON(), legacy: isLegacy(r.templateKey), sample: sampleFor(r) };
}

// ------------------------------------------------------------------ sample data and rendering
const SAMPLE_BY_TYPE: Record<string, unknown> = {
  string: 'Sample',
  number: 1,
  money: 125000,
  date: '2026-12-01',
  datetime: '2026-12-01T04:30:00.000Z',
  url: 'https://app.societyapp.in/x',
};
function sampleFor(r: NotificationTemplate): Record<string, unknown> {
  const fromCode = metaFor(r.templateKey)?.sample ?? {};
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries((r.variablesSchema ?? {}) as VariablesSchema))
    out[name] = fromCode[name] ?? SAMPLE_BY_TYPE[spec.type] ?? 'Sample';
  return { ...out, ...fromCode };
}

const textsOf = (r: NotificationTemplate, patch: Partial<Record<string, unknown>> = {}): ChannelTexts => {
  const merged: Record<string, unknown> = {};
  for (const k of [
    ...TEXT_FIELDS,
    'smsDltTemplateId',
    'smsDltCategory',
    'whatsappTemplateName',
    'whatsappCategory',
    'whatsappParams',
    'whatsappButtonVar',
    'whatsappStatus',
  ] as const) {
    const v = k in patch ? patch[k] : (r as unknown as Record<string, unknown>)[k];
    if (v !== null && v !== undefined) merged[k] = v;
  }
  return merged as ChannelTexts;
};

export interface PreviewResult {
  inApp: { title: string; body: string } | null;
  push: { title: string; body: string } | null;
  sms: { text: string; segments: number; encoding: string } | null;
  whatsapp: { name: string; params: string[] } | null;
  email: { subject: string; html: string; text: string } | null;
}

function renderAll(
  r: NotificationTemplate,
  texts: ChannelTexts,
  data: Record<string, unknown>,
): PreviewResult {
  const rendered = renderChannels(texts, (r.variablesSchema ?? {}) as VariablesSchema, data, {
    deepLink: r.deepLink,
  });
  const sms = rendered.sms ?? null;
  return {
    inApp: rendered.inApp ?? null,
    push: rendered.push ?? null,
    sms:
      sms === null
        ? null
        : { text: sms, ...(({ segments, encoding }) => ({ segments, encoding }))(smsSegments(sms)) },
    whatsapp: rendered.whatsapp ? { name: rendered.whatsapp.name, params: rendered.whatsapp.params } : null,
    email: rendered.email ?? null,
  };
}

export async function previewTemplate(id: number, data?: Record<string, unknown>): Promise<PreviewResult> {
  const r = await must(id);
  if (isLegacy(r.templateKey)) {
    // legacy stand-in template: its own render() with whatever data was given
    const loaded = await getTemplate(r.templateKey, r.locale);
    const out = renderTemplate(loaded, { ...sampleFor(r), ...(data ?? {}) });
    return {
      inApp: out.inApp ?? null,
      push: out.push ?? null,
      sms: out.sms
        ? { text: out.sms, ...(({ segments, encoding }) => ({ segments, encoding }))(smsSegments(out.sms)) }
        : null,
      whatsapp: out.whatsapp ? { name: out.whatsapp.name, params: out.whatsapp.params } : null,
      email: out.email ?? null,
    };
  }
  try {
    return renderAll(r, textsOf(r), { ...sampleFor(r), ...(data ?? {}) });
  } catch (err) {
    throw new UnprocessableError(
      ERR.templateInvalid,
      `The template does not render: ${(err as Error).message}`,
    );
  }
}

// ------------------------------------------------------------------ e-mail HTML sanitiser
/** Removes active content from the e-mail HTML (scripts, frames, forms, event handlers, `javascript:` URLs). Placeholders pass through. */
export function sanitizeEmailHtml(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(
      /<\s*(script|style|iframe|object|embed|form|link|meta|base|svg|math)\b[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi,
      '',
    )
    .replace(
      /<\s*\/?\s*(script|style|iframe|object|embed|form|input|button|textarea|select|link|meta|base|svg|math)\b[^>]*>/gi,
      '',
    )
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(
      /\s(href|src|action|formaction|xlink:href)\s*=\s*("\s*(javascript|data|vbscript):[^"]*"|'\s*(javascript|data|vbscript):[^']*')/gi,
      ' $1="#"',
    );
}

// ------------------------------------------------------------------ edit
export interface TemplatePatch {
  version: number;
  inAppTitle?: string | null;
  inAppBody?: string | null;
  pushTitle?: string | null;
  pushBody?: string | null;
  smsBody?: string | null;
  emailSubject?: string | null;
  emailHtml?: string | null;
  emailText?: string | null;
  smsDltTemplateId?: string | null;
  smsDltCategory?: string | null;
  whatsappTemplateName?: string | null;
  whatsappCategory?: string | null;
  whatsappStatus?: string | null;
  whatsappParams?: string[] | null;
  isActive?: boolean;
}

const bad = (message: string, errors?: FieldError[]) =>
  new UnprocessableError(ERR.templateInvalid, message, errors);

export async function updateTemplate(ctx: Ctx, id: number, patch: TemplatePatch) {
  const result = await sequelize.transaction(async t => {
    const row = await NotificationTemplate.findByPk(id, { transaction: t, lock: t.LOCK.UPDATE });
    if (!row) throw new NotFoundError(ERR.templateNotFound, 'Template not found');
    if (row.version !== patch.version)
      throw new AppError(
        409,
        ERR.staleVersion,
        'This template changed since you opened it. Reload and try again.',
      );
    const schema = (row.variablesSchema ?? {}) as VariablesSchema;
    const set: Record<string, unknown> = {};
    for (const k of [...TEXT_FIELDS, ...META_FIELDS, 'isActive'] as const) {
      const v = (patch as unknown as Record<string, unknown>)[k];
      if (v !== undefined) set[k] = v;
    }
    const textKeys = Object.keys(set).filter(k => (TEXT_FIELDS as readonly string[]).includes(k));
    if (isLegacy(row.templateKey) && textKeys.length)
      throw bad(
        'This template is still written in code and its text is read-only',
        textKeys.map(f => ({ field: f, message: 'Read-only legacy template' })),
      );
    if (typeof set.emailHtml === 'string') set.emailHtml = sanitizeEmailHtml(set.emailHtml);

    const errors: FieldError[] = [];
    for (const k of TEXT_FIELDS) {
      const v = set[k];
      if (typeof v !== 'string') continue;
      const unknown = placeholdersOf(v).filter(n => !(n in schema));
      if (unknown.length) errors.push({ field: k, message: `Unknown placeholder: ${unknown.join(', ')}` });
    }
    const params = set.whatsappParams as string[] | null | undefined;
    if (params)
      for (const p of params)
        if (!(p in schema)) errors.push({ field: 'whatsappParams', message: `Unknown variable: ${p}` });
    if (set.isActive === false && row.locale === 'en-IN')
      errors.push({ field: 'isActive', message: 'The en-IN row cannot be deactivated' });
    if (errors.length) throw bad('The template is not valid', errors);

    // DLT: a changed SMS text needs the new registered id (BR-16-29 / 8.35)
    if (
      typeof set.smsBody === 'string' &&
      set.smsBody !== row.smsBody &&
      row.smsDltTemplateId !== null &&
      (set.smsDltTemplateId === undefined || set.smsDltTemplateId === row.smsDltTemplateId)
    )
      throw new UnprocessableError(
        ERR.templateDltRequired,
        'Register the new SMS text with the DLT operator and send the new template id',
        [
          {
            field: 'smsDltTemplateId',
            message: 'A new DLT template id is required when the SMS text changes',
          },
        ],
      );

    // a test render of every channel with the sample values must pass
    if (textKeys.length) {
      let out: PreviewResult;
      try {
        out = renderAll(row, textsOf(row, set), sampleFor(row));
      } catch (err) {
        throw bad(`The template does not render: ${(err as Error).message}`);
      }
      if (out.sms && out.sms.segments > LIMITS.smsMaxSegments)
        throw bad(`The SMS is ${out.sms.segments} segments long; the limit is ${LIMITS.smsMaxSegments}`, [
          { field: 'smsBody', message: 'Too long for 2 SMS segments' },
        ]);
    }

    const changed = Object.keys(set).filter(
      k =>
        JSON.stringify((row as unknown as Record<string, unknown>)[k] ?? null) !==
        JSON.stringify(set[k] ?? null),
    );
    if (!changed.length) return { row, changed };
    const editedText = changed.some(k => k !== 'isActive');
    await row.update(
      {
        ...set,
        ...(editedText ? { textEditedAt: now() } : {}),
        version: row.version + 1,
        updatedBy: ctx.user?.id ?? null,
      } as never,
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.templateUpdated,
        entityType: ENTITY.template,
        entityId: row.id,
        entityLabel: `${row.templateKey} ${row.locale}`,
        // never the text itself, only which fields changed and their lengths
        after: {
          version: row.version,
          fields: changed,
          lengths: Object.fromEntries(
            changed.filter(k => typeof set[k] === 'string').map(k => [k, (set[k] as string).length]),
          ),
        },
      },
      t,
    );
    t.afterCommit(() => {
      communicationEvents.emit(BUS.templatesChanged, { templateKey: row.templateKey });
    });
    return { row, changed };
  });
  return { ...result.row.toJSON(), legacy: isLegacy(result.row.templateKey), sample: sampleFor(result.row) };
}
