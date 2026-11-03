import { randomUUID } from 'node:crypto';
import { Building, EntitlementOverride, OnboardingStep, Society, Unit, UsageCounter } from '../../src/models';
import { setNow } from '../../src/lib/clock';
import { setSocietyPorts } from '../../src/modules/societies/societies.ports';
import { registerSocieties } from '../../src/modules/societies/societies.public';
import { registerSocietySetup, setSetupPorts } from '../../src/modules/society-setup/society-setup.public';
import {
  invalidate as invalidateEntitlements,
  setAbsoluteUsage,
} from '../../src/modules/subscriptions/entitlements.service';
import {
  clearGoLiveHooks,
  clearRegisteredChecks,
  ensureSteps,
} from '../../src/modules/society-setup/society-setup.onboarding.service';
import { clearUnitGuards } from '../../src/modules/society-setup/society-setup.units.service';
import { testHooks } from '../../src/modules/society-setup/society-setup.generator.service';
import { gstinCheckChar } from '../../src/modules/society-setup/society-setup.gstin';
import { as, login, memberUser, resetLogins } from './access';
import { resetSubs, subSociety, type SubSocietyOpts } from './subscriptions';
import { drainQueues } from '../../src/lib/queue';

/** Fresh state with the real module 02 to 05 ports and the module 08 registrations. Call from `beforeEach`. */
export async function resetSetup(): Promise<void> {
  await drainQueues();
  await resetSubs();
  registerSocieties();
  setSocietyPorts();
  registerSocietySetup();
  setSetupPorts();
  clearRegisteredChecks();
  clearGoLiveHooks();
  clearUnitGuards();
  testHooks.afterUnitsInserted = undefined;
  resetLogins();
  setNow('2026-11-01T04:30:00Z');
}

/** A society with a subscription (STANDARD trial-free ACTIVE by default) and a signed-in member. */
export async function setupSociety(
  o: SubSocietyOpts & { role?: string; name?: string } = {},
): Promise<{ society: Society; c: ReturnType<typeof as>; user: Awaited<ReturnType<typeof memberUser>> }> {
  const { society } = await subSociety({ plan: 'STANDARD', flats: 0, ...o });
  const user = await memberUser(society, o.role ?? 'chairman', { name: o.name ?? 'Chair' });
  return { society, user, c: as(await login(user)) };
}

/** Another member of the same society, signed in. */
export async function memberOf(society: Society, role: string) {
  const user = await memberUser(society, role, { name: role });
  return { user, c: as(await login(user)) };
}

export const idemKey = (): Record<string, string> => ({ 'Idempotency-Key': randomUUID() });

export async function makeBuilding(
  c: ReturnType<typeof as>,
  o: Partial<{
    code: string;
    name: string;
    kind: string;
    floorsAboveGround: number;
    basements: number;
    parentBuildingId: number;
  }> = {},
) {
  const r = await c(
    'post',
    '/buildings',
    {
      code: o.code ?? 'A',
      name: o.name ?? `Tower ${o.code ?? 'A'}`,
      kind: o.kind ?? 'TOWER',
      floorsAboveGround: o.floorsAboveGround ?? 10,
      basements: o.basements ?? 0,
      ...(o.parentBuildingId ? { parentBuildingId: o.parentBuildingId } : {}),
    },
    { headers: idemKey() },
  );
  if (r.status !== 201) throw new Error(`building ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as { id: number; code: string; version: number; locationNodeId: number };
}

export async function makeUnit(
  c: ReturnType<typeof as>,
  buildingId: number,
  unitNumber: string,
  floor: number,
  extra: Record<string, unknown> = {},
) {
  const r = await c('post', '/units', { buildingId, unitNumber, floor, ...extra }, { headers: idemKey() });
  if (r.status !== 201) throw new Error(`unit ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as { id: number; label: string; version: number; areaSqft: string | null };
}

/** Units inserted straight into the table (no counter change), for tests of rules that need many rows quickly. */
export async function rawUnits(
  societyId: number,
  buildingId: number,
  code: string,
  n: number,
  o: {
    floor?: number;
    areaSqft?: string | null;
    carpet?: string | null;
    createdAt?: Date;
    type?: 'FLAT' | 'PARKING_ONLY';
  } = {},
) {
  const rows = Array.from({ length: n }, (_, i) => ({
    societyId,
    buildingId,
    unitNumber: `R${100 + i}`,
    label: `${code}-R${100 + i}`,
    floor: o.floor ?? 1 + Math.floor(i / 50),
    positionOnFloor: (i % 50) + 1,
    unitType: o.type ?? 'FLAT',
    bhk: null,
    carpetAreaSqft: o.carpet ?? null,
    builtUpAreaSqft: null,
    superBuiltUpAreaSqft: null,
    areaSqft: o.areaSqft ?? null,
    undividedSharePct: null,
    isBillable: (o.type ?? 'FLAT') !== 'PARKING_ONLY',
    possessionDate: null,
    notes: null,
    status: 'ACTIVE' as const,
    archivedAt: null,
    archivedReason: null,
    archivedBy: null,
    version: 1,
    createdBy: null,
    updatedBy: null,
    ...(o.createdAt ? { createdAt: o.createdAt, updatedAt: o.createdAt } : {}),
  }));
  await Unit.bulkCreate(rows);
}

export const countOf = (societyId: number) => Unit.count({ where: { societyId } });
export const buildingsOf = (societyId: number) => Building.count({ where: { societyId } });

/** A GSTIN with a correct check digit for the given state code and PAN. */
export function gstinFor(stateCode: string, pan: string, entity = '1', z = 'Z'): string {
  const first14 = `${stateCode}${pan}${entity}${z}`;
  return `${first14}${gstinCheckChar(first14)}`;
}

/** Marks every onboarding step DONE (the society is live) without running the checks. */
export async function markLive(societyId: number): Promise<void> {
  await ensureSteps(societyId);
  await OnboardingStep.update({ status: 'DONE', completedAt: new Date() }, { where: { societyId } });
}

/** Sets the `limit.flats` counter (the plan limit is separate). */
export const setFlatsUsed = (societyId: number, used: number) =>
  setAbsoluteUsage(societyId, 'limit.flats', used);

export const flatsUsed = async (societyId: number): Promise<number> =>
  Number(
    (await UsageCounter.findOne({ where: { societyId, limitKey: 'limit.flats', periodKey: 'ALL' } }))?.used ??
      0,
  );

async function override(societyId: number, o: Record<string, unknown>): Promise<void> {
  await EntitlementOverride.create({
    societyId,
    targetType: 'KEY',
    entitlementKey: null,
    moduleNo: null,
    isEnabled: null,
    limitValue: null,
    isUnlimited: false,
    source: 'SUPPORT',
    reason: 'test override',
    startsAt: new Date('2026-10-01T00:00:00Z'),
    expiresAt: null,
    revokedAt: null,
    revokedBy: null,
    revokeReason: null,
    expiryProcessedAt: null,
    createdBy: null,
    updatedBy: null,
    version: 1,
    ...o,
  } as never);
  await invalidateEntitlements(societyId);
}

/** Switches one entitlement key off for a society (a KEY override). */
export const featureOff = (societyId: number, key: string) =>
  override(societyId, { entitlementKey: key, isEnabled: false });

/** Makes `limit.flats` unlimited for a society. */
export const unlimitedFlats = (societyId: number) =>
  override(societyId, { entitlementKey: 'limit.flats', isUnlimited: true });
