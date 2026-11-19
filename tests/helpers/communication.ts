import { createHash } from 'node:crypto';
import { InboxItem, Notification, PushSubscription, Society, sequelize } from '../../src/models';
import { setAdapters } from '../../src/adapters';
import { clearInbox } from '../../src/lib/inbox';
import { setNow } from '../../src/lib/clock';
import { resetQueueState } from '../../src/lib/queue';
import { setNotifyEngine } from '../../src/lib/notify';
import { encrypt } from '../../src/modules/communication/communication.crypto';
import { legacyEngine } from '../../src/modules/communication/communication.core';
import { setDeliveryMode } from '../../src/modules/communication/communication.mode';
import { dropTemplateCache } from '../../src/modules/communication/communication.templates';
import {
  communicationPortCalls,
  setCommunicationPorts,
} from '../../src/modules/communication/communication.ports';
import { ApprovalRule, Notice, NoticeReceipt, NotificationPreference } from '../../src/models';
import { drainQueues } from '../../src/lib/queue';
import { registerApprovals } from '../../src/modules/approvals/approvals.public';
import { resetRegistry } from '../../src/modules/approvals/approvals.registry';
import { setApprovalsPorts } from '../../src/modules/approvals/approvals.ports';
import { defaultRuleRows } from '../../src/modules/approvals/approvals.rules.seed';
import { registerNoticeApprovalType } from '../../src/modules/communication/communication.approval';
import { registerCommunicationJobs } from '../../src/modules/communication/communication.jobs';
import { setResidentPorts } from '../../src/modules/residents/residents.ports';
import { registerResidents } from '../../src/modules/residents/residents.public';
import { as, login, memberUser, idem } from './access';
import { helpdeskWorld, resetHelpdesk } from './helpdesk';
import { residentSociety, residentUser, resetResidents } from './residents';
import { makeBuilding, makeUnit, memberOf, resetSetup, setupSociety } from './society-setup';

/** Fresh state for module 16 tests: placeholder ports, inline delivery, real engine installed, clock at 2026-11-01 10:00 IST. Call from `beforeEach` after `resetAll()`. */
export async function resetCommunication(): Promise<void> {
  setCommunicationPorts();
  setDeliveryMode(null);
  setAdapters(undefined);
  dropTemplateCache();
  resetQueueState();
  setNotifyEngine(legacyEngine);
  await clearInbox();
  setNow('2026-11-01T04:30:00Z');
}

export const portCalls = communicationPortCalls;

let n = 0;
/** An active Web Push subscription of a user (the placeholder push port "sends" to it). */
export async function subscribePush(
  userId: number,
  o: { app?: 'ADMIN' | 'RESIDENT' } = {},
): Promise<PushSubscription> {
  n += 1;
  const endpoint = `https://fcm.googleapis.com/fcm/send/test-${userId}-${n}`;
  return PushSubscription.create({
    userId,
    sessionId: null,
    app: o.app ?? 'RESIDENT',
    endpoint,
    endpointHash: createHash('sha256').update(endpoint).digest('hex'),
    p256dh: 'B'.repeat(87),
    authSecretEnc: encrypt('authsecret'),
    status: 'ACTIVE',
  } as never);
}

export const setPrefs = (userId: number, patch: Record<string, unknown>) =>
  NotificationPreference.findOrCreate({ where: { userId } }).then(([p]) => p.update(patch as never));

export const deliveries = (where: Record<string, unknown> = {}) =>
  Notification.findAll({ where: where as never, order: [['id', 'ASC']] });
export const inboxItems = (userId: number) =>
  InboxItem.findAll({ where: { userId }, order: [['id', 'ASC']] });
/** Sets a lifecycle status together with the columns the societies CHECKs require (module 05). */
export const setSocietyStatus = (id: number, status: string) =>
  Society.update(
    {
      status,
      suspensionCause: status === 'SUSPENDED' ? 'MANUAL' : null,
      closedAt: status === 'CLOSED' ? new Date() : null,
      closureReason: status === 'CLOSED' ? 'OTHER' : null,
    } as never,
    { where: { id } },
  );

/** Cheap per-test cleanup of module 16 rows (the full `resetAll()` truncates ~100 tables and is done once per file in `beforeAll`). */
export async function clearCommunicationRows(): Promise<void> {
  for (const t of ['notifications', 'inbox_items', 'notification_preferences', 'push_subscriptions'])
    await sequelize.query(`DELETE FROM ${t}`);
}

// ------------------------------------------------------------------ part 16.1 (notices admin)
/** Resets state and registers module 14 plus the notice handler and jobs. Call from `beforeEach` after `resetAll()`. */
export async function resetNotices(): Promise<void> {
  await resetResidents();
  await resetCommunication();
  setApprovalsPorts();
  resetRegistry();
  registerApprovals();
  registerNoticeApprovalType();
  registerCommunicationJobs();
}

/** An AUTO_APPROVE rule for `NOTICE_PUBLISH`, so publishing needs no approver (BR-16-6 "no matching rule"). */
export async function autoApproveNotices(societyId: number): Promise<void> {
  const [row] = defaultRuleRows(societyId, 'NOTICE_PUBLISH');
  await ApprovalRule.create({ ...row!, name: 'Auto', action: 'AUTO_APPROVE', steps: [] } as never);
}

export interface NoticeWorld {
  society: Awaited<ReturnType<typeof residentSociety>>['society'];
  sid: number;
  /** Chairman, signed in. */
  c: ReturnType<typeof as>;
  chairman: Awaited<ReturnType<typeof residentSociety>>['user'];
  units: { id: number; label: string }[];
  buildingId: number;
  /** A second tower with one flat. */
  buildingB: { id: number; unitId: number };
  /** Residents with a login: r1 owns A-101, r2 rents A-102, r3 owns B-101. */
  r1: Awaited<ReturnType<typeof residentUser>>;
  r2: Awaited<ReturnType<typeof residentUser>>;
  r3: Awaited<ReturnType<typeof residentUser>>;
  member: (
    role: string,
  ) => Promise<{ user: Awaited<ReturnType<typeof memberUser>>; c: ReturnType<typeof as> }>;
}

export async function noticeWorld(
  plan: 'STARTER' | 'STANDARD' | 'PREMIUM' = 'PREMIUM',
): Promise<NoticeWorld> {
  const w = await residentSociety({ plan, flats: 3 });
  const b2 = await makeBuilding(w.c, { code: 'B', floorsAboveGround: 5 });
  const bu = await makeUnit(w.c, b2.id, '101', 1);
  const r1 = await residentUser(w.society, w.unit(1).id, { name: 'Rohan Mehta' });
  const r2 = await residentUser(w.society, w.unit(2).id, { name: 'Tina Tenant', relation: 'FAMILY' });
  const r3 = await residentUser(w.society, bu.id, { name: 'Bela Bhosale' });
  return {
    society: w.society,
    sid: w.society.id!,
    c: w.c,
    chairman: w.user,
    units: w.units,
    buildingId: w.buildingId,
    buildingB: { id: b2.id, unitId: bu.id },
    r1,
    r2,
    r3,
    member: async role => {
      const user = await memberUser(w.society, role, { name: role });
      return { user, c: as(await login(user, { societyId: w.society.id! })) };
    },
  };
}

export const noticeBody = (over: Record<string, unknown> = {}) => ({
  title: 'Water tank cleaning on Sunday',
  body: '<p>The water tank will be cleaned on <strong>Sunday</strong>. Please store water.</p>',
  category: 'MAINTENANCE',
  ...over,
});

/** POST /notices; returns the response body `data`. */
export async function mkNotice(c: ReturnType<typeof as>, over: Record<string, unknown> = {}): Promise<any> {
  const r = await c('post', '/notices', noticeBody(over), { headers: idem() });
  if (r.status !== 201) throw new Error(`mkNotice ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data;
}

/** Create, publish (auto-approved society) and run the fan-out job. Returns the published notice. */
export async function publishNow(
  c: ReturnType<typeof as>,
  over: Record<string, unknown> = {},
  body: Record<string, unknown> = {},
): Promise<any> {
  const n = await mkNotice(c, over);
  const r = await c('post', `/notices/${n.id}/publish`, { version: n.version, ...body }, { headers: idem() });
  if (r.status !== 200) throw new Error(`publishNow ${r.status} ${JSON.stringify(r.body)}`);
  await drainQueues();
  return (await c('get', `/notices/${n.id}`)).body.data;
}

/** `AUTO` publishes without an approver; `MANUAL` needs the chairman (author someone else: the maker is not the checker). */
export async function approvalMode(societyId: number, mode: 'AUTO' | 'MANUAL'): Promise<void> {
  await ApprovalRule.update(
    {
      action: mode === 'AUTO' ? 'AUTO_APPROVE' : 'REQUIRE_APPROVAL',
      steps:
        mode === 'AUTO'
          ? []
          : [
              {
                stepNo: 1,
                name: 'Chairman',
                mode: 'ANY_OF',
                roleKeys: ['chairman'],
                userIds: [],
                requiredCount: null,
              },
            ],
    } as never,
    { where: { societyId, name: 'Auto' } },
  );
}

// ------------------------------------------------------------------ 16.2 helpers (resident notices, bell, preferences, push)

/** A society with towers A and B and signed-in residents: `a1` owns A-101, `fam` is family in A-101, `b1` owns B-101, `a2` owns A-201. */
export async function residentsWorld() {
  await resetHelpdesk();
  await resetCommunication();
  const w = await helpdeskWorld('PREMIUM');
  const mk = async (unitId: number, name: string, relation?: 'OWNER' | 'TENANT' | 'FAMILY') => {
    const r = await residentUser(w.society, unitId, { name, ...(relation ? { relation } : {}) });
    return { userId: r.user.id, c: r.c };
  };
  return {
    ...w,
    a1: await mk(w.a101, 'Alok Owner'),
    fam: await mk(w.a101, 'Fiona Family', 'FAMILY'),
    b1: await mk(w.b101, 'Bina Owner'),
    a2: await mk(w.a201, 'Chetan Owner'),
    login,
    as,
  };
}

let noticeN = 0;
/** A PUBLISHED notice written straight to the table (16.1 owns the real publish path). */
export async function makeNotice(societyId: number, o: Record<string, unknown> = {}): Promise<Notice> {
  noticeN += 1;
  const title = (o.title as string | undefined) ?? `Notice ${noticeN}`;
  return Notice.create({
    societyId,
    title,
    body: `<p>${title} body text</p>`,
    bodyText: `${title} body text`,
    status: 'PUBLISHED',
    publishedAt: new Date('2026-11-01T04:00:00Z'),
    audienceType: 'ALL',
    audienceRelation: 'ANY',
    audienceIds: null,
    audienceRoleKeys: null,
    ...o,
  } as never);
}
export const makeReceipt = (
  n: Notice,
  userId: number,
  unitId: number | null,
  o: Record<string, unknown> = {},
) =>
  NoticeReceipt.create({
    societyId: n.societyId,
    noticeId: n.id,
    recipientKey: `u:${userId}:${unitId ?? 0}`,
    userId,
    unitId,
    relation: unitId ? 'OWNER' : 'MEMBER',
    ...o,
  } as never);

// ------------------------------------------------------------------ part 16.3 world (emergency and surveys)
export { idem };
export type Client = ReturnType<typeof as>;

/**
 * A society with two towers, four flats and signed-in clients: chairman, secretary, treasurer (view only), accountant (nothing), residents of A-101 (owner and family),
 * A-102, B-101 and a guard. Sign-ins are slow (several seconds each): build it once per file in `beforeAll`.
 */
export async function commWorld(plan: 'STARTER' | 'STANDARD' | 'PREMIUM' = 'PREMIUM') {
  await resetSetup();
  setResidentPorts();
  registerResidents();
  await resetCommunication();
  const { society, c, user } = await setupSociety({ plan, name: 'Chair' });
  const sid = society.id!;
  const a = await makeBuilding(c, { code: 'A' });
  const b = await makeBuilding(c, { code: 'B' });
  const a101 = await makeUnit(c, a.id, '101', 1);
  const a102 = await makeUnit(c, a.id, '102', 1);
  const a201 = await makeUnit(c, a.id, '201', 2);
  const b101 = await makeUnit(c, b.id, '101', 1);
  const own = await residentUser(society, a101.id, { name: 'Alok Owner' });
  const fam = await residentUser(society, a101.id, { relation: 'FAMILY', name: 'Fiona Family' });
  const own2 = await residentUser(society, a102.id, { name: 'Anita Owner' });
  const ownB = await residentUser(society, b101.id, { name: 'Bina Owner' });
  const own3 = await residentUser(society, a201.id, { name: 'Amit Owner' });
  const sec = await memberOf(society, 'secretary');
  const tre = await memberOf(society, 'treasurer');
  const acc = await memberOf(society, 'accountant');
  const guardUser = await memberUser(society, 'guard', { name: 'Gopal Guard' });
  return {
    society,
    sid,
    chair: c,
    chairId: user.id,
    sec: sec.c,
    secId: sec.user.id,
    tre: tre.c,
    acc: acc.c,
    guard: as(await login(guardUser, { app: 'GATE', societyId: sid }), 'GATE'),
    guardId: guardUser.id,
    a: { id: a.id },
    b: { id: b.id },
    a101: a101.id,
    a102: a102.id,
    a201: a201.id,
    b101: b101.id,
    own: own.c,
    ownId: own.user.id,
    fam: fam.c,
    famId: fam.user.id,
    own2: own2.c,
    own2Id: own2.user.id,
    ownB: ownB.c,
    ownBId: ownB.user.id,
    own3: own3.c,
    own3Id: own3.user.id,
  };
}
export type CommWorld = Awaited<ReturnType<typeof commWorld>>;
