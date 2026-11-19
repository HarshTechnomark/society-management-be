import { z } from 'zod';
import {
  LIMITS,
  QUESTION_TYPES,
  RESPONSE_SCOPES,
  RESULTS_VISIBILITIES,
  SURVEY_AUDIENCE_TYPES,
  SURVEY_STATUSES,
  AUDIENCE_RELATIONS,
} from './communication.constants';

/** Zod schemas of sections 8.31 to 8.34 (strict). Question shapes follow BR-16-45 and 7.11. */
const id = z
  .string()
  .regex(/^[1-9]\d{0,18}$/, 'Not a valid id')
  .transform(Number);
const version = z.number().int().min(1);
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
// eslint-disable-next-line no-control-regex
const NO_CONTROL = /^[^\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/;
const isoDate = z
  .string()
  .datetime({ offset: true })
  .transform(v => new Date(v));

const option = z
  .object({ key: z.string().regex(/^o[0-9]{1,2}$/, 'Use o1, o2, ...'), label: text(1, 100) })
  .strict();

export const questionSchema = z
  .object({
    type: z.enum(QUESTION_TYPES),
    prompt: text(3, 300).regex(NO_CONTROL, 'No control characters'),
    helpText: text(1, 300).nullish(),
    isRequired: z.boolean().optional(),
    options: z.array(option).min(LIMITS.surveyOptionsMin).max(LIMITS.surveyOptionsMax).nullish(),
    maxSelections: z.number().int().min(1).nullish(),
    minValue: z.number().int().min(-1_000_000).max(1_000_000).nullish(),
    maxValue: z.number().int().min(-1_000_000).max(1_000_000).nullish(),
    maxLength: z.number().int().min(1).max(1000).nullish(),
  })
  .strict()
  .superRefine((q, c) => {
    const bad = (path: string, message: string) => c.addIssue({ code: 'custom', path: [path], message });
    const choice = q.type === 'SINGLE_CHOICE' || q.type === 'MULTI_CHOICE';
    if (choice) {
      if (!q.options) return bad('options', 'Choice questions need 2 to 20 options');
      if (new Set(q.options.map(o => o.key)).size !== q.options.length)
        bad('options', 'Option keys must be unique');
      if (new Set(q.options.map(o => o.label.toLowerCase())).size !== q.options.length)
        bad('options', 'Option labels must be unique');
    } else if (q.options) bad('options', 'Only choice questions take options');
    if (q.type === 'MULTI_CHOICE') {
      if (q.maxSelections && q.options && q.maxSelections > q.options.length)
        bad('maxSelections', 'More than the number of options');
    } else if (q.maxSelections) bad('maxSelections', 'Only multiple-choice questions take maxSelections');
    if (q.type === 'NUMBER') {
      if (q.minValue === undefined || q.minValue === null) bad('minValue', 'Number questions need minValue');
      if (q.maxValue === undefined || q.maxValue === null) bad('maxValue', 'Number questions need maxValue');
      if (q.minValue != null && q.maxValue != null && q.maxValue <= q.minValue)
        bad('maxValue', 'maxValue must be greater than minValue');
    } else {
      if (q.minValue != null) bad('minValue', 'Only number questions take minValue');
      if (q.maxValue != null) bad('maxValue', 'Only number questions take maxValue');
    }
    if (q.type !== 'TEXT' && q.maxLength != null) bad('maxLength', 'Only text questions take maxLength');
  });

const audience = z
  .object({
    type: z.enum(SURVEY_AUDIENCE_TYPES),
    relation: z.enum(AUDIENCE_RELATIONS).optional(),
    ids: z.array(z.number().int().positive()).max(LIMITS.audienceUnitsMax).optional(),
  })
  .strict()
  .superRefine((a, c) => {
    if (a.type === 'ALL') {
      if (a.ids?.length) c.addIssue({ code: 'custom', path: ['ids'], message: 'ALL takes no ids' });
      return;
    }
    const max = a.type === 'BUILDINGS' ? LIMITS.audienceBuildingsMax : LIMITS.audienceUnitsMax;
    if (!a.ids?.length || a.ids.length > max)
      c.addIssue({ code: 'custom', path: ['ids'], message: `Choose 1 to ${max}` });
  });

const fields = {
  description: z.string().max(2000).nullish(),
  isAnonymous: z.boolean().optional(),
  responseScope: z.enum(RESPONSE_SCOPES).optional(),
  resultsVisibility: z.enum(RESULTS_VISIBILITIES).optional(),
  audience: audience.optional(),
  closesAt: isoDate.nullish(),
  questions: z.array(questionSchema).max(LIMITS.surveyQuestionsMax).optional(),
};
const title = text(LIMITS.titleMin, LIMITS.titleMax).regex(NO_CONTROL, 'No control characters');

const answer = z
  .object({
    questionId: z.number().int().positive(),
    optionKey: z
      .string()
      .regex(/^(o[0-9]{1,2}|yes|no)$/)
      .optional(),
    optionKeys: z
      .array(z.string().regex(/^o[0-9]{1,2}$/))
      .min(1)
      .max(LIMITS.surveyOptionsMax)
      .optional(),
    number: z.number().int().optional(),
    text: z.string().max(1000).optional(),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();

export const surveySchemas = {
  idParam: z.object({ id }).strict(),
  list: z
    .object({
      status: z.enum(SURVEY_STATUSES).optional(),
      q: z.string().trim().min(2).max(60).optional(),
      sortBy: z.enum(['createdAt', 'closesAt', 'responseCount']).default('createdAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .strict(),
  create: z.object({ title, ...fields }).strict(),
  patch: z.object({ version, title: title.optional(), ...fields }).strict(),
  remove: z.object({ version: z.coerce.number().int().min(1) }).strict(),
  publish: z.object({ version, closesAt: isoDate.optional() }).strict(),
  close: z.object({ version }).strict(),
  cancel: z.object({ version, reason: text(LIMITS.surveyCancelMin, LIMITS.surveyCancelMax) }).strict(),
  respond: z
    .object({
      unitId: z.number().int().positive().optional(),
      answers: z.array(answer).min(1).max(LIMITS.surveyQuestionsMax),
    })
    .strict(),
};
