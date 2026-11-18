import type { ApprovalRequest } from '../../models';
import type { Ctx } from '../../types/context';
import { reassign } from './approvals.engine.reassign';

/** The thin seam between the inbox routes and the engine functions in `approvals.engine.*`. The routes only call `engine`. */
export interface ReassignInput {
  version: number;
  userId: number;
  slotIndex?: number;
  reason: string;
}
export interface EngineAdapter {
  reassign(ctx: Ctx, requestId: number, input: ReassignInput): Promise<ApprovalRequest>;
}

export const engine: EngineAdapter = {
  reassign: (ctx, id, input) => reassign(ctx, id, input),
};
