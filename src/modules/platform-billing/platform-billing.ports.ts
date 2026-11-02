import type { Transaction } from 'sequelize';
import { UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { societyPorts } from '../societies/societies.ports';

/**
 * Functions module 06 needs from the module 01 files service, which is not built yet. The default accepts only file
 * ids registered in `placeholderBillingFiles` (development and tests do that); module 01 replaces it with
 * `setBillingPorts({ files })`, which links a file of the given purpose to the society inside the transaction.
 */
export type BillingFilePurpose = 'TDS_CERTIFICATE' | 'PLATFORM_ATTACHMENT';

export interface BillingPorts {
  files: {
    /** Stores a rendered PDF (purpose `PLATFORM_INVOICE_PDF`, PRIVATE, kept with the financial records) and returns its file id. */
    storePdf(input: { societyId: number; name: string; content: Buffer }): Promise<{ fileId: number }>;
    /** Throws `422 FILE_NOT_LINKABLE` when the file is missing, not clean, of another purpose or society. */
    link(
      ctx: Ctx,
      input: { fileId: number; purpose: BillingFilePurpose; societyId: number },
      t: Transaction,
    ): Promise<void>;
  };
}

/** Placeholder: `<purpose>:<fileId>` of files the stand-in treats as clean and linkable. */
export const placeholderBillingFiles = new Set<string>();

export const defaultBillingPorts: BillingPorts = {
  files: {
    storePdf: async input => {
      const f = await societyPorts().files.storeSystemFile({
        societyId: input.societyId,
        purpose: 'PLATFORM_INVOICE_PDF',
        content: input.content,
        name: input.name,
        contentType: 'application/pdf',
        ownerUserId: null,
      });
      return { fileId: f.fileId };
    },
    link: async (_ctx, input) => {
      if (!placeholderBillingFiles.has(`${input.purpose}:${input.fileId}`))
        throw new UnprocessableError('FILE_NOT_LINKABLE', 'This file cannot be attached', [
          { field: 'fileId', message: 'File not found or not allowed here' },
        ]);
    },
  },
};

let ports: BillingPorts = defaultBillingPorts;
export const billingPorts = (): BillingPorts => ports;
export function setBillingPorts(p?: Partial<BillingPorts>): void {
  ports = { ...defaultBillingPorts, ...p };
}
