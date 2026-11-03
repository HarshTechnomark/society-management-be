import type { Transaction } from 'sequelize';
import { Resident, UnitResident } from '../../models';
import { emitToUser } from '../../lib/realtime';
import { audit } from '../../utils/audit';
import {
  endResidentMember,
  ensureResidentMember,
  invalidateMember,
  members,
  setResidentRole,
} from '../access-control/access-control.public';
import type { Ctx } from '../../types/context';
import { residentNotFound, societyToday, strongestRelation, activeOn } from './residents.shared';

/**
 * Membership sync (section 6.2, BR-09-18, BR-09-78). Runs inside the caller's transaction after every link change and from
 * the daily `residents:sync-links` job. A member whose module 03 role scope is not `resident` (a chairman who owns a flat)
 * keeps the role and the membership; only the unit links change.
 */
const pending = new WeakMap<Transaction, Map<string, { societyId: number; userId: number }>>();

/** One `invalidateMember` and one `access.changed` per user and transaction, after commit. */
function afterCommitAccess(t: Transaction, societyId: number, userId: number): void {
  let m = pending.get(t);
  if (!m) {
    m = new Map();
    pending.set(t, m);
    const batch = m;
    t.afterCommit(async () => {
      for (const { societyId: s, userId: u } of batch.values()) {
        try {
          await invalidateMember(s, u);
        } catch {
          /* the cache expires on its own; the sync must not fail after commit */
        }
        emitToUser(u, 'access.changed', { societyId: s, reason: 'UNIT_LINKS_CHANGED' });
      }
    });
  }
  m.set(`${societyId}:${userId}`, { societyId, userId });
}

export interface SyncResult {
  status: 'ACTIVE' | 'INACTIVE';
  memberId: number | null;
  changed: boolean;
}

export async function syncMembership(
  ctx: Ctx,
  t: Transaction,
  residentId: number,
  opts: { societyId?: number } = {},
): Promise<SyncResult> {
  const resident = await Resident.findOne({
    where: { id: residentId, ...(opts.societyId ? { societyId: opts.societyId } : {}) },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!resident) throw residentNotFound();
  const societyId = resident.societyId;
  const today = await societyToday(societyId);
  const links = await UnitResident.findAll({
    where: { societyId, residentId },
    transaction: t,
  });
  const open = links.filter(l => l.toDate === null);
  const active = links.filter(l => activeOn(l, today));
  let changed = false;
  // BR-09-5: ACTIVE while a link is open, INACTIVE when the last open link ended
  const status = open.length ? 'ACTIVE' : 'INACTIVE';
  if (resident.status !== status && !resident.anonymisedAt) {
    resident.status = status;
    changed = true;
  }
  if (resident.userId === null) {
    if (changed) {
      resident.version += 1;
      await resident.save({ transaction: t });
    }
    return { status, memberId: null, changed };
  }
  const userId = resident.userId;
  const [m] = await members.listForSociety(societyId, { userIds: [userId] });
  if (active.length) {
    const strongest = strongestRelation(active.map(l => l.relation));
    let memberId = m?.memberId ?? null;
    if (!m) memberId = (await ensureResidentMember(t, societyId, userId, strongest)).id!;
    else if (m.roleScope === 'resident') await setResidentRole(t, m.memberId, strongest);
    if (resident.memberId !== memberId) {
      resident.memberId = memberId;
      changed = true;
    }
  } else if (resident.memberId !== null) {
    if (m && m.roleScope === 'resident') await endResidentMember(t, m.memberId, 'NO_ACTIVE_UNIT_LINK');
    resident.memberId = null;
    changed = true;
  }
  if (changed) {
    resident.version += 1;
    await resident.save({ transaction: t });
  }
  afterCommitAccess(t, societyId, userId);
  return { status, memberId: resident.memberId, changed };
}

/** Audit helper for the user-link rows (the actor of a hook is the system). */
export async function auditUserLinked(
  ctx: Ctx,
  t: Transaction,
  societyId: number,
  residentId: number,
  after: Record<string, unknown>,
): Promise<void> {
  await audit(
    ctx,
    {
      action: 'residents.resident.user_linked',
      entityType: 'resident',
      entityId: residentId,
      societyId,
      after,
    },
    t,
  );
}
