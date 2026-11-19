import { randomUUID } from 'node:crypto';
import { Op, UniqueConstraintError } from 'sequelize';
import { Survey, SurveyQuestion, SurveyResponse, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { emitToRoom } from '../../lib/realtime';
import { audit } from '../../utils/audit';
import { AppError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { residents } from '../residents/residents.public';
import { units } from '../society-setup/society-setup.public';
import { AUDIT, ENTITY, ERR, RT, roomAdmin } from './communication.constants';
import { relationMatches } from './communication.audience';
import { respondentKey } from './communication.crypto';
import { assertSurveyOpen } from './communication.state';
import { audienceOfSurvey, sNotFound } from './communication.surveys.service';
import { surveyResults, type SurveyResults } from './communication.surveys.results';

/** Resident survey routes (8.34): audience check "now", answer validation, one response per person or flat, anonymity (BR-16-47, BR-16-48). */

const societyIdOf = (ctx: Ctx): number => ctx.society!.id;

/** The caller's flats that match the survey audience today (BR-16-3: relation and buildings or units). */
export async function matchingUnits(ctx: Ctx, s: Survey): Promise<number[]> {
  const societyId = societyIdOf(ctx);
  let candidates = [...new Set(ctx.unitIds ?? [])];
  if (!candidates.length) return [];
  const a = audienceOfSurvey(s);
  if (a.type === 'UNITS') candidates = candidates.filter(u => a.ids?.includes(u));
  else if (a.type === 'BUILDINGS') {
    const list = await units.listActive(societyId, { unitIds: candidates });
    candidates = list.filter(u => a.ids?.includes(u.buildingId)).map(u => u.id);
  }
  const relation = a.relation ?? 'ANY';
  if (relation === 'ANY' || !candidates.length) return candidates;
  const out: number[] = [];
  for (const unitId of candidates) {
    const links = await residents.listForUnit(societyId, unitId);
    if (links.some(l => l.userId === ctx.user!.id && relationMatches(relation, l.tenancyId)))
      out.push(unitId);
  }
  return out;
}

const keyFor = (s: Survey, userId: number, unitId: number | null): string =>
  s.responseScope === 'FLAT'
    ? respondentKey(s.id, 'FLAT', unitId ?? 0, s.isAnonymous)
    : respondentKey(s.id, 'PERSON', userId, s.isAnonymous);

/** Has the caller answered (person key, or any of the caller's flats for FLAT scope)? */
async function hasResponded(ctx: Ctx, s: Survey): Promise<boolean> {
  const keys =
    s.responseScope === 'FLAT'
      ? (ctx.unitIds ?? []).map(u => keyFor(s, ctx.user!.id, u))
      : [keyFor(s, ctx.user!.id, null)];
  if (!keys.length) return false;
  return (await SurveyResponse.count({ where: { surveyId: s.id, respondentKey: { [Op.in]: keys } } })) > 0;
}

const resultsAllowed = (s: Survey, responded: boolean): boolean =>
  s.status === 'CLOSED' &&
  (s.resultsVisibility === 'ALL_AFTER_CLOSE' ||
    (s.resultsVisibility === 'RESPONDENTS_AFTER_CLOSE' && responded));

export async function listMine(ctx: Ctx) {
  const societyId = societyIdOf(ctx);
  const rows = await Survey.findAll({
    where: { societyId, status: { [Op.in]: ['OPEN', 'CLOSED'] } },
    order: [
      ['closesAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  const at = now();
  const out = [];
  for (const s of rows) {
    const responded = await hasResponded(ctx, s);
    if (s.status === 'OPEN') {
      if (s.closesAt && s.closesAt.getTime() <= at.getTime()) continue;
      if (!responded && !(await matchingUnits(ctx, s)).length) continue;
    } else if (!responded) continue;
    out.push({
      id: s.id,
      title: s.title,
      status: s.status,
      closesAt: s.closesAt,
      questionCount: s.questionCount,
      responded,
      resultsAvailable: resultsAllowed(s, responded),
    });
  }
  return out;
}

export async function getMine(
  ctx: Ctx,
  id: number,
): Promise<Record<string, unknown> & { results?: SurveyResults }> {
  const s = await Survey.findOne({ where: { id, societyId: societyIdOf(ctx) } });
  if (!s || s.status === 'DRAFT') throw sNotFound();
  const responded = await hasResponded(ctx, s);
  const matching = await matchingUnits(ctx, s);
  if (!responded && !matching.length) throw sNotFound();
  if (s.status === 'CANCELLED' && !responded) throw sNotFound();
  const qs = await SurveyQuestion.findAll({ where: { surveyId: id }, order: [['position', 'ASC']] });
  const showResults = resultsAllowed(s, responded);
  const labels =
    s.responseScope === 'FLAT' && matching.length > 1
      ? (await units.listActive(societyIdOf(ctx), { unitIds: matching })).map(u => ({
          unitId: u.id,
          label: u.label,
        }))
      : undefined;
  return {
    id: s.id,
    title: s.title,
    description: s.description,
    status: s.status,
    isAnonymous: s.isAnonymous,
    responseScope: s.responseScope,
    closesAt: s.closesAt,
    responded,
    questions: qs.map(q => ({
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      helpText: q.helpText,
      isRequired: q.isRequired,
      options: q.options,
      maxSelections: q.maxSelections,
      minValue: q.minValue,
      maxValue: q.maxValue,
      maxLength: q.maxLength,
    })),
    ...(showResults ? { results: await surveyResults(s) } : {}),
    ...(labels ? { units: labels } : {}),
  };
}

// ------------------------------------------------------------------ answers
export interface AnswerInput {
  questionId: number;
  optionKey?: string;
  optionKeys?: string[];
  number?: number;
  text?: string;
  date?: string;
}
interface Row {
  questionId: number;
  optionKey: string | null;
  numberValue: number | null;
  textValue: string | null;
  dateValue: string | null;
}

const invalid = (questionId: number, message: string) =>
  new UnprocessableError(ERR.surveyAnswerInvalid, message, [{ field: 'answers', message, questionId }]);

const isRealDate = (v: string): boolean => {
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/** PURE: checks every answer against its question (8.34) and returns the rows to store (one row per answer, one per selected option). */
export function validateAnswers(
  questions: Pick<
    SurveyQuestion,
    'id' | 'type' | 'isRequired' | 'options' | 'maxSelections' | 'minValue' | 'maxValue' | 'maxLength'
  >[],
  answers: AnswerInput[],
): Row[] {
  const byQ = new Map(questions.map(q => [q.id, q]));
  const seen = new Set<number>();
  const rows: Row[] = [];
  for (const a of answers) {
    const q = byQ.get(a.questionId);
    if (!q) throw invalid(a.questionId, 'This question is not part of the survey');
    if (seen.has(q.id)) throw invalid(q.id, 'Answered twice');
    seen.add(q.id);
    const only = (...keys: (keyof AnswerInput)[]) => {
      for (const k of ['optionKey', 'optionKeys', 'number', 'text', 'date'] as const)
        if (a[k] !== undefined && !keys.includes(k)) throw invalid(q.id, `Unexpected ${k} for this question`);
    };
    const row = (o: Partial<Row>): Row => ({
      questionId: q.id,
      optionKey: null,
      numberValue: null,
      textValue: null,
      dateValue: null,
      ...o,
    });
    switch (q.type) {
      case 'SINGLE_CHOICE': {
        only('optionKey');
        if (!a.optionKey || !q.options?.some(o => o.key === a.optionKey))
          throw invalid(q.id, 'Choose one of the options');
        rows.push(row({ optionKey: a.optionKey }));
        break;
      }
      case 'MULTI_CHOICE': {
        only('optionKeys');
        const keys = a.optionKeys ?? [];
        const max = q.maxSelections ?? q.options?.length ?? 1;
        if (
          !keys.length ||
          keys.length > max ||
          new Set(keys).size !== keys.length ||
          keys.some(k => !q.options?.some(o => o.key === k))
        )
          throw invalid(q.id, `Choose 1 to ${max} different options`);
        for (const k of keys) rows.push(row({ optionKey: k }));
        break;
      }
      case 'YES_NO':
        only('optionKey');
        if (a.optionKey !== 'yes' && a.optionKey !== 'no') throw invalid(q.id, 'Answer yes or no');
        rows.push(row({ optionKey: a.optionKey }));
        break;
      case 'RATING':
      case 'NPS':
      case 'NUMBER': {
        only('number');
        const [lo, hi] =
          q.type === 'RATING' ? [1, 5] : q.type === 'NPS' ? [0, 10] : [q.minValue ?? 0, q.maxValue ?? 0];
        if (a.number === undefined || !Number.isInteger(a.number) || a.number < lo || a.number > hi)
          throw invalid(q.id, `Enter a number from ${lo} to ${hi}`);
        rows.push(row({ numberValue: a.number }));
        break;
      }
      case 'TEXT': {
        only('text');
        const t = (a.text ?? '').trim();
        const max = q.maxLength ?? 500;
        if (t.length < 1 || t.length > max) throw invalid(q.id, `Write 1 to ${max} characters`);
        rows.push(row({ textValue: t }));
        break;
      }
      case 'DATE':
        only('date');
        if (!a.date || !isRealDate(a.date)) throw invalid(q.id, 'Enter a date as YYYY-MM-DD');
        rows.push(row({ dateValue: a.date }));
        break;
    }
  }
  for (const q of questions)
    if (q.isRequired && !seen.has(q.id)) throw invalid(q.id, 'This question needs an answer');
  return rows;
}

export async function respond(
  ctx: Ctx,
  surveyId: number,
  body: { unitId?: number; answers: AnswerInput[] },
): Promise<{ submissionId: string; submittedAt: Date }> {
  const societyId = societyIdOf(ctx);
  const userId = ctx.user!.id;
  const pre = await Survey.findOne({ where: { id: surveyId, societyId } });
  if (!pre) throw sNotFound();
  const matching = await matchingUnits(ctx, pre);
  if (!matching.length) throw sNotFound();
  let unitId: number | null = null;
  if (body.unitId !== undefined) {
    if (!matching.includes(body.unitId))
      throw new UnprocessableError(ERR.surveyUnitRequired, 'Choose one of your flats in the audience', [
        { field: 'unitId', message: 'Not one of your flats in the audience' },
      ]);
    unitId = body.unitId;
  } else if (matching.length === 1) unitId = matching[0]!;
  else if (pre.responseScope === 'FLAT')
    throw new UnprocessableError(ERR.surveyUnitRequired, 'Choose the flat you are answering for', [
      { field: 'unitId', message: 'Required' },
    ]);
  const questions = await SurveyQuestion.findAll({ where: { surveyId }, order: [['position', 'ASC']] });
  const key = keyFor(pre, userId, unitId);

  return sequelize.transaction(async t => {
    const s = await Survey.findOne({
      where: { id: surveyId, societyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!s) throw sNotFound();
    const at = now();
    assertSurveyOpen(s.status);
    if (!s.closesAt || s.closesAt.getTime() <= at.getTime())
      throw new AppError(409, ERR.surveyNotOpen, 'This survey is not accepting responses');
    const rows = validateAnswers(questions, body.answers);
    if (await SurveyResponse.count({ where: { surveyId, respondentKey: key }, transaction: t }))
      throw new AppError(409, ERR.surveyAlreadyResponded, 'You have already answered this survey');
    const submissionId = randomUUID();
    const stamp = new Date(at);
    if (s.isAnonymous) stamp.setUTCMinutes(0, 0, 0);
    try {
      await SurveyResponse.bulkCreate(
        rows.map(r => ({
          societyId,
          surveyId,
          submissionId,
          respondentKey: key,
          userId: s.isAnonymous ? null : userId,
          unitId: s.isAnonymous ? null : unitId,
          ...r,
          createdBy: s.isAnonymous ? null : userId,
          updatedBy: null,
        })) as never,
        { transaction: t },
      );
      // BR-16-48 / 7.12: anonymous rows keep both times truncated to the hour
      if (s.isAnonymous)
        await SurveyResponse.update(
          { createdAt: stamp, updatedAt: stamp },
          { where: { surveyId, submissionId }, transaction: t, silent: true },
        );
    } catch (err) {
      if (err instanceof UniqueConstraintError)
        throw new AppError(409, ERR.surveyAlreadyResponded, 'You have already answered this survey');
      throw err;
    }
    s.responseCount += 1;
    await s.save({ transaction: t });
    if (!s.isAnonymous)
      await audit(
        ctx,
        {
          action: AUDIT.surveyResponseSubmitted,
          entityType: ENTITY.surveyResponse,
          entityId: submissionId,
          societyId,
          after: { surveyId, answers: rows.length },
        },
        t,
      );
    emitToRoom(roomAdmin(societyId), RT.surveyResponseCount, { surveyId, count: s.responseCount });
    return { submissionId, submittedAt: at };
  });
}
