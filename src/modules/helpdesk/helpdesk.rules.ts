import { UnprocessableError } from '../../utils/errors';
import {
  ERR,
  PRIORITIES,
  URGENCY_PRIORITY,
  type AffectedLevel,
  type CategoryScope,
  type DefaultAssigneeType,
  type Priority,
  type PrioritySource,
  type ReporterRole,
  type TicketKind,
  type Urgency,
} from './helpdesk.constants';
import type { EffectiveCategory } from './helpdesk.types';

/** Pure business rules of section 5.1 and 5.5 (no database). */

/** The fields of a module 08 location node the rules read. */
export interface NodeFacts {
  nodeType: string; // 'BUILDING' | 'FLOOR' | 'AREA' | ...
  areaType?: string | null;
  buildingId: number | null;
  floor: number | null;
}

/** BR-15-4: the default affected level of a node. */
export function deriveAffectedLevel(n: NodeFacts): AffectedLevel {
  if (n.nodeType === 'BUILDING') return 'BUILDING';
  if (n.nodeType === 'FLOOR') return 'FLOOR';
  if (n.nodeType === 'AREA') {
    if (n.areaType === 'CORRIDOR' && n.floor !== null && n.floor !== undefined && n.buildingId)
      return 'FLOOR';
    if (n.buildingId) return 'BUILDING';
  }
  return 'SOCIETY';
}

/** BR-15-4: SOCIETY always; BUILDING with a building; FLOOR with a building and a floor. */
export function allowedLevel(level: AffectedLevel, n: NodeFacts): boolean {
  if (level === 'SOCIETY') return true;
  if (level === 'BUILDING') return Boolean(n.buildingId);
  return Boolean(n.buildingId) && n.floor !== null && n.floor !== undefined;
}

/** BR-15-4: the chosen (or default) level with its building and floor copied from the node; `422 AFFECTED_LEVEL_INVALID` when not possible. */
export function resolveAffected(
  requested: AffectedLevel | null | undefined,
  n: NodeFacts,
): { level: AffectedLevel; buildingId: number | null; floor: number | null } {
  const level = requested ?? deriveAffectedLevel(n);
  if (!allowedLevel(level, n))
    throw new UnprocessableError(ERR.affectedLevelInvalid, 'That level is not possible for this location', [
      { field: 'affectedLevel', message: `${level} does not fit the location` },
    ]);
  return {
    level,
    buildingId: level === 'SOCIETY' ? null : n.buildingId,
    floor: level === 'FLOOR' ? n.floor : null,
  };
}

const rank = (p: Priority): number => PRIORITIES.indexOf(p);
/** One level more urgent (P4 to P3 ... P1 stays P1). */
export const raisePriority = (p: Priority): Priority => PRIORITIES[Math.max(0, rank(p) - 1)]!;

/**
 * BR-15-8: effective priority = the more urgent of the category default and the reporter's urgency; `REPORTER` when the urgency won, else
 * `CATEGORY`. An admin priority overrides both (`ADMIN`). A tie is `CATEGORY`.
 */
export function effectivePriority(
  categoryDefault: Priority,
  urgency: Urgency | undefined,
  adminPriority?: Priority,
): { priority: Priority; source: PrioritySource } {
  if (adminPriority) return { priority: adminPriority, source: 'ADMIN' };
  if (!urgency) return { priority: categoryDefault, source: 'CATEGORY' };
  const fromUrgency = URGENCY_PRIORITY[urgency];
  return rank(fromUrgency) < rank(categoryDefault)
    ? { priority: fromUrgency, source: 'REPORTER' }
    : { priority: categoryDefault, source: 'CATEGORY' };
}

/** BR-15-8: EMERGENCY only on building issues for residents. */
export function assertUrgencyAllowed(
  kind: TicketKind,
  urgency: Urgency | undefined,
  isResident: boolean,
): void {
  if (isResident && kind === 'PERSONAL' && urgency === 'EMERGENCY')
    throw new UnprocessableError(ERR.urgencyNotAllowed, 'Emergency is for building issues only', [
      { field: 'urgency', message: 'Use URGENT for a problem inside your flat' },
    ]);
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** BR-15-9: derived title for a building issue without one: `<sub-category or category> – <pathLabel>` cut to 150. */
export function defaultTitle(name: string, pathLabel: string): string {
  return `${name} – ${pathLabel}`.slice(0, 150);
}
export const validTitle = (t: string): boolean => {
  const s = t.trim();
  return s.length >= 5 && s.length <= 150 && !CONTROL.test(s);
};

/** Category fields as stored (the sub-category row may leave values NULL or INHERIT). */
export interface CategoryRow {
  id: number;
  name: string;
  scope: CategoryScope;
  defaultPriority: Priority | null;
  slaPolicyId: number | null;
  defaultAssigneeType: DefaultAssigneeType;
  defaultRoleKey: string | null;
  defaultAssigneeUserId: number | null;
  defaultStaffId: number | null;
  defaultVendorId: number | null;
  isChargeable: boolean;
  requiresAfterPhoto: boolean;
  isSafety: boolean;
  linksInvoice: boolean;
}

/** BR-15-7: a NULL (or INHERIT) sub-category field takes the parent's; the four flags are true when either has them. Scope is the sub-category's own. */
export function mergeCategory(parent: CategoryRow, sub?: CategoryRow | null): EffectiveCategory {
  const inherit = !sub || sub.defaultAssigneeType === 'INHERIT';
  const src = inherit ? parent : sub;
  return {
    categoryId: parent.id,
    subCategoryId: sub?.id ?? null,
    categoryName: parent.name,
    subCategoryName: sub?.name ?? null,
    scope: sub?.scope ?? parent.scope,
    defaultPriority: sub?.defaultPriority ?? parent.defaultPriority ?? 'P3',
    slaPolicyId: sub?.slaPolicyId ?? parent.slaPolicyId,
    defaultAssigneeType: src.defaultAssigneeType as EffectiveCategory['defaultAssigneeType'],
    defaultRoleKey: src.defaultRoleKey,
    defaultAssigneeUserId: src.defaultAssigneeUserId,
    defaultStaffId: src.defaultStaffId,
    defaultVendorId: src.defaultVendorId,
    isChargeable: parent.isChargeable || Boolean(sub?.isChargeable),
    requiresAfterPhoto: parent.requiresAfterPhoto || Boolean(sub?.requiresAfterPhoto),
    isSafety: parent.isSafety || Boolean(sub?.isSafety),
    linksInvoice: parent.linksInvoice || Boolean(sub?.linksInvoice),
  };
}

/** BR-15-6: the effective scope must include the kind. */
export const scopeFits = (scope: CategoryScope, kind: TicketKind): boolean =>
  scope === 'BOTH' || scope === kind;

/** BR-15-15: the reporter role snapshot. */
export function reporterRoleFor(
  audience: 'RESIDENT' | 'GATE' | 'WORK' | 'ADMIN',
  seated: boolean,
): ReporterRole {
  if (audience === 'RESIDENT') return 'RESIDENT';
  if (audience === 'GATE') return 'GUARD';
  if (audience === 'WORK') return 'STAFF';
  return seated ? 'COMMITTEE' : 'OFFICE';
}

/** BR-15-49: how a building issue's reporter shows to residents other than the requester. */
export function reporterLabel(role: ReporterRole, showReporter: boolean, unitLabel: string | null): string {
  switch (role) {
    case 'RESIDENT':
      return showReporter && unitLabel ? `Resident, ${unitLabel}` : 'A resident';
    case 'GUARD':
      return 'Security';
    case 'STAFF':
      return 'Maintenance staff';
    case 'COMMITTEE':
      return 'Committee';
    default:
      return 'Society office';
  }
}

/** BR-15-38: the priority a ticket gets when its upvotes reach the threshold, or null when no raise applies. */
export function upvoteRaise(t: {
  upvoteCount: number;
  priority: Priority;
  priorityAutoRaisedAt: Date | null;
  threshold: number;
  featureOn: boolean;
}): Priority | null {
  if (!t.featureOn || t.priorityAutoRaisedAt || t.priority === 'P1' || t.upvoteCount < t.threshold)
    return null;
  return raisePriority(t.priority);
}
