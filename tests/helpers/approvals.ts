import type { Transaction } from 'sequelize';
import { Society, sequelize } from '../../src/models';
import { now, setNow } from '../../src/lib/clock';
import { drainQueues } from '../../src/lib/queue';
import { systemCtx, type Ctx } from '../../src/types/context';
import { registerApprovals } from '../../src/modules/approvals/approvals.public';
import { resetRegistry, registerType } from '../../src/modules/approvals/approvals.registry';
import { setApprovalsPorts } from '../../src/modules/approvals/approvals.ports';
import type { ApprovalCtx, ApprovalRequestView } from '../../src/modules/approvals/approvals.types';
import { request } from '../../src/modules/approvals/approvals.engine';
import { events, makeUser, resetAll } from './auth';
import { makeSociety, memberUser } from './access';
import { registerAccessControl, syncCatalogue } from '../../src/modules/access-control/access-control.public';

export { events };

/** One call a test handler received. */
export interface HandlerCall {
  fn: string;
  type: string;
  entityId: number;
  inTx: boolean;
  decision?: string;
  reason?: string | null;
  actor?: number | null;
  onBehalf?: number | null;
}
export const handlerCalls: HandlerCall[] = [];
export const failNext = { error: null as Error | null };

/** Registers recording handlers for these types (all optional hooks on, `onCancelled` only when asked). */
export function registerTestTypes(types: string[], o: { cancel?: string[]; expire?: string[] } = {}): void {
  for (const type of types) {
    const rec =
      (fn: string) =>
      async (ctx: ApprovalCtx, req: ApprovalRequestView, t: Transaction): Promise<void> => {
        handlerCalls.push({
          fn,
          type,
          entityId: req.entityId,
          inTx: Boolean(t),
          decision: ctx.approval.decision,
          reason: ctx.approval.reason,
          actor: ctx.approval.actorUserId,
          onBehalf: ctx.approval.onBehalfOfUserId,
        });
        if (failNext.error && fn === 'onApproved') {
          const e = failNext.error;
          failNext.error = null;
          throw e;
        }
      };
    registerType(type, {
      onApproved: rec('onApproved'),
      onRejected: rec('onRejected'),
      onChangesRequested: rec('onChangesRequested'),
      ...(o.cancel?.includes(type) ? { onCancelled: rec('onCancelled') } : {}),
      ...(o.expire?.includes(type) ? { onExpired: rec('onExpired') } : {}),
      describe: () => ({ facts: [], link: null }),
    });
  }
}

export interface Person {
  id: number;
  name: string;
  roleKey: string;
}
export interface ApprovalsWorld {
  society: Society;
  people: Record<string, Person>;
  /** The same members as signed-in capable users (for HTTP tests). */
  users: Record<string, Awaited<ReturnType<typeof memberUser>>>;
  /** Context of a person; `authAgeMinutes` is how long ago they authenticated. */
  ctx(p: Person, authAgeMinutes?: number): Ctx;
  /** Raise a request as `p` inside its own transaction. */
  raise(
    p: Person | null,
    input: Partial<Parameters<typeof request>[1]> & { type: string; entityId: number },
  ): ReturnType<typeof request>;
}

export const ROLES = [
  'chairman',
  'secretary',
  'treasurer',
  'accountant',
  'society_admin',
  'facility_manager',
  'committee_member',
];

/** Fresh state plus a society with one member per role; handlers recorded for the common types. Call from `beforeEach`. */
export async function approvalsWorld(
  o: { roles?: string[]; types?: string[] } = {},
): Promise<ApprovalsWorld> {
  await resetAll();
  registerAccessControl();
  await syncCatalogue();
  setApprovalsPorts();
  resetRegistry();
  registerApprovals();
  handlerCalls.length = 0;
  failNext.error = null;
  setNow('2026-11-10T05:00:00Z');
  await makeUser({ status: 'SYSTEM', email: 'system@societyapp.in', password: null, name: 'System' });
  const society = await makeSociety();
  const people: Record<string, Person> = {};
  const users: ApprovalsWorld['users'] = {};
  for (const roleKey of o.roles ?? ROLES) {
    const u = await memberUser(society, roleKey, { name: roleKey });
    people[roleKey] = { id: u.id, name: roleKey, roleKey };
    users[roleKey] = u;
  }
  registerTestTypes(
    o.types ?? ['EXPENSE', 'NOTICE_PUBLISH', 'PERIOD_UNLOCK', 'BOOKING', 'MOVE_IN', 'OFFLINE_PAYMENT'],
    {
      cancel: ['EXPENSE'],
      expire: ['BOOKING'],
    },
  );
  const ctx = (p: Person, authAgeMinutes = 0): Ctx => ({
    requestId: 'test',
    ip: '127.0.0.1',
    userAgent: 'vitest',
    user: { id: p.id, name: p.name, mobile: null, email: null, platformRoleId: null, status: 'ACTIVE' },
    society: {
      id: society.id!,
      name: society.name,
      status: 'ACTIVE',
      timezone: 'Asia/Kolkata',
      planKey: 'STANDARD',
    },
    membership: {
      id: 1,
      roleId: 1,
      roleKey: p.roleKey,
      roleScope: 'society',
      status: 'ACTIVE',
      requiresMfa: false,
    },
    actorRoleKey: p.roleKey,
    permissions: new Set(),
    platformPermissions: new Set(),
    unitIds: [],
    unitLinks: [],
    session: {
      id: 1,
      authTime: new Date(now().getTime() - authAgeMinutes * 60_000),
      clientApp: 'ADMIN',
      activeSocietyId: society.id!,
      mfaVerified: true,
      amr: ['pwd', 'otp'] as never,
      supportGrantId: null,
      idleTimeoutMinutes: 30,
      absoluteExpiresAt: new Date(now().getTime() + 86_400_000),
    },
  });
  const sysCtx = (): Ctx => ({
    ...systemCtx('test'),
    society: {
      id: society.id!,
      name: society.name,
      status: 'ACTIVE',
      timezone: 'Asia/Kolkata',
      planKey: 'STANDARD',
    },
  });
  return {
    society,
    people,
    users,
    ctx,
    raise: (p, input) =>
      sequelize.transaction(t =>
        request(
          p ? ctx(p) : sysCtx(),
          { entityType: entityTypeOf(input.type), title: 'Test item', payload: {}, ...input } as never,
          t,
        ),
      ),
  };
}

import { CATALOGUE } from '../../src/modules/approvals/approvals.catalogue';
const entityTypeOf = (type: string): string => CATALOGUE[type]?.entityType ?? 'unknown';

export const settle = (): Promise<void> => drainQueues();
