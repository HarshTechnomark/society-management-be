import { QueryTypes } from 'sequelize';
import { Society, Ticket, TicketCategory, sequelize } from '../../src/models';
import { setNow } from '../../src/lib/clock';
import { registerResidents } from '../../src/modules/residents/residents.public';
import { setResidentPorts } from '../../src/modules/residents/residents.ports';
import { placeholderFiles } from '../../src/modules/societies/societies.ports';
import { helpdeskPortCalls, setHelpdeskPorts } from '../../src/modules/helpdesk/helpdesk.ports';
import { ensureSeeded } from '../../src/modules/helpdesk/helpdesk.seed';
import { clearTicketListeners } from '../../src/modules/helpdesk/helpdesk.shared';
import type { Ctx } from '../../src/types/context';
import { systemCtx } from '../../src/types/context';
import { makeUser } from './auth';
import { as, login, memberUser } from './access';
import { subSociety } from './subscriptions';
import { residentUser } from './residents';
import { makeBuilding, makeUnit, resetSetup, setupSociety } from './society-setup';

/** Fresh state for module 15 tests: setup reset, placeholder ports, clock frozen at 2026-11-01 10:00 IST. Call from `beforeEach`. */
export async function resetHelpdesk(): Promise<void> {
  await resetSetup();
  setHelpdeskPorts();
  clearTicketListeners();
  setResidentPorts();
  registerResidents(); // the resident app's unit links (`ctx.unitIds`) come from module 09
  placeholderFiles.clear();
  setNow('2026-11-01T04:30:00Z');
}

export const hctx = (
  society: Society,
  userId: number | null,
  o: { unitIds?: number[]; name?: string; roleKey?: string } = {},
): Ctx => ({
  ...systemCtx('t'),
  ...(userId
    ? {
        user: {
          id: userId,
          name: o.name ?? 'Tester',
          mobile: null,
          email: null,
          platformRoleId: null,
          status: 'ACTIVE',
        },
        actorRoleKey: o.roleKey ?? 'chairman',
      }
    : {}),
  society: {
    id: society.id!,
    name: society.name,
    status: society.status as string,
    timezone: 'Asia/Kolkata',
    planKey: 'PREMIUM',
  },
  permissions: new Set<string>(),
  unitIds: o.unitIds ?? [],
});

export interface HelpdeskWorld {
  society: Society;
  sid: number;
  admin: Ctx;
  adminId: number;
  /** Sign-in identities for HTTP tests (additive, part 15.2). */
  adminUser: Awaited<ReturnType<typeof setupSociety>>['user'];
  fmUser: Awaited<ReturnType<typeof memberUser>>;
  buildingA: { id: number; locationNodeId: number };
  buildingB: { id: number; locationNodeId: number };
  a101: number;
  a201: number;
  b101: number;
  /** A resident of A-101 (unitIds [A-101]). */
  resident: Ctx;
  residentId: number;
  /** A facility manager member. */
  fm: { id: number; ctx: Ctx };
  cat: (name: string) => Promise<TicketCategory>;
  sub: (parent: string, name: string) => Promise<TicketCategory>;
  resident2: (unitIds: number[]) => Promise<{ id: number; ctx: Ctx }>;
}

/** A seeded helpdesk society with two towers, three flats, a chairman, a facility manager and a resident. */
export async function helpdeskWorld(
  plan: 'STARTER' | 'STANDARD' | 'PREMIUM' = 'PREMIUM',
): Promise<HelpdeskWorld> {
  const { society, c, user } = await setupSociety({ plan, name: 'Helpdesk CHS' });
  const sid = society.id!;
  const a = await makeBuilding(c, { code: 'A' });
  const b = await makeBuilding(c, { code: 'B' });
  const a101 = await makeUnit(c, a.id, '101', 1);
  const a201 = await makeUnit(c, a.id, '201', 2);
  const b101 = await makeUnit(c, b.id, '101', 1);
  await sequelize.transaction(t => ensureSeeded(sid, t));
  const res = await makeUser({ name: 'Rita Resident' });
  const fmUser = await memberUser(society, 'facility_manager', { name: 'Farhan FM' });
  const cat = async (name: string) =>
    (await TicketCategory.findOne({ where: { societyId: sid, name, parentId: null } }))!;
  const world: HelpdeskWorld = {
    society,
    sid,
    admin: hctx(society, user.id, { name: 'Chair' }),
    adminId: user.id,
    adminUser: user,
    fmUser,
    buildingA: { id: a.id, locationNodeId: a.locationNodeId },
    buildingB: { id: b.id, locationNodeId: b.locationNodeId },
    a101: a101.id,
    a201: a201.id,
    b101: b101.id,
    resident: hctx(society, res.id, { unitIds: [a101.id], name: 'Rita Resident', roleKey: 'owner' }),
    residentId: res.id,
    fm: { id: fmUser.id, ctx: hctx(society, fmUser.id, { name: 'Farhan FM', roleKey: 'facility_manager' }) },
    cat,
    sub: async (parent, name) =>
      (await TicketCategory.findOne({ where: { societyId: sid, name, parentId: (await cat(parent)).id } }))!,
    resident2: async unitIds => {
      const u = await makeUser({ name: `Resident ${unitIds.join('-')}` });
      return { id: u.id, ctx: hctx(society, u.id, { unitIds, roleKey: 'owner' }) };
    },
  };
  return world;
}

/** A clean placeholder file of the ticket photo purpose owned by `ownerUserId`. */
let fileId = 7000;
export function ticketPhoto(
  societyId: number,
  ownerUserId: number,
  purpose: 'TICKET_PHOTO' | 'TICKET_ATTACHMENT' = 'TICKET_PHOTO',
): number {
  fileId += 1;
  placeholderFiles.set(fileId, {
    fileId,
    societyId,
    purpose,
    name: `p${fileId}.jpg`,
    contentType: 'image/jpeg',
    content: Buffer.from('x'),
    ownerUserId,
    status: 'CLEAN',
  } as never);
  return fileId;
}

export const ticketRow = (id: number) => Ticket.findByPk(id).then(t => t!);
export const count = async (table: string, societyId: number, where = '1=1'): Promise<number> =>
  Number(
    (
      await sequelize.query<{ n: number }>(
        `SELECT COUNT(*) AS n FROM ${table} WHERE societyId = ? AND ${where}`,
        { replacements: [societyId], type: QueryTypes.SELECT },
      )
    )[0]!.n,
  );

/** A society of `plan` with one signed-in member per role (part 15.1 route tests): `api(roleKey, app?)` returns the authenticated caller. */
export async function helpdeskApiWorld(
  plan: 'STARTER' | 'STANDARD' | 'PREMIUM' = 'PREMIUM',
  roles: string[] = ['chairman', 'facility_manager', 'accountant', 'treasurer'],
  o: { reset?: boolean } = {},
) {
  if (o.reset !== false) await resetHelpdesk();
  const { society } = await subSociety({ plan, flats: 10 });
  const people: Record<string, Awaited<ReturnType<typeof memberUser>>> = {};
  for (const r of roles) people[r] = await memberUser(society, r, { name: r });
  const api = async (roleKey: string, app: 'ADMIN' | 'RESIDENT' | 'GATE' | 'WORK' = 'ADMIN') =>
    as(await login(people[roleKey]!, { societyId: society.id!, app }), app);
  return { society, sid: society.id!, people, api };
}

// ---- part 15.4 helpers (jobs, notifications, realtime)
export interface SentNotification {
  template: string;
  userIds: number[];
  data: Record<string, unknown>;
}
/** Every `notifications.send` the placeholder port received, in order. */
export function sentNotifications(template?: string): SentNotification[] {
  return helpdeskPortCalls
    .filter(c => c.fn === 'notifications.send')
    .map(c => c.input as SentNotification)
    .filter(n => !template || n.template === template);
}
// ------------------------------------------------------------------ HTTP clients (15.3)
export type Client = ReturnType<typeof as>;

export interface HelpdeskHttp extends HelpdeskWorld {
  /** Signed-in clients (real sessions). Owner of A-101 (resident app). */
  res: Client;
  resUserId: number;
  /** Family member of A-101. */
  fam: Client;
  famUserId: number;
  /** Owner of B-101. */
  resB: Client;
  resBUserId: number;
  /** Owner of A-201. */
  resC: Client;
  resCUserId: number;
  guard: Client;
  staff: Client;
}

/**
 * `helpdeskWorld` plus signed-in clients of residents (A-101 owner and family member, B-101 and A-201 owners), a guard (gate app) and a maintenance staff member
 * (work app). Sign-ins add ~15 seconds; use only in tests that call routes.
 */
export async function helpdeskHttp(
  plan: 'STARTER' | 'STANDARD' | 'PREMIUM' = 'PREMIUM',
): Promise<HelpdeskHttp> {
  const w = await helpdeskWorld(plan);
  const a = await residentUser(w.society, w.a101, { name: 'Alok Owner' });
  const f = await residentUser(w.society, w.a101, { relation: 'FAMILY', name: 'Fiona Family' });
  const b = await residentUser(w.society, w.b101, { name: 'Bina Owner' });
  const c = await residentUser(w.society, w.a201, { name: 'Chetan Owner' });
  const guardUser = await memberUser(w.society, 'guard', { name: 'Gopal Guard' });
  const staffUser = await memberUser(w.society, 'maintenance_staff', { name: 'Mohan Staff' });
  return {
    ...w,
    res: a.c,
    resUserId: a.user.id,
    fam: f.c,
    famUserId: f.user.id,
    resB: b.c,
    resBUserId: b.user.id,
    resC: c.c,
    resCUserId: c.user.id,
    guard: as(await login(guardUser, { app: 'GATE', societyId: w.sid }), 'GATE'),
    staff: as(await login(staffUser, { app: 'WORK', societyId: w.sid }), 'WORK'),
  };
}

export { idem } from './access';
