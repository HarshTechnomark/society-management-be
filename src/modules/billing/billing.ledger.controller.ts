import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { audit } from '../../utils/audit';
import { ForbiddenError } from '../../utils/errors';
import { noContent, ok } from '../../utils/response';
import { PERMISSIONS } from './billing.constants';
import { LEDGER_AUDIT, LEDGER_ENTITY } from './billing.ledger.types';
import * as opening from './billing.opening.service';
import * as statement from './billing.statement.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;

export const ledgerController = {
  statement: h(async (req, res) => {
    const q = v(req).query as { from?: string; to?: string; format: 'json' | 'csv' };
    const unitId = v(req).params.unitId as number;
    // BR-11 section 8.20: JSON needs finance.billing.view (the route), the CSV also finance.billing.export
    if (q.format === 'csv' && !req.ctx.permissions.has(PERMISSIONS.export)) throw new ForbiddenError();
    const s = await statement.getStatement(sid(req), unitId, q);
    if (q.format === 'json') return ok(res, s);
    await audit(req.ctx, {
      action: LEDGER_AUDIT.statementExported,
      entityType: LEDGER_ENTITY.statement,
      entityId: unitId,
      entityLabel: s.unit.label,
      societyId: sid(req),
      after: { from: s.from, to: s.to, entryCount: s.entries.length },
    });
    const name = `statement-${s.unit.label.replace(/[^A-Za-z0-9_-]/g, '_')}-${s.from}-${s.to}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(statement.statementCsv(s));
  }),

  openingList: h(async (req, res) => {
    const r = await opening.listOpening(sid(req), v(req).query);
    res.status(200).json({
      success: true,
      data: { items: r.items, totals: r.totals },
      message: 'OK',
      pagination: r.pagination,
    });
  }),
  openingTemplate: h(async (_req, res) => {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="opening-balances-template.csv"');
    return res.status(200).send(opening.openingTemplate());
  }),
  openingImport: h(async (req, res) => {
    const r = await opening.importOpening(req.ctx, sid(req), v(req).body);
    ok(res, r, r.dryRun ? 'Checked, nothing saved' : `${r.draft} rows ready to post, ${r.invalid} invalid`);
  }),
  openingPost: h(async (req, res) => {
    const r = await opening.postOpening(req.ctx, sid(req), v(req).body);
    ok(res, r, `${r.posted} opening balances posted`);
  }),
  openingReverse: h(async (req, res) =>
    ok(
      res,
      await opening.reverseOpening(req.ctx, sid(req), v(req).params.id, v(req).body),
      'Opening balance reversed',
    ),
  ),
  openingDelete: h(async (req, res) => {
    await opening.deleteOpening(req.ctx, sid(req), v(req).params.id, v(req).body);
    noContent(res);
  }),
};
