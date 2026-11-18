import { AppError } from '../../utils/errors';
import { ERR, LIMITS } from './communication.constants';
import type { Rendered, ChannelTexts, VariablesSchema } from './communication.types';

/**
 * PURE rendering of section 5.6 and BR-16-18 / 29 / 30 / 51: `{{name}}` placeholders, money in rupees with Indian grouping, dates as
 * `DD MMM YYYY` in the society time zone, SMS segment counting, push and SMS length rules. No database.
 */
export class NotifyError extends AppError {
  constructor(code: string, message: string, status = 500) {
    super(status, code, message);
  }
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
export const placeholdersOf = (text: string): string[] => [
  ...new Set([...text.matchAll(PLACEHOLDER)].map(m => m[1]!)),
];
/** BR-16-51: every placeholder of `text` must exist in the schema; returns the unknown names. */
export const unknownPlaceholders = (text: string, schema: VariablesSchema): string[] =>
  placeholdersOf(text).filter(n => !(n in schema));

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 12500000 paise -> `₹1,25,000`; paise are shown only when not whole rupees (BR-16-51). */
export function formatMoney(paise: number): string {
  const neg = paise < 0;
  const abs = Math.abs(Math.round(paise));
  const rupees = Math.floor(abs / 100);
  const rest = abs % 100;
  const s = String(rupees);
  const grouped =
    s.length <= 3 ? s : s.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + s.slice(-3);
  return `${neg ? '-' : ''}₹${grouped}${rest ? '.' + String(rest).padStart(2, '0') : ''}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Society-local parts of an instant (Asia/Kolkata and every other IANA zone through Intl). */
function partsIn(d: Date, tz: string) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(d).map(x => [x.type, x.value]));
  return { y: p.year!, m: Number(p.month), d: p.day!, hh: p.hour!, mm: p.minute! };
}
/** `DD MMM YYYY` (a `YYYY-MM-DD` string is printed as is, without a zone shift). */
export function formatDate(v: Date | string, tz = 'Asia/Kolkata'): string {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-');
    return `${d} ${MONTHS[Number(m) - 1]} ${y}`;
  }
  const p = partsIn(v instanceof Date ? v : new Date(v), tz);
  return `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}
export function formatDateTime(v: Date | string, tz = 'Asia/Kolkata'): string {
  const p = partsIn(v instanceof Date ? v : new Date(v), tz);
  return `${p.d} ${MONTHS[p.m - 1]} ${p.y}, ${p.hh}:${p.mm}`;
}

/** BR-16-18: a missing required variable throws `TEMPLATE_VARIABLE_MISSING`; a wrong type or too long a value throws `TEMPLATE_VARIABLE_INVALID`. */
export function validateData(schema: VariablesSchema, data: Record<string, unknown>): void {
  for (const [name, spec] of Object.entries(schema)) {
    const v = data[name];
    if (v === undefined || v === null || v === '') {
      if (spec.required !== false)
        throw new NotifyError(ERR.templateVariableMissing, `Template variable "${name}" is required`);
      continue;
    }
    const bad = (why: string) =>
      new NotifyError(ERR.templateVariableInvalid, `Template variable "${name}" ${why}`);
    switch (spec.type) {
      case 'string':
        if (typeof v !== 'string') throw bad('must be a string');
        if (spec.maxLength && v.length > spec.maxLength) throw bad(`is longer than ${spec.maxLength}`);
        break;
      case 'url':
        if (typeof v !== 'string' || !/^(https?:\/\/|\/)\S*$/.test(v))
          throw bad('must be a URL or an app path');
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) throw bad('must be a number');
        break;
      case 'money':
        if (typeof v !== 'number' || !Number.isInteger(v)) throw bad('must be an integer number of paise');
        break;
      case 'date':
      case 'datetime':
        if (!(v instanceof Date) && (typeof v !== 'string' || Number.isNaN(Date.parse(v))))
          throw bad('must be a date');
        break;
    }
  }
}

/** One value as display text (money, dates by type; BR-16-29: SMS values are cut to 30 characters with an ellipsis). */
export function formatValue(
  spec: VariablesSchema[string] | undefined,
  v: unknown,
  o: { tz?: string; sms?: boolean },
): string {
  let s: string;
  if (v === undefined || v === null) s = '';
  else if (spec?.type === 'money') s = formatMoney(Number(v));
  else if (spec?.type === 'date') s = formatDate(v as Date | string, o.tz);
  else if (spec?.type === 'datetime') s = formatDateTime(v as Date | string, o.tz);
  else s = String(v);
  if (o.sms && s.length > LIMITS.smsVariableMax) s = s.slice(0, LIMITS.smsVariableMax - 1) + '…';
  return s;
}

export function renderText(
  text: string,
  schema: VariablesSchema,
  data: Record<string, unknown>,
  o: { tz?: string; sms?: boolean; html?: boolean } = {},
): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => {
    const s = formatValue(schema[name], data[name], o);
    return o.html ? escapeHtml(s) : s;
  });
}

// ------------------------------------------------------------------ SMS length (BR-16-29)
const GSM7 =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '^{}\\[~]|€\f';
export function smsSegments(text: string): { encoding: 'GSM-7' | 'UCS-2'; length: number; segments: number } {
  let len = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM7.includes(ch)) len += 1;
    else if (GSM7_EXT.includes(ch)) len += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm)
    return {
      encoding: 'GSM-7',
      length: len,
      segments: len <= 160 ? 1 : Math.ceil(len / LIMITS.smsSegmentGsm),
    };
  const u = [...text].length;
  return { encoding: 'UCS-2', length: u, segments: u <= 70 ? 1 : Math.ceil(u / LIMITS.smsSegmentUnicode) };
}
export const smsWithinLimit = (text: string): boolean => smsSegments(text).segments <= LIMITS.smsMaxSegments;

const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + '…');

/** Renders every channel the texts hold (BR-16-30: push body at most 140 characters; inbox title 150, body 1000). */
export function renderChannels(
  texts: ChannelTexts,
  schema: VariablesSchema,
  data: Record<string, unknown>,
  o: { tz?: string; deepLink?: string | null } = {},
): Rendered {
  const r = (t: string, extra: { sms?: boolean; html?: boolean } = {}) =>
    renderText(t, schema, data, { tz: o.tz, ...extra });
  const out: Rendered = {
    deepLink: o.deepLink ? renderText(o.deepLink, schema, data, { tz: o.tz }) : null,
  };
  if (texts.inAppTitle)
    out.inApp = { title: cut(r(texts.inAppTitle), 150), body: cut(r(texts.inAppBody ?? ''), 1000) };
  if (texts.pushTitle)
    out.push = { title: cut(r(texts.pushTitle), 80), body: cut(r(texts.pushBody ?? ''), LIMITS.pushBodyMax) };
  if (texts.smsBody) out.sms = r(texts.smsBody, { sms: true });
  if (texts.whatsappTemplateName)
    out.whatsapp = {
      name: texts.whatsappTemplateName,
      params: (texts.whatsappParams ?? []).map(n => formatValue(schema[n], data[n], { tz: o.tz })),
      buttonSuffix: texts.whatsappButtonVar
        ? formatValue(schema[texts.whatsappButtonVar], data[texts.whatsappButtonVar], {})
        : undefined,
    };
  if (texts.emailSubject)
    out.email = {
      subject: cut(r(texts.emailSubject), 150),
      html: r(texts.emailHtml ?? `<p>${escapeHtml(texts.emailText ?? '')}</p>`, { html: true }),
      text: r(texts.emailText ?? ''),
    };
  return out;
}

/** Strips tags, collapses blanks: a safe plain text of an HTML snippet (used for e-mail text alternatives). */
export const stripTags = (html: string): string =>
  html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|li|h\d|blockquote)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
