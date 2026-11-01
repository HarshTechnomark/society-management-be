import { Society, SupportAccessGrant, sequelize } from '../../src/models';
import { addMinutes, now } from '../../src/lib/clock';
import { drainQueues } from '../../src/lib/queue';
import { registerSocieties } from '../../src/modules/societies/societies.public';
import { placeholderFiles, portCalls, setSocietyPorts } from '../../src/modules/societies/societies.ports';
import { drainSupportTracking } from '../../src/modules/societies/societies.support-access';
import { setExportPartLimit } from '../../src/modules/societies/societies.exports';
import { createTrial } from '../../src/modules/subscriptions/subscriptions.service';
import { resetSubs, subSociety, type SubSocietyOpts } from './subscriptions';
import { as, platformLogin, platformUser } from './access';
import { call, cookiesFrom, type Cookies, type TestUser } from './auth';

/** Fresh state with the real module 02, 03, 04 and 05 ports (module 05 placeholders for 01, 06, 07, 08, 12, 17). */
export async function resetSocieties(): Promise<void> {
  await drainQueues();
  await drainSupportTracking();
  await resetSubs();
  registerSocieties();
  setSocietyPorts();
  setExportPartLimit(null);
  placeholderFiles.clear();
  portCalls.length = 0;
}

/** Waits for jobs and support tracking started by the last requests. */
export async function settle(): Promise<void> {
  await drainQueues();
  await drainSupportTracking();
}

/** A society with a subscription: TRIAL (trial subscription) by default, or any lifecycle status. */
export async function lifecycleSociety(
  status: 'TRIAL' | 'ACTIVE' | 'PAST_DUE' | 'SUSPENDED' | 'CLOSED' = 'TRIAL',
  o: SubSocietyOpts & { cause?: 'NON_PAYMENT' | 'TRIAL_EXPIRED' | 'MANUAL'; consent?: boolean } = {},
): Promise<Society> {
  const trial = status === 'TRIAL' || o.cause === 'TRIAL_EXPIRED';
  const { society } = await subSociety({
    ...o,
    status: trial ? 'TRIALING' : 'ACTIVE',
    societyStatus: status === 'CLOSED' ? 'ACTIVE' : (status as never),
  });
  const patch: Record<string, unknown> = {};
  if (status === 'SUSPENDED' && o.cause) patch.suspensionCause = o.cause;
  if (status === 'CLOSED')
    Object.assign(patch, {
      status: 'CLOSED',
      closedAt: now(),
      closureReason: 'OTHER',
      purgeAfter: new Date(now().getTime() + 90 * 86_400_000),
      activatedAt: now(),
    });
  if (o.consent === false) patch.requiresSupportConsent = false;
  if (Object.keys(patch).length) await Society.update(patch as never, { where: { id: society.id! } });
  return (await Society.findByPk(society.id!))!;
}

export { createTrial };

/** A platform user signed in to the platform app, with a call helper. */
export async function platformAs(roleKey: 'super_admin' | 'platform_support', name?: string) {
  const u = await platformUser(roleKey, {
    name: name ?? (roleKey === 'super_admin' ? 'Asha Admin' : 'Isha Kapoor'),
  });
  const cookies = await platformLogin(u);
  return { user: u, cookies, c: as(cookies, 'PLATFORM') };
}

/** An ACTIVE grant row inserted directly (for tests that do not exercise the request flow). */
export async function activeGrant(
  societyId: number,
  platformUserId: number,
  scope: 'READ_ONLY' | 'READ_WRITE' = 'READ_ONLY',
  minutes = 60,
): Promise<SupportAccessGrant> {
  const t = now();
  return SupportAccessGrant.create({
    societyId,
    platformUserId,
    scope,
    reason: 'Checking the bank statement import for TKT-2041',
    ticketRef: 'TKT-2041',
    durationMinutes: minutes,
    isEmergency: false,
    status: 'ACTIVE',
    consentRequired: false,
    consentStatus: 'NOT_REQUIRED',
    consentExpiresAt: null,
    decidedByUserId: null,
    decidedAt: null,
    decisionNote: null,
    startedAt: t,
    endsAt: addMinutes(t, minutes),
    endedAt: null,
    endedByUserId: null,
    endReason: null,
    endNote: null,
    enteredAt: null,
    requestCount: 0,
    writeCount: 0,
    lastActivityAt: null,
    version: 1,
    createdBy: platformUserId,
    updatedBy: platformUserId,
  });
}

/** Support hand-off through the module 02 routes; returns the admin-app call helper of the new session. */
export async function enterAsSupport(platformCookies: Cookies, grantId: number) {
  const h = await as(platformCookies, 'PLATFORM')('post', '/auth/support-handoff', { grantId });
  if (h.status !== 201) throw new Error(`handoff ${h.status} ${JSON.stringify(h.body)}`);
  const r = await call(
    'post',
    '/auth/support-handoff/redeem',
    { handoffToken: h.body.data.handoffToken },
    { app: 'ADMIN' },
  );
  if (r.status !== 200) throw new Error(`redeem ${r.status} ${JSON.stringify(r.body)}`);
  const cookies = cookiesFrom(r);
  return { cookies, c: as(cookies, 'ADMIN') };
}

export const lockCount = async (table: string, where = '1=1'): Promise<number> => {
  const [rows] = await sequelize.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`);
  return Number((rows as { n: number }[])[0]!.n);
};

export type { TestUser };
