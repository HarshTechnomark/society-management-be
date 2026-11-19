import { z } from 'zod';
import {
  CHANNELS,
  DELIVERY_CLASSES,
  DLT_CATEGORIES,
  NOTIFICATION_STATUSES,
  TEMPLATE_CATEGORIES,
  WHATSAPP_CATEGORIES,
  WHATSAPP_STATUSES,
} from './communication.constants';

/** Zod schemas of 8.35 and 8.36 (strict: unknown keys are refused). */
const id = z.coerce.number().int().positive();
const page = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
const sortOrder = z.enum(['asc', 'desc']).default('asc');
const nullable = <T extends z.ZodType>(s: T) => s.nullable().optional();

export const platformSchemas = {
  idParam: z.object({ id }).strict(),
  templateList: z
    .object({
      module: z
        .string()
        .regex(/^\d{2}$/)
        .optional(),
      category: z.enum(TEMPLATE_CATEGORIES).optional(),
      deliveryClass: z.enum(DELIVERY_CLASSES).optional(),
      locale: z
        .string()
        .regex(/^[a-z]{2}-[A-Z]{2}$/)
        .optional(),
      q: z.string().trim().min(2).max(80).optional(),
      missing: z.enum(['SMS_DLT', 'WHATSAPP', 'LOCALE']).optional(),
      ...page,
      sortBy: z.enum(['templateKey']).default('templateKey'),
      sortOrder,
    })
    .strict(),
  templatePatch: z
    .object({
      version: z.number().int().positive(),
      inAppTitle: nullable(z.string().max(150)),
      inAppBody: nullable(z.string().max(1000)),
      pushTitle: nullable(z.string().max(80)),
      pushBody: nullable(z.string().max(200)),
      smsBody: nullable(z.string().max(500)),
      emailSubject: nullable(z.string().max(150)),
      emailHtml: nullable(z.string().max(200_000)),
      emailText: nullable(z.string().max(20_000)),
      smsDltTemplateId: nullable(z.string().regex(/^\d{12,20}$/, 'Use the 12 to 20 digit DLT template id')),
      smsDltCategory: nullable(z.enum(DLT_CATEGORIES)),
      whatsappTemplateName: nullable(
        z.string().regex(/^[a-z0-9_]{1,60}$/, 'Use lower-case letters, digits and underscores'),
      ),
      whatsappCategory: nullable(z.enum(WHATSAPP_CATEGORIES)),
      whatsappStatus: nullable(z.enum(WHATSAPP_STATUSES)),
      whatsappParams: nullable(z.array(z.string().min(1).max(40)).max(10)),
      isActive: z.boolean().optional(),
    })
    .strict(),
  preview: z.object({ data: z.record(z.string(), z.unknown()).optional() }).strict(),
  deliveries: z
    .object({
      societyId: id.optional(),
      channel: z.enum(CHANNELS).optional(),
      status: z.enum(NOTIFICATION_STATUSES).optional(),
      templateKey: z
        .string()
        .regex(/^[a-z_]+\.[a-z0-9_.]+$/)
        .max(80)
        .optional(),
      recipient: z
        .string()
        .trim()
        .refine(
          v => /^\d{10}$/.test(v) || z.string().email().safeParse(v).success,
          'Use a 10-digit mobile number or an e-mail address',
        )
        .optional(),
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/)
        .optional(),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/)
        .optional(),
      ...page,
      sortBy: z.enum(['createdAt']).default('createdAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
    })
    .strict()
    .transform((v, ctx) => {
      const day = /^\d{4}-\d{2}-\d{2}$/;
      const from = v.from ? new Date(day.test(v.from) ? `${v.from}T00:00:00+05:30` : v.from) : undefined;
      // a date-only `to` includes that whole day
      const to = v.to
        ? new Date(day.test(v.to) ? new Date(`${v.to}T00:00:00+05:30`).getTime() + 86_400_000 : v.to)
        : undefined;
      if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) {
        ctx.addIssue({ code: 'custom', path: ['from'], message: 'Not a valid date' });
        return z.NEVER;
      }
      if (from && to && to <= from) {
        ctx.addIssue({ code: 'custom', path: ['to'], message: '`to` must be after `from`' });
        return z.NEVER;
      }
      if (from && to && to.getTime() - from.getTime() > 31 * 86_400_000 + 1) {
        ctx.addIssue({ code: 'custom', path: ['to'], message: 'The range is at most 31 days' });
        return z.NEVER;
      }
      return { ...v, from, to };
    }),
};
