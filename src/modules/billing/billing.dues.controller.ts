import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ForbiddenError } from '../../utils/errors';
import { ok } from '../../utils/response';
import { PERMISSIONS } from './billing.constants';
import * as dues from './billing.dues.service';
import { getNote, listNotes, type NoteListQuery } from './billing.notes.queries';
import * as reminders from './billing.reminders.service';
import * as resident from './billing.resident.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;
const list = (res: Response, items: unknown, pagination: unknown, extra: Record<string, unknown> = {}) =>
  res
    .status(200)
    .json({ success: true, data: extra.totals ? { items, ...extra } : items, message: 'OK', pagination });

export const duesController = {
  summary: h(async (req, res) =>
    ok(res, await dues.getSummary(sid(req), (v(req).query as { month?: string }).month)),
  ),
  defaulters: h(async (req, res) => {
    const q = v(req).query as dues.DefaultersInput & { format: 'json' | 'csv' };
    if (q.format === 'csv') {
      if (!req.ctx.permissions.has(PERMISSIONS.export)) throw new ForbiddenError();
      const { file } = await dues.defaultersCsv(req.ctx, sid(req), q);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="defaulters.csv"');
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).send(file);
    }
    const r = await dues.listDefaulters(sid(req), q);
    return list(res, r.items, r.pagination, { totals: r.totals });
  }),
  remind: h(async (req, res) =>
    ok(res, await reminders.remindInvoice(req.ctx, sid(req), v(req).params.id), 'Reminder sent'),
  ),
  bulkRemind: h(async (req, res) =>
    ok(res, await reminders.requestBulkReminders(req.ctx, sid(req), v(req).body), 'Reminders queued', 202),
  ),
  notes: h(async (req, res) => {
    const r = await listNotes(sid(req), v(req).query as NoteListQuery);
    return list(res, r.data, r.pagination);
  }),
  note: h(async (req, res) => ok(res, await getNote(sid(req), v(req).params.id))),
};

export const residentController = {
  dues: h(async (req, res) => ok(res, await resident.myDues(req.ctx))),
  invoices: h(async (req, res) => {
    const r = await resident.myInvoices(req.ctx, v(req).query as resident.MyInvoicesQuery);
    return list(res, r.items, r.pagination);
  }),
  invoice: h(async (req, res) => ok(res, await resident.myInvoice(req.ctx, v(req).params.id))),
  pdfUrl: h(async (req, res) => ok(res, await resident.myInvoicePdfUrl(req.ctx, v(req).params.id))),
  statement: h(async (req, res) =>
    ok(
      res,
      await resident.myStatement(
        req.ctx,
        v(req).params.unitId,
        v(req).query as { from?: string; to?: string },
      ),
    ),
  ),
};
