import { sequelize } from '../../models';
import type { Ctx } from '../../types/context';
import { approvalStub } from './residents.part2.ports';

/**
 * Entry points a development-only route (`POST /dev/approvals/:id/approve` and `/reject`, wired by the coordinator) or module
 * 14's callback calls. They run the registered handlers (`JOIN_REQUEST`, `MOVE_IN`, `MOVE_OUT`) in one transaction, so the
 * completion code is exactly what the real module 14 runs. Requests live in the in-memory store of `approvalStub`.
 * Tenancy approval is not a module 14 type: it uses `POST /tenancies/:id/approve` (BR-09-29).
 */
export async function approve(approvalRequestId: number, actorCtx: Ctx): Promise<void> {
  await sequelize.transaction(t => approvalStub.approve(actorCtx, approvalRequestId, t));
}

export async function reject(approvalRequestId: number, reason: string, actorCtx: Ctx): Promise<void> {
  await sequelize.transaction(t => approvalStub.reject(actorCtx, approvalRequestId, reason, t));
}
