import { QueryTypes } from 'sequelize';
import { Survey, SurveyQuestion, Unit, User, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { units } from '../society-setup/society-setup.public';
import { AUDIT, ENTITY, ERR, LIMITS } from './communication.constants';
import { sNotFound } from './communication.surveys.service';

/** Results aggregation and CSV of a survey (8.33, BR-16-48). Anonymous surveys never expose a person: rows carry no user or flat. */

/** `count x 100 / answered` with one decimal, rounded half-up, as a string (integer arithmetic only). */
export const pct1 = (count: number, answered: number): string =>
  answered === 0 ? '0.0' : (Math.floor((count * 2000 + answered) / (2 * answered)) / 10).toFixed(1);
/** `sum / n` with two decimals, rounded half-up. */
export const avg2 = (sum: number, n: number): string =>
  n === 0 ? '0.00' : (Math.floor((sum * 200 + n) / (2 * n)) / 100).toFixed(2);

export interface QuestionResult {
  questionId: number;
  type: string;
  prompt: string;
  answered: number;
  options?: { key: string; label: string; count: number; pct: string }[];
  average?: string;
  distribution?: Record<string, number>;
  min?: number;
  max?: number;
  nps?: number;
  promoters?: number;
  passives?: number;
  detractors?: number;
  samples?: string[];
  hidden?: boolean;
}
export interface SurveyResults {
  surveyId: number;
  status: string;
  responses: number;
  recipients: number;
  isAnonymous: boolean;
  questions: QuestionResult[];
}

export const assertResultsReadable = (s: Survey): void => {
  if (s.status === 'DRAFT')
    throw new AppError(409, ERR.invalidState, 'A draft survey has no results', [
      { field: 'status', message: s.status },
    ]);
};

export async function surveyResults(s: Survey): Promise<SurveyResults> {
  const qs = await SurveyQuestion.findAll({ where: { surveyId: s.id }, order: [['position', 'ASC']] });
  const q = <T extends object>(sql: string) =>
    sequelize.query<T>(sql, { replacements: { sid: s.id }, type: QueryTypes.SELECT });
  const [answeredRows, optionRows, numberRows] = await Promise.all([
    q<{ questionId: number; n: number }>(
      'SELECT questionId, COUNT(DISTINCT submissionId) AS n FROM survey_responses WHERE surveyId = :sid GROUP BY questionId',
    ),
    q<{ questionId: number; optionKey: string; c: number }>(
      'SELECT questionId, optionKey, COUNT(*) AS c FROM survey_responses WHERE surveyId = :sid AND optionKey IS NOT NULL GROUP BY questionId, optionKey',
    ),
    q<{ questionId: number; numberValue: number; c: number }>(
      'SELECT questionId, numberValue, COUNT(*) AS c FROM survey_responses WHERE surveyId = :sid AND numberValue IS NOT NULL GROUP BY questionId, numberValue',
    ),
  ]);
  const answered = new Map(answeredRows.map(r => [Number(r.questionId), Number(r.n)]));
  const out: QuestionResult[] = [];
  for (const question of qs) {
    const n = answered.get(question.id) ?? 0;
    const base: QuestionResult = {
      questionId: question.id,
      type: question.type,
      prompt: question.prompt,
      answered: n,
    };
    if (question.type === 'SINGLE_CHOICE' || question.type === 'MULTI_CHOICE' || question.type === 'YES_NO') {
      const counts = new Map(
        optionRows.filter(r => Number(r.questionId) === question.id).map(r => [r.optionKey, Number(r.c)]),
      );
      const opts =
        question.type === 'YES_NO'
          ? [
              { key: 'yes', label: 'Yes' },
              { key: 'no', label: 'No' },
            ]
          : (question.options ?? []);
      base.options = opts.map(o => ({
        key: o.key,
        label: o.label,
        count: counts.get(o.key) ?? 0,
        pct: pct1(counts.get(o.key) ?? 0, n),
      }));
    } else if (question.type === 'RATING' || question.type === 'NPS' || question.type === 'NUMBER') {
      const rows = numberRows.filter(r => Number(r.questionId) === question.id);
      const total = rows.reduce((a, r) => a + Number(r.numberValue) * Number(r.c), 0);
      if (question.type === 'RATING') {
        base.average = avg2(total, n);
        base.distribution = Object.fromEntries(
          [1, 2, 3, 4, 5].map(v => [String(v), Number(rows.find(r => Number(r.numberValue) === v)?.c ?? 0)]),
        );
      } else if (question.type === 'NPS') {
        const sum = (f: (v: number) => boolean) =>
          rows.filter(r => f(Number(r.numberValue))).reduce((a, r) => a + Number(r.c), 0);
        const promoters = sum(v => v >= 9);
        const passives = sum(v => v >= 7 && v <= 8);
        const detractors = sum(v => v <= 6);
        Object.assign(base, {
          nps: n === 0 ? 0 : Math.round(((promoters - detractors) * 100) / n),
          promoters,
          passives,
          detractors,
        });
      } else {
        base.average = avg2(total, n);
        if (rows.length) {
          base.min = Math.min(...rows.map(r => Number(r.numberValue)));
          base.max = Math.max(...rows.map(r => Number(r.numberValue)));
        }
      }
    } else if (question.type === 'TEXT') {
      const hidden = s.isAnonymous && s.responseCount < LIMITS.surveyAnonTextMin;
      base.hidden = hidden;
      base.samples = hidden
        ? []
        : (
            await sequelize.query<{ textValue: string }>(
              'SELECT textValue FROM survey_responses WHERE surveyId = :sid AND questionId = :qid AND textValue IS NOT NULL ORDER BY id DESC LIMIT 50',
              { replacements: { sid: s.id, qid: question.id }, type: QueryTypes.SELECT },
            )
          ).map(r => r.textValue);
    }
    out.push(base);
  }
  return {
    surveyId: s.id,
    status: s.status,
    responses: s.responseCount,
    recipients: s.recipientCount,
    isAnonymous: s.isAnonymous,
    questions: out,
  };
}

export async function getResults(ctx: Ctx, id: number): Promise<SurveyResults> {
  const s = await Survey.findOne({ where: { id, societyId: ctx.society!.id } });
  if (!s) throw sNotFound();
  assertResultsReadable(s);
  return surveyResults(s);
}

const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per submission. Anonymous: no name, no flat, time to the hour, submissions in random (uuid) order. Named: name and flat. */
export async function exportResults(
  ctx: Ctx,
  id: number,
): Promise<{ csv: string; filename: string; rows: number }> {
  const societyId = ctx.society!.id;
  const s = await Survey.findOne({ where: { id, societyId } });
  if (!s) throw sNotFound();
  assertResultsReadable(s);
  const qs = await SurveyQuestion.findAll({ where: { surveyId: id }, order: [['position', 'ASC']] });
  const rows = await sequelize.query<{
    submissionId: string;
    questionId: number;
    userId: number | null;
    unitId: number | null;
    optionKey: string | null;
    numberValue: number | null;
    textValue: string | null;
    dateValue: string | null;
    createdAt: Date;
  }>(
    'SELECT submissionId, questionId, userId, unitId, optionKey, numberValue, textValue, dateValue, createdAt FROM survey_responses WHERE surveyId = :sid ORDER BY id ASC',
    { replacements: { sid: id }, type: QueryTypes.SELECT },
  );
  const subs = new Map<string, typeof rows>();
  for (const r of rows) subs.set(r.submissionId, [...(subs.get(r.submissionId) ?? []), r]);
  const order = [...subs.keys()];
  if (s.isAnonymous) order.sort();
  else order.sort((a, b) => +new Date(subs.get(a)![0]!.createdAt) - +new Date(subs.get(b)![0]!.createdAt));
  const names = new Map<number, string>();
  const labels = new Map<number, string>();
  if (!s.isAnonymous) {
    const userIds = [...new Set(rows.map(r => r.userId).filter((x): x is number => !!x))];
    if (userIds.length)
      for (const u of await User.findAll({ where: { id: userIds }, paranoid: false }))
        names.set(u.id!, u.name?.trim() || 'Resident');
    const unitIds = [...new Set(rows.map(r => r.unitId).filter((x): x is number => !!x))];
    if (unitIds.length) {
      for (const u of await Unit.findAll({
        where: { id: unitIds, societyId },
        attributes: ['id', 'label'],
        paranoid: false,
      }))
        labels.set(u.id!, u.label);
      for (const u of await units.listActive(societyId, { unitIds })) labels.set(u.id, u.label);
    }
  }
  // BR-16-48: anonymous text answers stay hidden below the threshold, in the export as on screen
  const hideText = s.isAnonymous && s.responseCount < LIMITS.surveyAnonTextMin;
  const hour = (d: Date) => {
    const x = new Date(d);
    x.setUTCMinutes(0, 0, 0);
    return x.toISOString();
  };
  const header = [
    'Submission',
    'Submitted at',
    ...(s.isAnonymous ? [] : ['Name', 'Flat']),
    ...qs.map((q, i) => `Q${i + 1}: ${q.prompt}`),
  ];
  const lines = [header.map(csvCell).join(',')];
  order.forEach((sid, i) => {
    const rs = subs.get(sid)!;
    const first = rs[0]!;
    const cells: unknown[] = [
      i + 1,
      s.isAnonymous ? hour(first.createdAt) : new Date(first.createdAt).toISOString(),
    ];
    if (!s.isAnonymous) cells.push(names.get(first.userId ?? 0) ?? '', labels.get(first.unitId ?? 0) ?? '');
    for (const q of qs) {
      const mine = rs.filter(r => r.questionId === q.id);
      const label = (k: string | null) =>
        q.type === 'YES_NO'
          ? k === 'yes'
            ? 'Yes'
            : 'No'
          : (q.options?.find(o => o.key === k)?.label ?? k ?? '');
      cells.push(
        mine
          .map(r =>
            r.optionKey !== null
              ? label(r.optionKey)
              : r.numberValue !== null
                ? r.numberValue
                : r.textValue !== null
                  ? hideText
                    ? '(hidden: fewer than 5 responses)'
                    : r.textValue
                  : (r.dateValue ?? ''),
          )
          .join('; '),
      );
    }
    lines.push(cells.map(csvCell).join(','));
  });
  await audit(ctx, {
    action: AUDIT.surveyExported,
    entityType: ENTITY.survey,
    entityId: id,
    societyId,
    after: { rows: order.length },
  });
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now());
  return { csv: `${lines.join('\r\n')}\r\n`, filename: `survey-${id}-${day}.csv`, rows: order.length };
}
