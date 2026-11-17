import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { ok, okList } from '../../utils/response';
import { enqueue } from '../../lib/queue';
import { ACCOUNTS_QUEUE, JOBS } from './accounts.constants';
import * as statements from './accounts.statements.service';
import * as match from './accounts.statements.match';
import { bankReconciliation } from './accounts.brs.service';
import { BankStatementImport } from '../../models';
import { invalidState, statementDto, statementNotFound } from './accounts.statements.shared';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;
const id = (req: Request): number => v(req).params.id as number;

export const statementController = {
  import: h(async (req, res) => {
    const r = await statements.importStatement(req.ctx, v(req).body as statements.ImportInput);
    res.status(202).json({ success: true, data: r, message: 'Statement uploaded and queued for parsing' });
  }),
  list: h(async (req, res) => {
    const r = await statements.listStatements(sid(req), v(req).query as statements.StatementListQuery);
    okList(res, r.items, r.pagination);
  }),
  get: h(async (req, res) => ok(res, await statements.getStatement(sid(req), id(req)))),
  lines: h(async (req, res) => {
    const r = await statements.listLines(sid(req), id(req), v(req).query as statements.LineListQuery);
    okList(res, r.items, r.pagination);
  }),
  autoMatch: h(async (req, res) => {
    const imp = await BankStatementImport.findOne({ where: { id: id(req), societyId: sid(req) } });
    if (!imp) throw statementNotFound();
    if (imp.status !== 'PARSED')
      throw invalidState(`The statement is ${imp.status}; auto-match needs a parsed statement`);
    await enqueue(ACCOUNTS_QUEUE, JOBS.autoMatch, {
      societyId: sid(req),
      importId: id(req),
      requestId: req.ctx.requestId,
    });
    res.status(202).json({ success: true, data: statementDto(imp), message: 'Auto-match queued' });
  }),
  markReconciled: h(async (req, res) =>
    ok(
      res,
      await match.markReconciled(req.ctx, id(req), v(req).body as { version: number }),
      'Statement reconciled',
    ),
  ),
  candidates: h(async (req, res) => ok(res, await match.candidatesFor(sid(req), id(req)))),
  match: h(async (req, res) =>
    ok(
      res,
      await match.matchLine(req.ctx, id(req), v(req).body as { journalLineId: number; version: number }),
      'Line matched',
    ),
  ),
  unmatch: h(async (req, res) =>
    ok(res, await match.unmatchLine(req.ctx, id(req), v(req).body as { version: number }), 'Line unmatched'),
  ),
  ignore: h(async (req, res) =>
    ok(
      res,
      await match.ignoreLine(req.ctx, id(req), v(req).body as { reason: string; version: number }),
      'Line ignored',
    ),
  ),
  createEntry: h(async (req, res) =>
    res.status(201).json({
      success: true,
      data: await match.createEntryFromLine(
        req.ctx,
        id(req),
        v(req).body as { ledgerAccountCode: string; narration?: string; version: number },
      ),
      message: 'Entry posted and matched',
    }),
  ),
  brs: h(async (req, res) =>
    ok(res, await bankReconciliation(sid(req), id(req), (v(req).query as { asOf?: string }).asOf)),
  ),
};
