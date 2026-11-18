import type { Society } from '../../src/models';
import { setNow } from '../../src/lib/clock';
import { registerApprovals } from '../../src/modules/approvals/approvals.public';
import { setApprovalsPorts } from '../../src/modules/approvals/approvals.ports';
import { resetRegistry } from '../../src/modules/approvals/approvals.registry';
import { request } from '../../src/modules/approvals/approvals.engine';
import { CATALOGUE } from '../../src/modules/approvals/approvals.catalogue';
import { sequelize } from '../../src/models';
import { systemCtx, type Ctx } from '../../src/types/context';
import { as, idem, login, memberUser } from './access';
import { makeUser, type TestUser } from './auth';
import { registerTestTypes } from './approvals';
import { resetSubs, subSociety } from './subscriptions';

export { idem };

export const CONFIG_ROLES = [
  'chairman',
  'secretary',
  'treasurer',
  'committee_member',
  'society_admin',
  'accountant',
  'facility_manager',
  'auditor',
] as const;
type Person = TestUser & { memberId: number };

/** A society with one member per role (plan `plan`, default STANDARD), module 14 registered, test handlers for common types. */
export async function configWorld(o: { plan?: 'STARTER' | 'STANDARD' | 'PREMIUM'; roles?: string[] } = {}) {
  await resetSubs();
  setApprovalsPorts();
  resetRegistry();
  registerApprovals();
  setNow('2026-11-10T05:00:00Z');
  await makeUser({ status: 'SYSTEM', email: 'system@societyapp.in', password: null, name: 'System' });
  const { society } = await subSociety({ plan: o.plan ?? 'STANDARD', flats: 50 });
  const people: Record<string, Person> = {};
  for (const roleKey of o.roles ?? CONFIG_ROLES)
    people[roleKey] = await memberUser(society, roleKey, { name: roleKey });
  registerTestTypes(['EXPENSE', 'NOTICE_PUBLISH', 'OFFLINE_PAYMENT', 'MOVE_IN']);
  const api = async (roleKey: string, s: Society = society) =>
    as(await login(people[roleKey]!, { societyId: s.id! }));
  const ctxOf = (roleKey: string, s: Society = society): Ctx => ({
    ...systemCtx('test'),
    user: {
      id: people[roleKey]!.id,
      name: roleKey,
      mobile: null,
      email: null,
      platformRoleId: null,
      status: 'ACTIVE',
    },
    actorRoleKey: roleKey,
    society: { id: s.id!, name: s.name, status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: 'STANDARD' },
    permissions: new Set(),
  });
  const raise = (roleKey: string, input: { type: string; entityId: number; amountPaise?: number }) =>
    sequelize.transaction(t =>
      request(
        ctxOf(roleKey),
        {
          entityType: CATALOGUE[input.type]!.entityType,
          title: 'Test item',
          payload: {},
          amountPaise: 0,
          ...input,
        } as never,
        t,
      ),
    );
  return { society, people, api, ctxOf, raise };
}
export type ConfigWorld = Awaited<ReturnType<typeof configWorld>>;

/** A step of a custom rule. */
export const step = (o: Partial<Record<string, unknown>> = {}) => ({
  stepNo: 1,
  name: 'Treasurer review',
  mode: 'ANY_OF',
  roleKeys: ['treasurer'],
  userIds: [],
  requiredCount: null,
  ...o,
});
export const ruleBody = (o: Record<string, unknown> = {}) => ({
  type: 'EXPENSE',
  name: 'Custom expense rule',
  priority: 15,
  action: 'REQUIRE_APPROVAL',
  steps: [step()],
  ...o,
});
