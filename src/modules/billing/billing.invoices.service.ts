import type {
  CreateAdHocInput,
  Ctx,
  InvoiceBalanceDto,
  InvoiceDto,
  OpenInvoiceDto,
  SystemCtx,
  Transaction,
} from './billing.types';

/**
 * `invoices.*` of section 8.24. PLACEHOLDER bodies (throw `not implemented`), except `registerFundResolver`, which only
 * stores the resolver. The invoice service sub-module replaces the bodies in this file; keep the exported names and
 * signatures (`billing.public.ts` re-exports `invoices` unchanged). Sub-module 11.3 (issue) builds the shared issue core
 * (numbering, lines, ledger, journal) that `createAdHoc` reuses.
 */
const notImplemented = (fn: string): never => {
  throw new Error(`not implemented: ${fn}`);
};

/** Fund resolvers by `refType` (module 12 registers `collection_request`); used by `createAdHoc` for `FUND_NOT_RESOLVED`. */
export const fundResolvers = new Map<string, (societyId: number, refId: number) => Promise<number | null>>();

export const invoices = {
  // shared contract (Part B)
  applyAllocation: async (
    _ctx: Ctx | SystemCtx,
    _invoiceId: number,
    _amountPaise: number,
    _t: Transaction,
  ): Promise<InvoiceBalanceDto> => notImplemented('invoices.applyAllocation'),
  reverseAllocation: async (
    _ctx: Ctx | SystemCtx,
    _invoiceId: number,
    _amountPaise: number,
    _t: Transaction,
  ): Promise<InvoiceBalanceDto> => notImplemented('invoices.reverseAllocation'),
  createAdHoc: async (
    _ctx: Ctx | SystemCtx,
    _input: CreateAdHocInput,
    _t: Transaction,
  ): Promise<{ invoiceId: number; invoiceNo: string; totalPaise: number }> =>
    notImplemented('invoices.createAdHoc'),
  // for module 12
  listOpen: async (
    _societyId: number,
    _unitId: number,
    _opts?: { payerUserId?: number },
  ): Promise<OpenInvoiceDto[]> => notImplemented('invoices.listOpen'),
  billedForMonth: async (
    _societyId: number,
    _month: string,
  ): Promise<{ billedPaise: number; invoiceIds: number[] }> => notImplemented('invoices.billedForMonth'),
  registerFundResolver: (
    refType: string,
    resolve: (societyId: number, refId: number) => Promise<number | null>,
  ): void => {
    fundResolvers.set(refType, resolve);
  },
  // for modules 09, 15, 23, 24, 25
  get: async (_societyId: number, _invoiceId: number): Promise<InvoiceDto | null> =>
    notImplemented('invoices.get'),
  setDisputed: async (
    _ctx: Ctx | SystemCtx,
    _invoiceId: number,
    _isDisputed: boolean,
    _t: Transaction,
  ): Promise<void> => notImplemented('invoices.setDisputed'),
  requestCancel: async (
    _ctx: Ctx | SystemCtx,
    _invoiceId: number,
    _reason: string,
    _t: Transaction,
  ): Promise<{ approvalRequestId: number; status: string }> => notImplemented('invoices.requestCancel'),
  creditBySource: async (
    _ctx: Ctx | SystemCtx,
    _invoiceId: number,
    _input: { refType: string; refId: number; percent: string; reason: string },
    _t: Transaction,
  ): Promise<{ noteId: number; noteNo: string; totalPaise: number }> =>
    notImplemented('invoices.creditBySource'),
  cancelBySource: async (
    _ctx: Ctx | SystemCtx,
    _invoiceId: number,
    _input: { refType: string; refId: number; reason: string },
    _t: Transaction,
  ): Promise<{ noteId: number; noteNo: string }> => notImplemented('invoices.cancelBySource'),
};
