import { QueryTypes } from 'sequelize';
import { Society, sequelize } from '../../models';
import { logger } from '../../lib/logger';
import { registerProcessor, registerQueue, registerRepeatable } from '../../lib/queue';
import { systemCtx, type Ctx } from '../../types/context';
import { isJobAllowed } from '../societies/societies.guard';
import { JOBS, RESIDENTS_QUEUE } from './residents.constants';
import { runImport } from './residents.import.service';
import { sendWelcomeInvites } from './residents.invite.service';
import { runPetReminders } from './residents.pets.service';
import { touchReports } from './residents.ports';
import { societyToday } from './residents.shared';
import { syncMembership } from './residents.sync';

/**
 * Jobs of queue `residents` (section 9.1), part 1: `sync-links`, `pet-reminders`, `import` and `welcome-invites`. The
 * per-society jobs run for every society whose status allows ordinary jobs (module 05 BR-05-14). Parts 2 and 3 add their
 * steps to `sync-links` with `registerSyncStep` and register their own jobs beside these.
 */
export type SyncStep = (societyId: number, ctx: Ctx) => Promise<void>;
const steps: SyncStep[] = [];
/** Extension point of `residents:sync-links` (APPROVED moves past their date, APPROVED tenancies to ACTIVE, ...). */
export const registerSyncStep = (s: SyncStep): void => {
  if (!steps.includes(s)) steps.push(s);
};

async function societiesToRun(): Promise<number[]> {
  const rows = await Society.findAll({ attributes: ['id', 'status'], order: [['id', 'ASC']] });
  return rows.filter(s => isJobAllowed(s.status, 'normal') && s.status !== 'CLOSED').map(s => s.id!);
}

/** Membership and status sync (6.2) for the residents whose links started today or ended, and pets of ended owners. */
export async function syncLinksFor(
  societyId: number,
  ctx: Ctx = systemCtx('residents-sync'),
): Promise<number> {
  const today = await societyToday(societyId);
  const rows = await sequelize.query<{ id: number }>(
    `SELECT r.id FROM residents r
      WHERE r.societyId = :societyId AND r.deletedAt IS NULL AND (
        (r.userId IS NOT NULL AND r.memberId IS NULL AND EXISTS (SELECT 1 FROM unit_residents x
            WHERE x.residentId = r.id AND x.fromDate <= :today AND (x.toDate IS NULL OR x.toDate >= :today)))
        OR (r.memberId IS NOT NULL AND NOT EXISTS (SELECT 1 FROM unit_residents x
            WHERE x.residentId = r.id AND x.fromDate <= :today AND (x.toDate IS NULL OR x.toDate >= :today)))
        OR (r.status = 'ACTIVE' AND r.anonymisedAt IS NULL AND NOT EXISTS (SELECT 1 FROM unit_residents x WHERE x.residentId = r.id AND x.toDate IS NULL))
        OR (r.status = 'INACTIVE' AND EXISTS (SELECT 1 FROM unit_residents x WHERE x.residentId = r.id AND x.toDate IS NULL)))
      ORDER BY r.id`,
    { replacements: { societyId, today }, type: QueryTypes.SELECT },
  );
  let n = 0;
  for (const { id } of rows)
    try {
      await sequelize.transaction(t => syncMembership(ctx, t, Number(id), { societyId }));
      n += 1;
    } catch (err) {
      logger.error({ err, residentId: id }, 'residents:sync-links failed for a resident');
    }
  await sequelize.transaction(async t => {
    const [, meta] = await sequelize.query(
      `UPDATE pets p SET p.status = 'INACTIVE', p.inactiveReason = 'MOVED_OUT', p.updatedAt = NOW(3)
        WHERE p.societyId = :societyId AND p.deletedAt IS NULL AND p.status = 'ACTIVE'
          AND NOT EXISTS (SELECT 1 FROM unit_residents x WHERE x.residentId = p.ownerResidentId
                           AND x.unitId = p.unitId AND x.toDate IS NULL)`,
      { replacements: { societyId }, transaction: t },
    );
    if (Number((meta as { affectedRows?: number })?.affectedRows ?? 0)) touchReports(t, societyId);
  });
  for (const step of steps)
    try {
      await step(societyId, ctx);
    } catch (err) {
      logger.error({ err, societyId }, 'residents:sync-links step failed');
    }
  return n;
}

export function registerResidentsJobs(): void {
  registerQueue(RESIDENTS_QUEUE, 'Residents: link sync, reminders, bulk import, welcome invites', 4);
  registerProcessor(RESIDENTS_QUEUE, JOBS.syncLinks, async () => {
    for (const id of await societiesToRun()) await syncLinksFor(id);
  });
  registerProcessor(RESIDENTS_QUEUE, JOBS.petReminders, async () => {
    for (const id of await societiesToRun()) await runPetReminders(id);
  });
  registerProcessor(RESIDENTS_QUEUE, JOBS.import, async d =>
    runImport(d as unknown as { jobId: string; requestId: string }),
  );
  registerProcessor(RESIDENTS_QUEUE, JOBS.welcomeInvites, async d => {
    const data = d as unknown as { societyId: number; requestId?: string };
    await sendWelcomeInvites(systemCtx(data.requestId ?? 'welcome-invites'), data.societyId);
  });
  registerRepeatable(RESIDENTS_QUEUE, JOBS.syncLinks, { dailyAtIst: '00:15' });
  registerRepeatable(RESIDENTS_QUEUE, JOBS.petReminders, { dailyAtIst: '09:00' });
}
