import { Society } from '../../models';
import { registerProcessor, registerRepeatable } from '../../lib/queue';
import { systemCtx } from '../../types/context';
import { isJobAllowed } from '../societies/societies.guard';
import { RESIDENTS_QUEUE } from './residents.constants';
import { JOBS2 } from './residents.part2.constants';
import { registerSyncStep } from './residents.jobs';
import { runJoinRequestJob } from './residents.joins.service';
import {
  cancelStaleMoves,
  moveHandlers,
  onMoveDepositPaid,
  runDepositRefunds,
} from './residents.moves.service';
import { joinRequestHandlers } from './residents.joins.service';
import { part2Ports } from './residents.part2.ports';
import { activateDueTenancies, runPoliceReminders, runTenancyReminders } from './residents.tenancies.service';
import type { Transaction } from 'sequelize';
import type { Ctx } from '../../types/context';

/**
 * Part 2 start-up: jobs `residents:tenancy-reminders`, `residents:police-reminders`, `residents:join-requests` and
 * `residents:deposit-refunds`, the part 2 steps of `residents:sync-links` (stale APPROVED moves, APPROVED tenancies that
 * start without a move request), the module 14 handlers and the module 13 deposit dispatch.
 */
async function societiesToRun(): Promise<number[]> {
  const rows = await Society.findAll({ attributes: ['id', 'status'], order: [['id', 'ASC']] });
  return rows.filter(s => isJobAllowed(s.status, 'normal') && s.status !== 'CLOSED').map(s => s.id!);
}

// ---- module 13 callbacks: one dispatcher, handlers per `refType` (part 3 registers `renovation_permit`)
export interface DepositHandler {
  onPaid(ctx: Ctx, input: { refId: number; depositId: number }, t: Transaction): Promise<void>;
  onRefunded?(
    ctx: Ctx,
    input: { refId: number; depositId: number; refundedPaise: number },
    t: Transaction,
  ): Promise<void>;
}
const depositHandlers = new Map<string, DepositHandler>([['move_request', { onPaid: onMoveDepositPaid }]]);
export const registerDepositHandler = (refType: string, h: DepositHandler): void => {
  depositHandlers.set(refType, h);
};
export async function onDepositPaid(
  ctx: Ctx,
  input: { refType: 'move_request' | 'renovation_permit'; refId: number; depositId: number },
  t: Transaction,
): Promise<void> {
  await depositHandlers.get(input.refType)?.onPaid(ctx, input, t);
}
export async function onDepositRefunded(
  ctx: Ctx,
  input: {
    refType: 'move_request' | 'renovation_permit';
    refId: number;
    depositId: number;
    refundedPaise: number;
  },
  t: Transaction,
): Promise<void> {
  await depositHandlers.get(input.refType)?.onRefunded?.(ctx, input, t);
}

/** Registers the module 14 types `JOIN_REQUEST`, `MOVE_IN` and `MOVE_OUT` (6.8). */
export function registerPart2Approvals(): void {
  const a = part2Ports().approvals;
  a.registerType('JOIN_REQUEST', joinRequestHandlers);
  a.registerType('MOVE_IN', moveHandlers);
  a.registerType('MOVE_OUT', moveHandlers);
}

export function registerResidentsPart2(): void {
  registerPart2Approvals();
  registerSyncStep(async (societyId, ctx) => {
    await cancelStaleMoves(societyId, ctx);
    await activateDueTenancies(societyId, ctx);
  });
  registerProcessor(RESIDENTS_QUEUE, JOBS2.tenancyReminders, async () => {
    for (const id of await societiesToRun()) await runTenancyReminders(id, systemCtx('tenancy-reminders'));
  });
  registerProcessor(RESIDENTS_QUEUE, JOBS2.policeReminders, async () => {
    for (const id of await societiesToRun()) await runPoliceReminders(id);
  });
  registerProcessor(RESIDENTS_QUEUE, JOBS2.joinRequests, async () => {
    await runJoinRequestJob();
  });
  registerProcessor(RESIDENTS_QUEUE, JOBS2.depositRefunds, async () => {
    for (const id of await societiesToRun()) await runDepositRefunds(id);
  });
  registerRepeatable(RESIDENTS_QUEUE, JOBS2.tenancyReminders, { dailyAtIst: '09:00' });
  registerRepeatable(RESIDENTS_QUEUE, JOBS2.depositRefunds, { dailyAtIst: '10:00' });
  registerRepeatable(RESIDENTS_QUEUE, JOBS2.joinRequests, { hourlyAtMinute: 5 });
  registerRepeatable(RESIDENTS_QUEUE, JOBS2.policeReminders, { dailyAtIst: '10:00' });
}
