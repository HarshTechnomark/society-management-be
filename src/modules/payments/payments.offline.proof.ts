import type { Transaction } from 'sequelize';
import { placeholderFiles } from '../societies/societies.ports';
import { UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { ERR } from './payments.constants';

/**
 * Proof files of an offline or declared payment (cheque photo, transfer screenshot, section 7.2, at most 3).
 * Module 01's `files.service.link(ctx, fileIds, 'payment', paymentId, 'PAYMENT_PROOF')` does not exist yet, so this is the
 * replaceable placeholder over the shared memory file store: each file must exist, belong to the society, be clean, have the
 * purpose `PAYMENT_PROOF`, have been uploaded by the caller, and not be linked to another payment (`422 FILE_NOT_LINKABLE`).
 * The links live in memory; the file ids are also kept in the `payments.payment.recorded|declared` audit row.
 */
export interface ProofFilesPort {
  link(ctx: Ctx, fileIds: number[], paymentId: number, t: Transaction): Promise<void>;
  list(paymentId: number): number[];
}

export const placeholderProofLinks = new Map<number, number[]>();

const notLinkable = () =>
  new UnprocessableError(ERR.fileNotLinkable, 'This file cannot be used as proof', [
    { field: 'fileIds', message: 'Upload the proof again as a payment proof' },
  ]);

export const defaultProofFiles: ProofFilesPort = {
  async link(ctx, fileIds, paymentId) {
    const societyId = ctx.society?.id;
    for (const fid of fileIds) {
      const f = placeholderFiles.get(fid);
      const linked = [...placeholderProofLinks.entries()].some(
        ([p, ids]) => p !== paymentId && ids.includes(fid),
      );
      if (
        !f ||
        f.societyId !== societyId ||
        f.status !== 'CLEAN' ||
        f.purpose !== 'PAYMENT_PROOF' ||
        f.ownerUserId !== ctx.user?.id ||
        linked
      )
        throw notLinkable();
    }
    placeholderProofLinks.set(paymentId, [...fileIds]);
  },
  list: paymentId => placeholderProofLinks.get(paymentId) ?? [],
};

let current: ProofFilesPort = defaultProofFiles;
export const proofFiles = (): ProofFilesPort => current;
/** Tests and module 01 replace the port; call with nothing to restore the placeholder. */
export const setProofFiles = (p?: ProofFilesPort): void => {
  current = p ?? defaultProofFiles;
};
