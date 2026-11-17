import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok } from '../../utils/response';
import {
  closeBankAccount,
  createBankAccount,
  getBankAccountDto,
  listBankAccounts,
  patchBankAccount,
  revealAccountNumber,
  setCollectionAccount,
  verifyBankAccount,
} from './accounts.bank.service';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const sid = (req: Request): number => req.ctx.society!.id;

export const bankController = {
  list: h(async (req, res) => ok(res, await listBankAccounts(sid(req), v(req).query))),
  get: h(async (req, res) => ok(res, await getBankAccountDto(sid(req), v(req).params.id))),
  create: h(async (req, res) =>
    created(res, await createBankAccount(req.ctx, v(req).body), 'Bank account added'),
  ),
  patch: h(async (req, res) =>
    ok(res, await patchBankAccount(req.ctx, v(req).params.id, v(req).body), 'Bank account updated'),
  ),
  verify: h(async (req, res) =>
    ok(res, await verifyBankAccount(req.ctx, v(req).params.id, v(req).body.version), 'Bank account verified'),
  ),
  setCollection: h(async (req, res) =>
    ok(
      res,
      await setCollectionAccount(req.ctx, v(req).params.id, v(req).body.version),
      'Collection account set',
    ),
  ),
  close: h(async (req, res) =>
    ok(res, await closeBankAccount(req.ctx, v(req).params.id, v(req).body), 'Bank account closed'),
  ),
  reveal: h(async (req, res) => {
    const data = await revealAccountNumber(req.ctx, v(req).params.id);
    res.setHeader('Cache-Control', 'no-store');
    return ok(res, data);
  }),
};
