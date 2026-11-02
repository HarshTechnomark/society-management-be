import { Op, type Transaction } from 'sequelize';
import { Building, OnboardingStep, Society, Unit, sequelize } from '../../models';
import { ONBOARDING_STEP_KEYS, type OnboardingStepKey } from '../../models/onboarding-step.model';
import { now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { AppError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { usersWithPermission } from '../access-control/access-control.public';
import { AUDIT, ENTITY } from './society-setup.types';
import { emitAdmin, notifyAfterCommit, recipients } from './society-setup.notify';

/**
 * Onboarding checklist (module 08 sections 5.9, 6.3 to 6.5, 8.23 to 8.25). Eight fixed steps; rows are created lazily and
 * idempotently. Checks are small functions registered by the owning modules; steps without a check are completed by hand.
 */
export const STEP_NO: Record<OnboardingStepKey, number> = {
  PROFILE: 1,
  STRUCTURE: 2,
  UNITS: 3,
  RESIDENTS: 4,
  BILLING: 5,
  PAYMENTS: 6,
  COMMITTEE: 7,
  GO_LIVE: 8,
};
const REQUIRED = new Set<OnboardingStepKey>(['PROFILE', 'STRUCTURE', 'UNITS', 'BILLING', 'GO_LIVE']);
export const SKIPPABLE_STEPS = ONBOARDING_STEP_KEYS.filter(k => !REQUIRED.has(k));
/** Steps that clients may complete, skip or reopen (everything but GO_LIVE). */
export const CLIENT_STEP_KEYS = ONBOARDING_STEP_KEYS.filter(k => k !== 'GO_LIVE') as [
  OnboardingStepKey,
  ...OnboardingStepKey[],
];
const CHECK_TIMEOUT_MS = 2000;

export interface CheckResult {
  done: boolean;
  summary: string;
}
export type StepCheck = (societyId: number) => Promise<CheckResult>;
type CheckedKey = 'RESIDENTS' | 'BILLING' | 'PAYMENTS' | 'COMMITTEE';

const registered = new Map<CheckedKey, { module: string; check: StepCheck }>();
/** Module 09, 10, 11 and 13 register their check here (one per step; a later call replaces the earlier one). */
export function registerCheck(stepKey: CheckedKey, module: string, check: StepCheck): void {
  registered.set(stepKey, { module, check });
}
/** Test helper. */
export const clearRegisteredChecks = (): void => registered.clear();

type GoLiveHook = (ctx: Ctx, societyId: number, t: Transaction) => void | Promise<void>;
const goLiveHooks: GoLiveHook[] = [];
/**
 * Extension point for the go-live transaction (part 2 registers the welcome-invite job here with `enqueueAfterCommit`).
 * Hooks run inside the transaction after the GO_LIVE row is DONE.
 */
export const registerGoLiveHook = (h: GoLiveHook): void => {
  if (!goLiveHooks.includes(h)) goLiveHooks.push(h);
};

// ------------------------------------------------------------------ rows
export async function ensureSteps(societyId: number, t?: Transaction): Promise<void> {
  const at = now();
  await OnboardingStep.bulkCreate(
    ONBOARDING_STEP_KEYS.map(stepKey => ({
      societyId,
      stepKey,
      stepNo: STEP_NO[stepKey],
      isRequired: REQUIRED.has(stepKey),
      status: 'PENDING' as const,
      completedAt: null,
      completedBy: null,
      skipReason: null,
      lastCheckSummary: null,
      version: 1,
      createdBy: null,
      updatedBy: null,
      createdAt: at,
      updatedAt: at,
    })),
    { ignoreDuplicates: true, transaction: t },
  );
}

const rowsOf = (societyId: number, t?: Transaction) =>
  OnboardingStep.findAll({ where: { societyId }, order: [['stepNo', 'ASC']], transaction: t });

/** BR-08-46: from stored rows only. */
export async function progressPercent(societyId: number): Promise<number> {
  const n = await OnboardingStep.count({ where: { societyId, status: { [Op.in]: ['DONE', 'SKIPPED'] } } });
  return Math.floor((100 * n) / 8);
}

export async function isLive(societyId: number, t?: Transaction): Promise<boolean> {
  return (
    (await OnboardingStep.count({
      where: { societyId, stepKey: 'GO_LIVE', status: 'DONE' },
      transaction: t,
    })) > 0
  );
}

// ------------------------------------------------------------------ checks (6.4)
const PROFILE_FIELDS: [keyof Society, string][] = [
  ['name', 'name'],
  ['addressLine1', 'address'],
  ['city', 'city'],
  ['state', 'state'],
  ['pincode', 'PIN code'],
  ['registrationNo', 'registration number'],
];

async function profileCheck(societyId: number): Promise<CheckResult> {
  const s = await Society.findByPk(societyId);
  const missing = s
    ? PROFILE_FIELDS.filter(([f]) => !String(s[f] ?? '').trim()).map(([, l]) => l)
    : ['society'];
  return missing.length
    ? { done: false, summary: `Missing: ${missing.join(', ')}` }
    : { done: true, summary: 'Profile complete' };
}

async function structureCheck(societyId: number): Promise<CheckResult> {
  const b = await Building.count({ where: { societyId, status: 'ACTIVE' } });
  const u = await Unit.count({ where: { societyId, status: 'ACTIVE' } });
  if (!b) return { done: false, summary: 'No buildings yet' };
  if (!u) return { done: false, summary: 'No flats yet' };
  return { done: true, summary: `${b} building${b === 1 ? '' : 's'}, ${u} unit${u === 1 ? '' : 's'}` };
}

async function unitsCheck(societyId: number): Promise<CheckResult> {
  const missing = await Unit.count({
    where: { societyId, status: 'ACTIVE', isBillable: true, areaSqft: null },
  });
  if (missing)
    return {
      done: false,
      summary: `${missing} billable unit${missing === 1 ? '' : 's'} ${missing === 1 ? 'has' : 'have'} no area`,
    };
  const total = await Unit.count({ where: { societyId, status: 'ACTIVE', isBillable: true } });
  return { done: true, summary: `All ${total} billable units have an area` };
}

/** COMMITTEE fallback until module 10 registers its check (section 6.4). */
async function committeeFallback(societyId: number): Promise<CheckResult> {
  const n = (await usersWithPermission(societyId, 'settings.society.view')).length;
  return n >= 2
    ? { done: true, summary: `${n} committee members` }
    : { done: false, summary: n ? 'Only one person can manage the society' : 'No committee members yet' };
}

const BUILT_IN: Partial<Record<OnboardingStepKey, StepCheck>> = {
  PROFILE: profileCheck,
  STRUCTURE: structureCheck,
  UNITS: unitsCheck,
  COMMITTEE: committeeFallback,
};

export type CheckState = 'PASS' | 'FAIL' | 'NOT_AVAILABLE' | 'UNKNOWN';
interface CheckOutcome {
  state: CheckState;
  summary: string;
}

function checkFor(stepKey: OnboardingStepKey): StepCheck | undefined {
  if (stepKey === 'GO_LIVE') return undefined;
  return registered.get(stepKey as CheckedKey)?.check ?? BUILT_IN[stepKey];
}

/** Runs one check with a 2-second timeout (a slow owner module reports UNKNOWN, never blocks the screen). */
export async function runCheck(societyId: number, stepKey: OnboardingStepKey): Promise<CheckOutcome> {
  const check = checkFor(stepKey);
  if (!check) return { state: 'NOT_AVAILABLE', summary: 'Not checked automatically' };
  let timer: NodeJS.Timeout | undefined;
  try {
    const r = await Promise.race([
      check(societyId),
      new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), CHECK_TIMEOUT_MS);
      }),
    ]);
    if (r === 'timeout') return { state: 'UNKNOWN', summary: 'The check took too long' };
    return { state: r.done ? 'PASS' : 'FAIL', summary: r.summary.slice(0, 200) };
  } catch (err) {
    logger.error({ err, stepKey }, 'onboarding check failed');
    return { state: 'UNKNOWN', summary: 'The check could not run' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ view (8.23)
export interface StepView {
  stepKey: OnboardingStepKey;
  stepNo: number;
  isRequired: boolean;
  skippable: boolean;
  status: string;
  completedAt: string | null;
  skipReason: string | null;
  checkState: CheckState;
  summary: string;
}

export async function getView(societyId: number) {
  await ensureSteps(societyId);
  const rows = await rowsOf(societyId);
  const open = rows.filter(r => r.stepKey !== 'GO_LIVE' && r.status === 'PENDING').length;
  const steps: StepView[] = [];
  for (const r of rows) {
    let checkState: CheckState;
    let summary: string;
    if (r.stepKey === 'GO_LIVE') {
      if (r.status === 'DONE') [checkState, summary] = ['PASS', 'Society is live'];
      else if (open) [checkState, summary] = ['FAIL', `${open} step${open === 1 ? '' : 's'} left`];
      else [checkState, summary] = ['PASS', 'Ready to go live'];
    } else if (r.status === 'DONE') [checkState, summary] = ['PASS', r.lastCheckSummary ?? 'Done'];
    else if (r.status === 'SKIPPED') [checkState, summary] = ['NOT_AVAILABLE', `Skipped: ${r.skipReason}`];
    else {
      const c = await runCheck(societyId, r.stepKey);
      [checkState, summary] = [c.state, c.summary];
    }
    steps.push({
      stepKey: r.stepKey,
      stepNo: r.stepNo,
      isRequired: r.isRequired,
      skippable: !r.isRequired && r.stepKey !== 'GO_LIVE',
      status: r.status,
      completedAt: r.completedAt ? r.completedAt.toISOString() : null,
      skipReason: r.skipReason,
      checkState,
      summary,
    });
  }
  const done = rows.filter(r => r.status !== 'PENDING').length;
  const current = rows.find(r => r.status === 'PENDING')?.stepKey ?? null;
  return {
    isLive: rows.some(r => r.stepKey === 'GO_LIVE' && r.status === 'DONE'),
    progressPercent: Math.floor((100 * done) / 8),
    currentStep: current,
    steps,
  };
}

// ------------------------------------------------------------------ writes (8.24, 8.25)
const alreadyLive = () => new AppError(409, 'ALREADY_LIVE', 'This society is already live');
const invalidState = (m: string) => new AppError(409, 'INVALID_STATE', m);

async function lockSteps(societyId: number, keys: OnboardingStepKey[], t: Transaction) {
  const rows = await OnboardingStep.findAll({
    where: { societyId, stepKey: { [Op.in]: keys } },
    order: [['id', 'ASC']],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  return new Map(rows.map(r => [r.stepKey, r]));
}

function afterStepChange(t: Transaction, societyId: number): void {
  t.afterCommit(() => {
    void (async () => {
      try {
        const v = await getView(societyId);
        emitAdmin(societyId, 'setup.onboarding.updated', {
          progressPercent: v.progressPercent,
          isLive: v.isLive,
          currentStep: v.currentStep,
        });
      } catch (err) {
        logger.error({ err }, 'onboarding realtime failed');
      }
    })();
  });
}

export async function completeStep(ctx: Ctx, societyId: number, stepKey: OnboardingStepKey) {
  await ensureSteps(societyId);
  await sequelize.transaction(async t => {
    const rows = await lockSteps(societyId, [stepKey, 'GO_LIVE'], t);
    if (rows.get('GO_LIVE')!.status === 'DONE') throw alreadyLive();
    const step = rows.get(stepKey)!;
    if (step.status !== 'PENDING') throw invalidState('This step is not waiting to be completed');
    const c = await runCheck(societyId, stepKey);
    if (c.state === 'FAIL')
      throw new UnprocessableError('ONBOARDING_STEP_INCOMPLETE', c.summary, [
        { field: stepKey, message: c.summary },
      ]);
    step.status = 'DONE';
    step.completedAt = now();
    step.completedBy = ctx.user?.id ?? null;
    step.skipReason = null;
    step.lastCheckSummary = c.state === 'PASS' ? c.summary : 'Completed by hand';
    step.version += 1;
    step.updatedBy = ctx.user?.id ?? null;
    await step.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.stepCompleted,
        entityType: ENTITY.step,
        entityId: stepKey,
        societyId,
        after: { status: 'DONE', summary: step.lastCheckSummary },
      },
      t,
    );
    afterStepChange(t, societyId);
  });
  return getView(societyId);
}

export async function skipStep(ctx: Ctx, societyId: number, stepKey: OnboardingStepKey, reason: string) {
  await ensureSteps(societyId);
  await sequelize.transaction(async t => {
    const rows = await lockSteps(societyId, [stepKey, 'GO_LIVE'], t);
    if (rows.get('GO_LIVE')!.status === 'DONE') throw alreadyLive();
    const step = rows.get(stepKey)!;
    if (!SKIPPABLE_STEPS.includes(stepKey))
      throw new UnprocessableError(
        'ONBOARDING_STEP_NOT_SKIPPABLE',
        'This step is required and cannot be skipped',
      );
    if (step.status !== 'PENDING') throw invalidState('This step is not waiting to be completed');
    step.status = 'SKIPPED';
    step.completedAt = now();
    step.completedBy = ctx.user?.id ?? null;
    step.skipReason = reason;
    step.version += 1;
    step.updatedBy = ctx.user?.id ?? null;
    await step.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.stepSkipped,
        entityType: ENTITY.step,
        entityId: stepKey,
        societyId,
        after: { status: 'SKIPPED' },
        reason,
      },
      t,
    );
    afterStepChange(t, societyId);
  });
  return getView(societyId);
}

export async function reopenStep(ctx: Ctx, societyId: number, stepKey: OnboardingStepKey) {
  await ensureSteps(societyId);
  await sequelize.transaction(async t => {
    const rows = await lockSteps(societyId, [stepKey, 'GO_LIVE'], t);
    // BR-08-47 and T08-37: after go-live a step is never reopened (INVALID_STATE, not ALREADY_LIVE)
    if (rows.get('GO_LIVE')!.status === 'DONE')
      throw invalidState('The society is live; steps cannot be reopened');
    const step = rows.get(stepKey)!;
    if (step.status === 'PENDING') throw invalidState('This step is already open');
    const before = step.status;
    step.status = 'PENDING';
    step.completedAt = null;
    step.completedBy = null;
    step.skipReason = null;
    step.lastCheckSummary = null;
    step.version += 1;
    step.updatedBy = ctx.user?.id ?? null;
    await step.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.stepReopened,
        entityType: ENTITY.step,
        entityId: stepKey,
        societyId,
        before: { status: before },
        after: { status: 'PENDING' },
      },
      t,
    );
    afterStepChange(t, societyId);
  });
  return getView(societyId);
}

/** 6.5: go live. The welcome-invite job is queued by a hook that part 2 registers (`registerGoLiveHook`). */
export async function goLive(ctx: Ctx, societyId: number) {
  await ensureSteps(societyId);
  await sequelize.transaction(async t => {
    const rows = await OnboardingStep.findAll({
      where: { societyId },
      order: [['id', 'ASC']],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    const by = new Map(rows.map(r => [r.stepKey, r]));
    const goLiveRow = by.get('GO_LIVE')!;
    if (goLiveRow.status === 'DONE') throw alreadyLive();
    const failing: { field: string; message: string }[] = [];
    for (const r of rows) {
      if (r.stepKey === 'GO_LIVE') continue;
      if (r.status === 'PENDING') {
        failing.push({ field: r.stepKey, message: 'This step is not done yet' });
        continue;
      }
      if (r.isRequired) {
        const c = await runCheck(societyId, r.stepKey);
        if (c.state === 'FAIL') failing.push({ field: r.stepKey, message: c.summary });
      }
    }
    if (failing.length)
      throw new UnprocessableError(
        'ONBOARDING_NOT_READY',
        `Not ready to go live: ${failing.map(f => `${f.field}: ${f.message}`).join('; ')}`,
        failing,
      );
    goLiveRow.status = 'DONE';
    goLiveRow.completedAt = now();
    goLiveRow.completedBy = ctx.user?.id ?? null;
    goLiveRow.version += 1;
    goLiveRow.updatedBy = ctx.user?.id ?? null;
    await goLiveRow.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.societyWentLive,
        entityType: ENTITY.society,
        entityId: societyId,
        societyId,
        after: { isLive: true },
      },
      t,
    );
    for (const h of goLiveHooks) await h(ctx, societyId, t);
    notifyAfterCommit(t, 'setup.society.live', societyId, recipients.viewers, { link: '/' });
    afterStepChange(t, societyId);
  });
  return getView(societyId);
}
