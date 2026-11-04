import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { audit } from '../../utils/audit';
import { created, ok, okList } from '../../utils/response';
import { AUDIT } from './billing.constants';
import { createAdHocInvoice } from './billing.invoices.adhoc';
import { exportInvoices, listInvoices, loadInvoiceDetail } from './billing.invoices.detail';
import { cancelInvoiceRoute, requestWriteOff } from './billing.notes.cancel';
import { createCreditNote, patchCreditNote, withdrawNote } from './billing.notes.credit';
import { createDebitNote } from './billing.notes.debit';
import { getNote, listNotes } from './billing.notes.queries';
import { invoicePdfUrl, notePdfUrl } from './billing.pdf.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;

export const invoicesController = {
  list: h(async (req, res) => {
    const r = await listInvoices(sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  export: h(async (req, res) => {
    const { format: _format, ...filter } = v(req).query;
    const r = await exportInvoices(sid(req), filter);
    await audit(req.ctx, {
      action: AUDIT.invoicesExported,
      entityType: 'invoice_export',
      entityId: 0,
      societyId: sid(req),
      after: { filter, rows: r.rows },
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="invoices.csv"');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(r.csv);
  }),
  get: h(async (req, res) => ok(res, await loadInvoiceDetail(sid(req), v(req).params.id))),
  pdfUrl: h(async (req, res) => ok(res, await invoicePdfUrl(sid(req), v(req).params.id))),
  adHoc: h(async (req, res) =>
    created(res, await createAdHocInvoice(req.ctx, v(req).body), 'Invoice issued'),
  ),
  creditNote: h(async (req, res) => {
    const n = await createCreditNote(req.ctx, v(req).params.id, v(req).body);
    created(res, n, n.status === 'ISSUED' ? 'Credit note issued' : 'Credit note sent for approval');
  }),
  debitNote: h(async (req, res) =>
    created(res, await createDebitNote(req.ctx, v(req).params.id, v(req).body), 'Debit note issued'),
  ),
  cancel: h(async (req, res) => {
    const r = await cancelInvoiceRoute(req.ctx, v(req).params.id, v(req).body.reason);
    if (r.status === 'APPROVED')
      return ok(res, await loadInvoiceDetail(sid(req), v(req).params.id), 'Invoice cancelled');
    return ok(res, r, 'Cancellation sent for approval', 202);
  }),
  writeOff: h(async (req, res) =>
    created(
      res,
      await requestWriteOff(req.ctx, v(req).params.id, v(req).body),
      'Write-off sent for approval',
    ),
  ),
  noteList: h(async (req, res) => {
    const r = await listNotes(sid(req), v(req).query);
    okList(res, r.data, r.pagination);
  }),
  noteGet: h(async (req, res) => ok(res, await getNote(sid(req), v(req).params.id))),
  notePdfUrl: h(async (req, res) => ok(res, await notePdfUrl(sid(req), v(req).params.id))),
  notePatch: h(async (req, res) =>
    ok(
      res,
      await patchCreditNote(req.ctx, v(req).params.id, v(req).body),
      'Credit note sent for approval again',
    ),
  ),
  noteWithdraw: h(async (req, res) =>
    ok(res, await withdrawNote(req.ctx, v(req).params.id, v(req).body), 'Credit note withdrawn'),
  ),
};
