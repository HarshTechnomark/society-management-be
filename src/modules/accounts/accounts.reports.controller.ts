import type { Request, RequestHandler } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok } from '../../utils/response';
import { entitlements } from '../subscriptions/subscriptions.public';
import { ENT } from './accounts.constants';
import { DEFAULT_DEADLINE_MS } from './accounts.reports.queries';
import { runReport, type AnyReport, type RunQuery } from './accounts.reports.service';
import { exportStatus, requestExport, type ExportFormat } from './accounts.reports.export';
import { fundStatementForResident, societyFinances } from './accounts.resident.service';
import { PaymentRequiredError } from '../../utils/errors';

const sid = (req: Request): number => req.ctx.society!.id;
const h = (fn: (req: Request, res: Parameters<RequestHandler>[1]) => Promise<unknown>): RequestHandler =>
  asyncHandler(fn as never);

/** GST and TDS reports also need their own plan key (all three are Premium; a custom plan may split them). */
const EXTRA_KEY: Partial<Record<AnyReport, string>> = {
  'gst-summary': ENT.gstSummary,
  'tds-register': ENT.tds,
};

export const reportsController = {
  run: h(async (req, res) => {
    const report = (req.valid.params as { report: AnyReport }).report;
    const key = EXTRA_KEY[report];
    if (key && !(await entitlements.isFeatureOn(sid(req), key as never)))
      throw new PaymentRequiredError('FEATURE_NOT_IN_PLAN', 'This report is not included in your plan.');
    const q = req.valid.query as RunQuery;
    const r = await runReport(sid(req), report, q, { deadlineMs: DEFAULT_DEADLINE_MS });
    const { pagination, ...body } = r.body as Record<string, unknown> & { pagination?: unknown };
    if (pagination) return res.status(200).json({ success: true, data: body, message: 'OK', pagination });
    return ok(res, body);
  }),
  export: h(async (req, res) => {
    const b = req.valid.body as { report: AnyReport; params: RunQuery; format: ExportFormat };
    const r = await requestExport(req.ctx, sid(req), b);
    return ok(res, r, 'Export queued', 202);
  }),
  exportStatus: h(async (req, res) =>
    ok(res, await exportStatus(sid(req), req.ctx.user!.id, (req.valid.params as { id: string }).id)),
  ),
  myFinances: h(async (req, res) => ok(res, await societyFinances(sid(req)))),
  myFundStatement: h(async (req, res) =>
    ok(res, await fundStatementForResident(sid(req), (req.valid.params as { id: number }).id)),
  ),
};
