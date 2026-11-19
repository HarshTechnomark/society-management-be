import { UnprocessableError } from '../../utils/errors';
import { members } from '../access-control/access-control.public';
import { residents } from '../residents/residents.public';
import { units } from '../society-setup/society-setup.public';
import { ERR, LIMITS, type AudienceRelation, type AudienceType } from './communication.constants';
import type { AudiencePerson, NoticeAudience, ResolvedAudience } from './communication.types';

/** Audience resolution of BR-16-3 / BR-16-4, shared by notices (16.1), surveys (16.3) and emergency (16.3). */

const sortedUnique = (a: number[]): number[] => [...new Set(a)].sort((x, y) => x - y);

/**
 * PURE: validates the shape of an audience (BR-16-3) and returns the stored form: sorted unique ids, `relation` forced to `ANY` for ROLES,
 * ids only for BUILDINGS / UNITS, role keys only for ROLES. Throws `422 NOTICE_AUDIENCE_INVALID` (`errorCode` lets surveys use their own code).
 */
export function normaliseAudience(
  a: NoticeAudience,
  opts: { allowRoles?: boolean; errorCode?: string } = {},
): { type: AudienceType; relation: AudienceRelation; ids: number[] | null; roleKeys: string[] | null } {
  const code = opts.errorCode ?? ERR.noticeAudienceInvalid;
  const bad = (field: string, message: string) => new UnprocessableError(code, message, [{ field, message }]);
  const relation: AudienceRelation = a.relation ?? 'ANY';
  if (a.type === 'ROLES') {
    if (opts.allowRoles === false) throw bad('type', 'Roles are not allowed here');
    const keys = [...new Set(a.roleKeys ?? [])].sort();
    if (keys.length < 1 || keys.length > LIMITS.audienceRolesMax)
      throw bad('roleKeys', `Choose 1 to ${LIMITS.audienceRolesMax} roles`);
    if (relation !== 'ANY') throw bad('relation', 'Relation must be ANY for roles');
    return { type: 'ROLES', relation: 'ANY', ids: null, roleKeys: keys };
  }
  if (a.type === 'ALL') {
    if (a.ids?.length || a.roleKeys?.length) throw bad('ids', 'ALL takes no ids');
    return { type: 'ALL', relation, ids: null, roleKeys: null };
  }
  const max = a.type === 'BUILDINGS' ? LIMITS.audienceBuildingsMax : LIMITS.audienceUnitsMax;
  const ids = sortedUnique(a.ids ?? []);
  if (ids.length < 1 || ids.length > max) throw bad('ids', `Choose 1 to ${max} ${a.type.toLowerCase()}`);
  if (ids.some(i => !Number.isInteger(i) || i < 1)) throw bad('ids', 'Ids must be positive integers');
  return { type: a.type, relation, ids, roleKeys: null };
}

/** Short label for approval facts and receipts (`All residents`, `2 buildings`, `Owners of 3 flats` ...). */
export function audienceLabel(a: NoticeAudience): string {
  const who = a.relation === 'OWNERS' ? 'Owners' : a.relation === 'TENANTS' ? 'Tenants' : 'All residents';
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (a.type === 'ALL') return who;
  if (a.type === 'BUILDINGS') return `${who} of ${plural(a.ids?.length ?? 0, 'building')}`;
  if (a.type === 'UNITS') return `${who} of ${plural(a.ids?.length ?? 0, 'flat')}`;
  return plural(a.roleKeys?.length ?? 0, 'role');
}

/** PURE: does a link match the relation filter (BR-16-3: OWNERS = links with no tenancy, TENANTS = links of a tenancy)? */
export const relationMatches = (relation: AudienceRelation, tenancyId: number | null): boolean =>
  relation === 'ANY' || (relation === 'OWNERS' ? tenancyId === null : tenancyId !== null);

async function mapLimit<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

/** The units of a flat audience (`ALL`, `BUILDINGS`, `UNITS`): active units only. */
export async function audienceUnitIds(societyId: number, a: NoticeAudience): Promise<number[]> {
  if (a.type === 'ROLES') return [];
  if (a.type === 'UNITS') return (await units.listActive(societyId, { unitIds: a.ids ?? [] })).map(u => u.id);
  if (a.type === 'BUILDINGS') {
    const lists = await Promise.all(
      (a.ids ?? []).map(buildingId => units.listActive(societyId, { buildingId })),
    );
    return lists.flat().map(u => u.id);
  }
  return (await units.listActive(societyId, {})).map(u => u.id);
}

/**
 * Resolves who a notice or survey reaches today (BR-16-4 snapshot). One person per flat link: residents with a login have `userId`, others only
 * `residentId` + `mobile`. ROLES resolves to active members of those roles (`relation = 'MEMBER'`, no flat). Lookups use module 09
 * `residents.listForUnit` with concurrency 10.
 */
export async function resolveAudience(societyId: number, a: NoticeAudience): Promise<ResolvedAudience> {
  const people: AudiencePerson[] = [];
  if (a.type === 'ROLES') {
    const rows = await members.listForSociety(societyId, {
      roleKeys: a.roleKeys ?? [],
      statuses: ['ACTIVE'],
    });
    for (const m of rows)
      people.push({ userId: m.userId, residentId: null, unitId: null, relation: 'MEMBER', mobile: null });
    const userIds = [...new Set(rows.map(m => m.userId))];
    return { people, unitIds: [], userIds };
  }
  const unitIds = await audienceUnitIds(societyId, a);
  const relation = a.relation ?? 'ANY';
  const perUnit = await mapLimit(unitIds, 10, async unitId => ({
    unitId,
    links: await residents.listForUnit(societyId, unitId),
  }));
  const touched = new Set<number>();
  for (const { unitId, links } of perUnit)
    for (const l of links) {
      if (!relationMatches(relation, l.tenancyId)) continue;
      touched.add(unitId);
      people.push({
        userId: l.userId && l.canLogin ? l.userId : null,
        residentId: l.residentId,
        unitId,
        relation: l.relation,
        mobile: l.mobile,
      });
    }
  const userIds = [...new Set(people.filter(p => p.userId).map(p => p.userId!))];
  return { people, unitIds: [...touched].sort((x, y) => x - y), userIds };
}
