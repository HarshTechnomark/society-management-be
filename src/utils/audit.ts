import type { Transaction } from 'sequelize';
import { AuditLog } from '../models';
import { redact } from '../lib/logger';
import type { Ctx } from '../types/context';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId: string | number;
  entityLabel?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  societyId?: number | null;
  supportGrantId?: number | null;
  /** Overrides the actor taken from `ctx` (jobs, sign-in events where no session exists yet). */
  actor?: { userId: number | null; name: string; role: string };
}

export interface AuditedRow {
  id: number;
  societyId: number | null;
  action: string;
  entityType: string;
  entityId: string;
  entityLabel: string | null;
  createdAt: Date;
}
const listeners: ((row: AuditedRow) => void)[] = [];
/** Called after an audit row is committed (module 07 pushes dashboard activity). A throwing listener never fails the write. */
export const onAuditCommitted = (fn: (row: AuditedRow) => void): void => {
  if (!listeners.includes(fn)) listeners.push(fn);
};

/**
 * Writes one audit row. Call it inside the same transaction as the change it records (BR-01-8), so a rolled-back
 * change leaves no row. `before` and `after` go through the log redaction (secrets removed, phones and emails masked).
 */
export async function audit(ctx: Ctx, input: AuditInput, tx?: Transaction): Promise<void> {
  const actor = input.actor ?? {
    userId: ctx.user?.id ?? null,
    name: ctx.user ? (ctx.user.name ?? 'User') : 'System',
    role: ctx.user ? (ctx.actorRoleKey ?? 'user') : 'system',
  };
  const row = await AuditLog.create(
    {
      societyId: input.societyId ?? null,
      actorUserId: actor.userId,
      actorName: actor.name.slice(0, 120),
      actorRole: actor.role.slice(0, 40),
      supportGrantId: input.supportGrantId ?? ctx.supportGrant?.id ?? ctx.session?.supportGrantId ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: String(input.entityId).slice(0, 60),
      entityLabel: input.entityLabel?.slice(0, 200) ?? null,
      before: input.before === undefined ? null : redact(input.before),
      after: input.after === undefined ? null : redact(input.after),
      reason: input.reason?.slice(0, 500) ?? null,
      ip: ctx.ip ? ctx.ip.slice(0, 45) : null,
      userAgent: ctx.userAgent ? ctx.userAgent.slice(0, 255) : null,
      requestId: ctx.requestId ? ctx.requestId.slice(0, 20) : null,
    },
    { transaction: tx },
  );
  if (!listeners.length) return;
  const fire = () => {
    for (const l of listeners)
      try {
        l({
          id: row.id!,
          societyId: row.societyId,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          entityLabel: row.entityLabel,
          createdAt: row.createdAt!,
        });
      } catch {
        // a listener must not undo the audited action
      }
  };
  if (tx) tx.afterCommit(fire);
  else fire();
}
