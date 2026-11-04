import type { Transaction } from 'sequelize';
import { logger } from '../../lib/logger';
import { notify } from '../../lib/notify';
import { UnprocessableError } from '../../utils/errors';
import { placeholderFiles } from '../societies/societies.ports';
import type { Ctx } from '../../types/context';

/**
 * What module 10 needs from modules that are not built yet. Each default is a small placeholder that behaves as the spec
 * describes; the owner calls `setCommitteePorts({...})` at start-up (tests do the same).
 *
 * - Module 14 `approvals.createHandoverDelegation` (BR-10-18): used by activation and changes (sub-module 10.2). The
 *   placeholder records the call and creates nothing.
 * - Module 16 `notify` (section 10): the placeholder is the temporary `lib/notify.ts` stand-in, which renders the templates
 *   of `committee.templates.ts` and sends through the module 01 adapters. A failed send never fails the action it reports.
 * - Module 01 `files.service.link(ctx, fileIds, 'committee_term', termId, 'HANDOVER_EVIDENCE')` (section 7.5, sub-module 10.3):
 *   the placeholder accepts a CLEAN file of the society with purpose `HANDOVER_EVIDENCE` from the module 08 memory store
 *   (`placeholderFiles`) and throws `422 FILE_NOT_LINKABLE` otherwise; it links nothing.
 * - Module 22 calls `committee.createDraftFromElection()` (in `committee.public.ts`); it needs no port. Module 23 is not used.
 */
export interface HandoverDelegationInput {
  fromUserId: number;
  toUserId: number;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  committeeTermId: number;
}
export interface CommitteePorts {
  files: {
    linkEvidence(
      ctx: Ctx,
      input: { fileIds: number[]; societyId: number; termId: number },
      t: Transaction,
    ): Promise<void>;
  };
  approvals: {
    createHandoverDelegation(
      ctx: Ctx,
      input: HandoverDelegationInput,
      t: Transaction,
    ): Promise<{ id: number }>;
  };
  notifications: {
    send(template: string, userIds: number[], data: Record<string, unknown>): Promise<void>;
  };
}

export interface CommitteePortCall {
  fn: string;
  input: unknown;
  t?: Transaction;
}
/** Every call a placeholder received (tests assert the calls). */
export const committeePortCalls: CommitteePortCall[] = [];

export const defaultCommitteePorts: CommitteePorts = {
  files: {
    linkEvidence: async (_ctx, i, t) => {
      for (const fileId of i.fileIds) {
        const f = placeholderFiles.get(fileId);
        if (!f || f.status !== 'CLEAN' || f.purpose !== 'HANDOVER_EVIDENCE' || f.societyId !== i.societyId)
          throw new UnprocessableError('FILE_NOT_LINKABLE', 'This file cannot be used here', [
            { field: 'evidenceFileIds', message: 'Upload the file again', fileId },
          ]);
      }
      committeePortCalls.push({ fn: 'files.linkEvidence', input: i, t });
    },
  },
  approvals: {
    createHandoverDelegation: async (_ctx, input, t) => {
      committeePortCalls.push({ fn: 'approvals.createHandoverDelegation', input, t });
      return { id: 0 };
    },
  },
  notifications: {
    send: async (template, userIds, data) => {
      try {
        await notify(
          template,
          userIds.map(userId => ({ userId })),
          data,
        );
      } catch (err) {
        logger.error({ err, template }, 'committee notify failed');
      }
    },
  },
};

let current: CommitteePorts = defaultCommitteePorts;
export const committeePorts = (): CommitteePorts => current;

/** Replace some ports (the owner module at start-up, or tests). Pass nothing to restore the placeholders. */
export function setCommitteePorts(p?: { [K in keyof CommitteePorts]?: Partial<CommitteePorts[K]> }): void {
  if (!p) {
    current = defaultCommitteePorts;
    return;
  }
  const next = { ...current } as Record<string, unknown>;
  for (const [k, v] of Object.entries(p))
    next[k] = { ...(current as unknown as Record<string, object>)[k], ...v };
  current = next as unknown as CommitteePorts;
}
