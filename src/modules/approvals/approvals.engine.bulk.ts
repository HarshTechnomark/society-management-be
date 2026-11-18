import { ApprovalRequest, sequelize } from '../../models';
import type { Ctx } from '../../types/context';
import { audit } from '../../utils/audit';
import { AppError, ValidationError } from '../../utils/errors';
import { settings } from '../society-setup/society-setup.public';
import { AUDIT, DEFAULT_BULK_BELOW_PAISE, ENTITY, ERR, LIMITS, SETTING } from './approvals.constants';
import { decide, withDeadlockRetry } from './approvals.decide';
import { assertSocietyWritable } from './approvals.engine.guard';
import { requireSociety } from './approvals.shared';

const n = (v: unknown): number => Number(v);

export interface BulkItem {
  id: number;
  version: number;
}
export interface BulkResult {
  id: number;
  ok: boolean;
  status?: string;
  version?: number;
  code?: string;
  message?: string;
}
export interface BulkOutcome {
  approved: number;
  skipped: number;
  results: BulkResult[];
}

async function bulkBelow(societyId: number): Promise<number> {
  try {
    return Number(await settings.get(societyId, SETTING.bulkApproveBelowPaise)) || DEFAULT_BULK_BELOW_PAISE;
  } catch {
    return DEFAULT_BULK_BELOW_PAISE;
  }
}

/**
 * 8.11, BR-14-27: up to 50 items, ids unique. An item is bulk-eligible only when the request has `allowBulk`, no step-up and an
 * amount below `approvals.bulkApproveBelowPaise`; otherwise `BULK_NOT_ALLOWED` and it is not touched. Each item is approved in its
 * own transaction with its own version check; a failure of one never stops the others. The caller supplies the permission check,
 * `Idempotency-Key` and (BR-14-30) the society guard is applied here too.
 */
export async function bulkApprove(ctx: Ctx, items: BulkItem[]): Promise<BulkOutcome> {
  const societyId = requireSociety(ctx);
  assertSocietyWritable(ctx);
  if (!Array.isArray(items) || items.length < 1 || items.length > LIMITS.bulkMax)
    throw new ValidationError([{ field: 'items', message: `Send 1 to ${LIMITS.bulkMax} items` }]);
  const ids = items.map(i => i.id);
  if (new Set(ids).size !== ids.length)
    throw new ValidationError([{ field: 'items', message: 'Each request may appear once' }]);
  for (const [i, it] of items.entries())
    if (!Number.isInteger(it.id) || it.id < 1 || !Number.isInteger(it.version) || it.version < 1)
      throw new ValidationError([
        { field: `items.${i}`, message: 'id and version must be positive integers' },
      ]);

  const below = await bulkBelow(societyId);
  const rows = await ApprovalRequest.findAll({ where: { societyId, id: ids } });
  const byId = new Map(rows.map(r => [n(r.id), r]));
  const results: BulkResult[] = [];
  for (const it of items) {
    const row = byId.get(it.id);
    if (!row) {
      results.push({ id: it.id, ok: false, code: ERR.notFound, message: 'Approval request not found' });
      continue;
    }
    if (row.status === 'PENDING' && (!row.allowBulk || row.stepUpRequired || n(row.amountPaise) >= below)) {
      results.push({
        id: it.id,
        ok: false,
        code: ERR.bulkNotAllowed,
        message: row.stepUpRequired
          ? 'Needs a fresh code: approve it on its own'
          : 'Approve this one on its own',
      });
      continue;
    }
    try {
      const done = await withDeadlockRetry(() =>
        sequelize.transaction(t => decide(ctx, it.id, 'APPROVE', { version: it.version }, t)),
      );
      results.push({ id: it.id, ok: true, status: done.status, version: n(done.version) });
    } catch (err) {
      if (err instanceof AppError)
        results.push({ id: it.id, ok: false, code: err.code, message: err.message });
      else throw err;
    }
  }
  const approved = results.filter(r => r.ok).length;
  await audit(ctx, {
    action: AUDIT.bulkApproved,
    entityType: ENTITY.request,
    entityId: ids[0]!,
    societyId,
    after: { approved, skipped: results.length - approved, ids },
  });
  return { approved, skipped: results.length - approved, results };
}
