import { Op, type Transaction } from 'sequelize';
import { Survey, SurveyQuestion, SurveyResponse, User, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { AppError, ForbiddenError, NotFoundError, UnprocessableError } from '../../utils/errors';
import { pageMeta, type PageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { audienceLabel, resolveAudience } from './communication.audience';
import { AUDIT, ENTITY, ERR, LIMITS, NOTIFY, PERM, type QuestionType } from './communication.constants';
import { notify } from './communication.core';
import { assertSurveyTransition, surveyCloseWindowOk } from './communication.state';
import type { NoticeAudience } from './communication.types';

/** Surveys, admin side (8.31, 8.32; BR-16-45, BR-16-46, BR-16-48, BR-16-49). Status changes go through `assertSurveyTransition`. */

export const sNotFound = () => new NotFoundError(ERR.surveyNotFound, 'Survey not found');
const societyIdOf = (ctx: Ctx): number => {
  const id = ctx.society?.id;
  if (!id) throw new Error('communication: the context carries no society');
  return id;
};
const stale = () =>
  new AppError(409, ERR.staleVersion, 'The survey was changed by someone else. Reload and try again.');

export interface QuestionInput {
  type: QuestionType;
  prompt: string;
  helpText?: string | null;
  isRequired?: boolean;
  options?: { key: string; label: string }[] | null;
  maxSelections?: number | null;
  minValue?: number | null;
  maxValue?: number | null;
  maxLength?: number | null;
}
export interface SurveyInput {
  title?: string;
  description?: string | null;
  isAnonymous?: boolean;
  responseScope?: 'PERSON' | 'FLAT';
  resultsVisibility?: 'ADMINS' | 'RESPONDENTS_AFTER_CLOSE' | 'ALL_AFTER_CLOSE';
  audience?: { type: 'ALL' | 'BUILDINGS' | 'UNITS'; relation?: 'ANY' | 'OWNERS' | 'TENANTS'; ids?: number[] };
  closesAt?: Date | null;
  questions?: QuestionInput[];
}

export const audienceOfSurvey = (
  s: Pick<Survey, 'audienceType' | 'audienceRelation' | 'audienceIds'>,
): NoticeAudience => ({
  type: s.audienceType as 'ALL' | 'BUILDINGS' | 'UNITS',
  relation: s.audienceRelation,
  ...(s.audienceIds ? { ids: s.audienceIds } : {}),
});

export const questionDto = (q: SurveyQuestion) => ({
  id: q.id,
  position: q.position,
  type: q.type,
  prompt: q.prompt,
  helpText: q.helpText,
  isRequired: q.isRequired,
  options: q.options,
  maxSelections: q.maxSelections,
  minValue: q.minValue,
  maxValue: q.maxValue,
  maxLength: q.maxLength,
});

export const listItem = (s: Survey) => ({
  id: s.id,
  title: s.title,
  status: s.status,
  isAnonymous: s.isAnonymous,
  closesAt: s.closesAt,
  recipientCount: s.recipientCount,
  responseCount: s.responseCount,
  questionCount: s.questionCount,
  createdAt: s.createdAt,
  version: s.version,
});

export async function toSurveyDto(s: Survey, questions?: SurveyQuestion[]) {
  const qs =
    questions ?? (await SurveyQuestion.findAll({ where: { surveyId: s.id }, order: [['position', 'ASC']] }));
  const creator = s.createdBy
    ? await User.findByPk(s.createdBy, { attributes: ['name'], paranoid: false })
    : null;
  const aud = audienceOfSurvey(s);
  return {
    ...listItem(s),
    description: s.description,
    responseScope: s.responseScope,
    resultsVisibility: s.resultsVisibility,
    audience: {
      type: s.audienceType,
      relation: s.audienceRelation,
      ids: s.audienceIds ?? [],
      label: audienceLabel(aud),
    },
    openedAt: s.openedAt,
    closedAt: s.closedAt,
    cancelledAt: s.cancelledAt,
    cancelReason: s.cancelReason,
    createdByName: creator?.name ?? null,
    questions: qs.map(questionDto),
  };
}
export type SurveyDto = Awaited<ReturnType<typeof toSurveyDto>>;

async function lock(societyId: number, id: number, t: Transaction): Promise<Survey> {
  const s = await Survey.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!s) throw sNotFound();
  return s;
}
const checkVersion = (s: Survey, version: number | undefined) => {
  if (version !== undefined && s.version !== version) throw stale();
};

const questionRows = (societyId: number, surveyId: number, userId: number | null, qs: QuestionInput[]) =>
  qs.map((q, i) => ({
    societyId,
    surveyId,
    position: i + 1,
    type: q.type,
    prompt: q.prompt,
    helpText: q.helpText ?? null,
    isRequired: q.isRequired ?? true,
    options: q.options ?? null,
    maxSelections: q.type === 'MULTI_CHOICE' ? (q.maxSelections ?? q.options?.length ?? null) : null,
    minValue: q.type === 'NUMBER' ? (q.minValue ?? null) : null,
    maxValue: q.type === 'NUMBER' ? (q.maxValue ?? null) : null,
    maxLength: q.type === 'TEXT' ? (q.maxLength ?? 500) : null,
    createdBy: userId,
    updatedBy: null,
  }));

const audienceColumns = (a: NonNullable<SurveyInput['audience']>) => ({
  audienceType: a.type,
  audienceRelation: a.relation ?? 'ANY',
  audienceIds: a.type === 'ALL' ? null : [...new Set(a.ids ?? [])].sort((x, y) => x - y),
});

// ------------------------------------------------------------------ list, get
export async function listSurveys(
  ctx: Ctx,
  q: { status?: string; q?: string; sortBy: string; sortOrder: 'asc' | 'desc'; page: number; limit: number },
): Promise<{ data: ReturnType<typeof listItem>[]; pagination: PageMeta }> {
  const societyId = societyIdOf(ctx);
  const where: Record<string, unknown> = { societyId };
  if (q.status) where.status = q.status;
  if (q.q) where.title = { [Op.like]: `%${q.q.replace(/[\\%_]/g, m => `\\${m}`)}%` };
  const dir = q.sortOrder.toUpperCase();
  const { rows, count } = await Survey.findAndCountAll({
    where,
    order: [
      [q.sortBy, dir],
      ['id', dir],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { data: rows.map(listItem), pagination: pageMeta(q.page, q.limit, count) };
}

export async function getSurvey(ctx: Ctx, id: number): Promise<SurveyDto> {
  const s = await Survey.findOne({ where: { id, societyId: societyIdOf(ctx) } });
  if (!s) throw sNotFound();
  return toSurveyDto(s);
}

// ------------------------------------------------------------------ create, edit, delete
export async function createSurvey(ctx: Ctx, input: SurveyInput & { title: string }): Promise<SurveyDto> {
  const societyId = societyIdOf(ctx);
  const userId = ctx.user!.id;
  const id = await sequelize.transaction(async t => {
    const s = await Survey.create(
      {
        societyId,
        title: input.title,
        description: input.description ?? null,
        isAnonymous: input.isAnonymous ?? false,
        responseScope: input.responseScope ?? 'PERSON',
        resultsVisibility: input.resultsVisibility ?? 'ADMINS',
        ...audienceColumns(input.audience ?? { type: 'ALL' }),
        closesAt: input.closesAt ?? null,
        questionCount: input.questions?.length ?? 0,
        createdBy: userId,
        updatedBy: userId,
      },
      { transaction: t },
    );
    if (input.questions?.length)
      await SurveyQuestion.bulkCreate(questionRows(societyId, s.id, userId, input.questions) as never, {
        transaction: t,
      });
    await audit(
      ctx,
      {
        action: AUDIT.surveyCreated,
        entityType: ENTITY.survey,
        entityId: s.id,
        societyId,
        after: { questionCount: s.questionCount, isAnonymous: s.isAnonymous, titleLength: s.title.length },
      },
      t,
    );
    return s.id;
  });
  return getSurvey(ctx, id);
}

export async function patchSurvey(
  ctx: Ctx,
  id: number,
  input: SurveyInput & { version: number },
): Promise<SurveyDto> {
  const societyId = societyIdOf(ctx);
  const userId = ctx.user!.id;
  await sequelize.transaction(async t => {
    const s = await lock(societyId, id, t);
    if (s.createdBy !== userId && !ctx.permissions?.has(PERM.surveysEdit))
      throw new ForbiddenError(ERR.permissionDenied, 'You can only edit your own drafts');
    if (s.status !== 'DRAFT')
      throw new AppError(409, ERR.invalidState, 'Only a draft survey can be edited', [
        { field: 'status', message: s.status },
      ]);
    checkVersion(s, input.version);
    if (input.title !== undefined) s.title = input.title;
    if (input.description !== undefined) s.description = input.description;
    if (input.isAnonymous !== undefined) s.isAnonymous = input.isAnonymous;
    if (input.responseScope !== undefined) s.responseScope = input.responseScope;
    if (input.resultsVisibility !== undefined) s.resultsVisibility = input.resultsVisibility;
    if (input.audience) Object.assign(s, audienceColumns(input.audience));
    if (input.closesAt !== undefined) s.closesAt = input.closesAt;
    if (input.questions) {
      await SurveyQuestion.destroy({ where: { surveyId: id }, transaction: t });
      if (input.questions.length)
        await SurveyQuestion.bulkCreate(questionRows(societyId, id, userId, input.questions) as never, {
          transaction: t,
        });
      s.questionCount = input.questions.length;
    }
    s.version += 1;
    s.updatedBy = userId;
    await s.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.surveyUpdated,
        entityType: ENTITY.survey,
        entityId: id,
        societyId,
        after: { questionCount: s.questionCount, questionsReplaced: Boolean(input.questions) },
      },
      t,
    );
  });
  return getSurvey(ctx, id);
}

export async function deleteSurvey(ctx: Ctx, id: number, version: number): Promise<void> {
  const societyId = societyIdOf(ctx);
  await sequelize.transaction(async t => {
    const s = await lock(societyId, id, t);
    assertSurveyTransition(s.status, 'delete');
    checkVersion(s, version);
    s.updatedBy = ctx.user!.id;
    await s.save({ transaction: t });
    await s.destroy({ transaction: t });
    await audit(ctx, { action: AUDIT.surveyDeleted, entityType: ENTITY.survey, entityId: id, societyId }, t);
  });
}

// ------------------------------------------------------------------ publish, close, cancel (8.32)
export async function publishSurvey(
  ctx: Ctx,
  id: number,
  body: { version: number; closesAt?: Date },
): Promise<SurveyDto> {
  const societyId = societyIdOf(ctx);
  const pre = await Survey.findOne({ where: { id, societyId } });
  if (!pre) throw sNotFound();
  assertSurveyTransition(pre.status, 'publish');
  const at = now();
  const closesAt = body.closesAt ?? pre.closesAt;
  const people = await resolveAudience(societyId, audienceOfSurvey(pre));
  const userIds = people.userIds;
  const s = await sequelize.transaction(async t => {
    const s = await lock(societyId, id, t);
    assertSurveyTransition(s.status, 'publish');
    checkVersion(s, body.version);
    const n = await SurveyQuestion.count({ where: { surveyId: id }, transaction: t });
    if (n < 1 || n > LIMITS.surveyQuestionsMax)
      throw new UnprocessableError(ERR.surveyQuestionsRequired, 'Add 1 to 30 questions before publishing');
    if (!closesAt || !surveyCloseWindowOk(closesAt, at))
      throw new UnprocessableError(
        ERR.surveyCloseInvalid,
        'The closing time must be 1 hour to 90 days from now',
        [{ field: 'closesAt', message: 'Between 1 hour and 90 days from now' }],
      );
    if (!userIds.length)
      throw new UnprocessableError(ERR.surveyAudienceEmpty, 'This audience has no residents to invite');
    s.status = 'OPEN';
    s.openedAt = at;
    s.closesAt = closesAt;
    s.recipientCount = userIds.length;
    s.questionCount = n;
    s.version += 1;
    s.updatedBy = ctx.user?.id ?? null;
    await s.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.surveyPublished,
        entityType: ENTITY.survey,
        entityId: id,
        societyId,
        after: { recipientCount: userIds.length, closesAt: closesAt.toISOString() },
      },
      t,
    );
    return s;
  });
  try {
    await notify(
      NOTIFY.surveyPublished,
      userIds,
      { surveyId: s.id, title: s.title, closesAt: s.closesAt!.toISOString() },
      { societyId, dedupeKey: `survey:${s.id}`, sourceType: 'survey', sourceId: s.id },
    );
  } catch (err) {
    logger.error({ err, surveyId: s.id }, 'survey published notify failed');
  }
  return toSurveyDto(s);
}

/** Close now (`version` given) or by the close job (`version` omitted, any society). */
export async function closeSurvey(ctx: Ctx, id: number, version?: number): Promise<SurveyDto> {
  const societyId = societyIdOf(ctx);
  const s = await sequelize.transaction(async t => {
    const s = await lock(societyId, id, t);
    assertSurveyTransition(s.status, 'close');
    checkVersion(s, version);
    s.status = 'CLOSED';
    s.closedAt = now();
    s.version += 1;
    s.updatedBy = ctx.user?.id ?? null;
    await s.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.surveyClosed,
        entityType: ENTITY.survey,
        entityId: id,
        societyId,
        after: { responseCount: s.responseCount },
      },
      t,
    );
    return s;
  });
  if (!s.isAnonymous && s.resultsVisibility !== 'ADMINS') {
    const rows = await SurveyResponse.findAll({
      where: { surveyId: id, userId: { [Op.ne]: null } },
      attributes: ['userId'],
      group: ['userId'],
    });
    const userIds = rows.map(r => r.userId!);
    if (userIds.length)
      try {
        await notify(
          NOTIFY.surveyClosed,
          userIds,
          { surveyId: id, title: s.title },
          { societyId, dedupeKey: `survey-closed:${id}`, sourceType: 'survey', sourceId: id },
        );
      } catch (err) {
        logger.error({ err, surveyId: id }, 'survey closed notify failed');
      }
  }
  return toSurveyDto(s);
}

export async function cancelSurvey(
  ctx: Ctx,
  id: number,
  body: { version: number; reason: string },
): Promise<SurveyDto> {
  const societyId = societyIdOf(ctx);
  const s = await sequelize.transaction(async t => {
    const s = await lock(societyId, id, t);
    assertSurveyTransition(s.status, 'cancel');
    checkVersion(s, body.version);
    s.status = 'CANCELLED';
    s.cancelledAt = now();
    s.cancelReason = body.reason;
    s.version += 1;
    s.updatedBy = ctx.user?.id ?? null;
    await s.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.surveyCancelled,
        entityType: ENTITY.survey,
        entityId: id,
        societyId,
        after: { reasonLength: body.reason.length },
      },
      t,
    );
    return s;
  });
  return toSurveyDto(s);
}

/** For the `communication:survey-close` job (16.4): closes every OPEN survey whose `closesAt` has passed; returns the number closed. */
export async function closeDueSurveys(ctxFor: (societyId: number) => Ctx): Promise<number> {
  const due = await Survey.findAll({
    where: { status: 'OPEN', closesAt: { [Op.lte]: now() } },
    attributes: ['id', 'societyId'],
    limit: 200,
  });
  let n = 0;
  for (const s of due)
    try {
      await closeSurvey(ctxFor(s.societyId), s.id);
      n += 1;
    } catch (err) {
      logger.warn({ err, surveyId: s.id }, 'survey close failed');
    }
  return n;
}
