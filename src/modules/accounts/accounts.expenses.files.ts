import type { Transaction } from 'sequelize';
import { placeholderFiles } from '../societies/societies.ports';
import { UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { ERR } from './accounts.constants';

/**
 * Bill photos of an expense (BR-13-24, at most 5, purpose `EXPENSE_BILL`). Module 01's
 * `files.service.link(ctx, fileIds, 'expense', id, 'EXPENSE_BILL')` does not exist yet, so this is the replaceable placeholder over the
 * shared memory file store (same pattern as `payments.offline.proof.ts`): a file must exist, belong to the society, be clean, carry the
 * purpose, and not be linked to another expense; a file not yet linked to this expense must be the caller's own upload. Links live in memory.
 */
export interface BillFilesPort {
  /** Replaces the linked set of the expense. */
  link(ctx: Ctx, fileIds: number[], expenseId: number, t: Transaction): Promise<void>;
  list(expenseId: number): number[];
  release(expenseId: number): void;
}

export const BILL_PURPOSE = 'EXPENSE_BILL';
export const placeholderBillLinks = new Map<number, number[]>();

const notLinkable = () =>
  new UnprocessableError(ERR.fileNotLinkable, 'This file cannot be used as a bill', [
    { field: 'fileIds', message: 'Upload the bill again as an expense bill' },
  ]);

export const defaultBillFiles: BillFilesPort = {
  async link(ctx, fileIds, expenseId) {
    const societyId = ctx.society?.id;
    const current = placeholderBillLinks.get(expenseId) ?? [];
    for (const fid of fileIds) {
      const f = placeholderFiles.get(fid);
      const elsewhere = [...placeholderBillLinks.entries()].some(
        ([e, ids]) => e !== expenseId && ids.includes(fid),
      );
      if (
        !f ||
        f.societyId !== societyId ||
        f.status !== 'CLEAN' ||
        f.purpose !== BILL_PURPOSE ||
        elsewhere ||
        (!current.includes(fid) && f.ownerUserId !== ctx.user?.id)
      )
        throw notLinkable();
    }
    placeholderBillLinks.set(expenseId, [...fileIds]);
  },
  list: expenseId => placeholderBillLinks.get(expenseId) ?? [],
  release: expenseId => void placeholderBillLinks.delete(expenseId),
};

let current: BillFilesPort = defaultBillFiles;
export const billFiles = (): BillFilesPort => current;
/** Module 01 and tests replace the port; call with nothing to restore the placeholder. */
export const setBillFiles = (p?: BillFilesPort): void => {
  current = p ?? defaultBillFiles;
};

export function billFileInfo(fileId: number) {
  const f = placeholderFiles.get(fileId);
  return f ? { id: fileId, name: f.name, mimeType: f.contentType, status: f.status } : null;
}
