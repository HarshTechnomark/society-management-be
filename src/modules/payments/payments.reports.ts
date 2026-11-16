import { notImplemented } from './payments.shared';

/**
 * Report readers for module 24 (section 8.27). Placeholders: 12.3 fills the bodies, keeping these names and signatures.
 * Read-only, no audit, `societyId` from the caller; a read that cannot finish in `deadlineMs` throws `ReadTimeoutError`.
 */
export interface ReadOpts {
  deadlineMs: number;
  replica?: boolean;
}
export interface RegisterQuery {
  from: string;
  to: string;
  method?: string[];
  status?: string[];
  unitId?: number;
  piiClass?: 'masked' | 'unmasked';
  page: number;
  limit: number;
  sortBy: 'paymentDate' | 'amountPaise' | 'receiptNo';
  sortDir: 'asc' | 'desc';
  buildingIds?: number[];
}
export interface CollectionProgressQuery {
  status?: string[];
  kind?: string[];
  page: number;
  limit: number;
  sortBy: 'dueDate' | 'title' | 'collectedPaise' | 'percent';
  sortDir: 'asc' | 'desc';
  buildingIds?: number[];
}

export const paymentsReports = {
  summary: async (
    _societyId: number,
    _from: string,
    _to: string,
    _opts?: ReadOpts,
  ): Promise<{
    receivedPaise: number;
    reversedPaise: number;
    refundedPaise: number;
    paymentCount: number;
    byMethod: Record<string, number>;
    advanceCreditedPaise: number;
    efficiencyPercent: number | null;
  }> => {
    throw notImplemented('paymentsReports.summary');
  },
  register: async (_societyId: number, _q: RegisterQuery, _opts?: ReadOpts) => {
    throw notImplemented('paymentsReports.register');
  },
  collectionProgress: async (_societyId: number, _q: CollectionProgressQuery, _opts?: ReadOpts) => {
    throw notImplemented('paymentsReports.collectionProgress');
  },
};
