import { Op } from 'sequelize';
import { PlatformTicket, Society, sequelize } from '../../models';
import { logger } from '../../lib/logger';
import { addDays, now } from '../../lib/clock';
import { registerProcessor, registerQueue, registerRepeatable } from '../../lib/queue';
import { systemCtx } from '../../types/context';
import { getPlatformSetting } from './platform-ops.settings.service';
import { scan } from './platform-ops.sla';
import { AUDIT, JOBS, PLATFORM_OPS_QUEUE, ticketNo } from './platform-ops.types';
import {
  applyTransition,
  auditTicket,
  emitTicketChanged,
  lockTicket,
  notifyStatusChanged,
  platformLink,
} from './platform-ops.tickets.core';
import { notifyAfterCommit, platformUsersWith } from './platform-ops.notify';
import { assigneeOrSupport } from './platform-ops.tickets.service';

/** Queue `platform-ops` jobs of module 07 section 9.1 that belong to tickets. Part 2 adds the others. */
const SYSTEM = systemCtx('job');
const SYSTEM_BY = { side: 'SYSTEM' as const, userId: null, name: 'SocietyApp' };
const BATCH = 500;

export interface SlaScanResult {
  firstResponseBreaches: number;
  warnings: number;
  resolutionBreaches: number;
}

/**
 * `platform-ops:ticket-sla-scan` (BR-07-8): sets each breach or warning timestamp once with a conditional UPDATE, so a
 * second run (or a second worker) changes nothing and sends nothing.
 */
export async function runTicketSlaScan(): Promise<SlaScanResult> {
  const r: SlaScanResult = { firstResponseBreaches: 0, warnings: 0, resolutionBreaches: 0 };
  const at = now();
  const tickets = await PlatformTicket.findAll({
    where: { status: { [Op.in]: ['OPEN', 'IN_PROGRESS'] } },
    order: [['id', 'ASC']],
    limit: BATCH,
  });
  for (const tk of tickets) {
    const s = scan(
      {
        createdAt: tk.createdAt!,
        priority: tk.priority,
        status: tk.status,
        firstResponseDueAt: tk.firstResponseDueAt,
        resolutionDueAt: tk.resolutionDueAt,
        firstRespondedAt: tk.firstRespondedAt,
        firstResponseBreachedAt: tk.firstResponseBreachedAt,
        resolutionWarnedAt: tk.resolutionWarnedAt,
        resolutionBreachedAt: tk.resolutionBreachedAt,
        waitingSince: tk.waitingSince,
        pausedMinutes: tk.pausedMinutes,
      },
      at,
    );
    const claim = async (column: string): Promise<boolean> => {
      const [n] = await PlatformTicket.update({ [column]: at } as never, {
        where: { id: tk.id!, [column]: null, status: { [Op.in]: ['OPEN', 'IN_PROGRESS'] } },
      });
      return n === 1;
    };
    const society = (await Society.findByPk(tk.societyId, { attributes: ['name'] }))?.name ?? 'Society';
    const base = {
      ticketNo: ticketNo(tk.id!),
      subject: tk.subject,
      societyName: society,
      link: platformLink(tk.id!),
    };
    const breachRecipients = async () => [
      ...new Set([
        ...(tk.assigneeUserId ? [tk.assigneeUserId] : []),
        ...(await platformUsersWith('platform.settings.edit')),
      ]),
    ];
    if (s.firstResponseBreach && (await claim('firstResponseBreachedAt'))) {
      r.firstResponseBreaches += 1;
      notifyAfterCommit(null, 'platform.ticket.sla_breached', breachRecipients, {
        ...base,
        which: 'FIRST_RESPONSE',
      });
    }
    const warned = s.warn && (await claim('resolutionWarnedAt'));
    if (warned) r.warnings += 1;
    if (s.resolutionBreach && (await claim('resolutionBreachedAt'))) {
      r.resolutionBreaches += 1;
      notifyAfterCommit(null, 'platform.ticket.sla_breached', breachRecipients, {
        ...base,
        which: 'RESOLUTION',
      });
    } else if (warned)
      notifyAfterCommit(null, 'platform.ticket.sla_warning', () => assigneeOrSupport(tk), base);
  }
  logger.info(r, 'platform-ops:ticket-sla-scan done');
  return r;
}

export interface HousekeepingResult {
  autoResolved: number;
  autoClosed: number;
}

/**
 * `platform-ops:ticket-housekeeping` (BR-07-12): WAITING tickets with no society message for
 * `support.waitingAutoResolveDays` become RESOLVED; RESOLVED tickets older than `support.autoCloseDays` become CLOSED
 * (`AUTO_CLOSED`). Each ticket is re-read under its row lock and skipped when it changed meanwhile.
 */
export async function runTicketHousekeeping(): Promise<HousekeepingResult> {
  const r: HousekeepingResult = { autoResolved: 0, autoClosed: 0 };
  const at = now();
  const waitDays = await getPlatformSetting('support.waitingAutoResolveDays');
  const closeDays = await getPlatformSetting('support.autoCloseDays');
  const sla = await getPlatformSetting('support.slaHours');

  const waiting = await PlatformTicket.findAll({
    where: { status: 'WAITING' },
    order: [['id', 'ASC']],
    limit: BATCH,
  });
  for (const w of waiting) {
    await sequelize.transaction(async t => {
      const tk = await lockTicket(w.id!, t);
      if (tk.status !== 'WAITING') return;
      const ref = Math.max(
        (tk.lastSocietyMessageAt ?? tk.createdAt!).getTime(),
        (tk.waitingSince ?? tk.createdAt!).getTime(),
      );
      if (at.getTime() < addDays(new Date(ref), waitDays).getTime()) return;
      const patch = await applyTransition(
        SYSTEM,
        tk,
        {
          to: 'RESOLVED',
          by: SYSTEM_BY,
          body: 'Resolved automatically because we did not hear back. Reply within 7 days to reopen.',
        },
        t,
        sla,
      );
      await tk.update({ ...patch, version: tk.version + 1, updatedBy: null }, { transaction: t });
      await auditTicket(
        SYSTEM,
        tk,
        AUDIT.ticketAutoResolved,
        { before: { status: 'WAITING' }, after: { status: 'RESOLVED' } },
        t,
      );
      notifyStatusChanged(t, tk, `/settings/support/${tk.id}`);
      emitTicketChanged(t, tk, { statusChanged: true });
      r.autoResolved += 1;
    });
  }

  const resolved = await PlatformTicket.findAll({
    where: { status: 'RESOLVED', resolvedAt: { [Op.lte]: addDays(at, -closeDays) } },
    order: [['id', 'ASC']],
    limit: BATCH,
  });
  for (const w of resolved) {
    await sequelize.transaction(async t => {
      const tk = await lockTicket(w.id!, t);
      if (tk.status !== 'RESOLVED' || !tk.resolvedAt || addDays(tk.resolvedAt, closeDays) > at) return;
      const patch = await applyTransition(
        SYSTEM,
        tk,
        {
          to: 'CLOSED',
          by: SYSTEM_BY,
          body: 'Closed automatically after the reopen period.',
          closedReason: 'AUTO_CLOSED',
        },
        t,
      );
      await tk.update({ ...patch, version: tk.version + 1, updatedBy: null }, { transaction: t });
      await auditTicket(
        SYSTEM,
        tk,
        AUDIT.ticketAutoClosed,
        { before: { status: 'RESOLVED' }, after: { status: 'CLOSED' } },
        t,
      );
      notifyStatusChanged(t, tk, `/settings/support/${tk.id}`);
      emitTicketChanged(t, tk, { statusChanged: true });
      r.autoClosed += 1;
    });
  }
  logger.info(r, 'platform-ops:ticket-housekeeping done');
  return r;
}

let registered = false;
/** Registers the queue, processors and repeatable schedules of this part of the module (idempotent). */
export function registerPlatformOpsJobs(): void {
  registerQueue(PLATFORM_OPS_QUEUE, 'Platform operations: tickets, announcements, providers, audit', 5);
  registerProcessor(PLATFORM_OPS_QUEUE, JOBS.ticketSlaScan, async () => runTicketSlaScan());
  registerProcessor(PLATFORM_OPS_QUEUE, JOBS.ticketHousekeeping, async () => runTicketHousekeeping());
  if (!registered) {
    registered = true;
    registerRepeatable(PLATFORM_OPS_QUEUE, JOBS.ticketSlaScan, { everyMs: 5 * 60_000 });
    registerRepeatable(PLATFORM_OPS_QUEUE, JOBS.ticketHousekeeping, { hourlyAtMinute: 0 });
  }
}
