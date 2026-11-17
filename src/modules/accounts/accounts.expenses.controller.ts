import type { Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../../utils/asyncHandler';
import { created, ok, okList } from '../../utils/response';
import { cashBook } from './accounts.cashbook.service';
import { exportExpenses, listExpenses, viewExpense } from './accounts.expenses.read';
import { reverseExpense } from './accounts.expenses.reverse';
import {
  createExpense,
  deleteExpense,
  submitExpense,
  updateExpense,
  withdrawExpense,
} from './accounts.expenses.service';
import type {
  CashBookQuery,
  CreateExpenseBody,
  ExpenseListQuery,
  PatchExpenseBody,
} from './accounts.expenses.validation';

const h = (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler => asyncHandler(fn);
const v = (req: Request) => req.valid;
const id = (req: Request) => v(req).params.id as number;

export const expenseController = {
  cashBook: h(async (req, res) => {
    const r = await cashBook(req.ctx.society!.id, v(req).query as CashBookQuery);
    res.status(200).json({ success: true, data: r.data, message: 'OK', pagination: r.pagination });
  }),
  list: h(async (req, res) => {
    const r = await listExpenses(req.ctx, v(req).query as ExpenseListQuery);
    okList(res, r.data, r.pagination);
  }),
  get: h(async (req, res) => ok(res, await viewExpense(req.ctx, id(req), true))),
  create: h(async (req, res) => {
    const e = await createExpense(req.ctx, v(req).body as CreateExpenseBody);
    created(res, e, e.status === 'POSTED' ? 'Expense posted' : 'Expense saved');
  }),
  patch: h(async (req, res) =>
    ok(res, await updateExpense(req.ctx, id(req), v(req).body as PatchExpenseBody), 'Expense updated'),
  ),
  submit: h(async (req, res) => {
    const e = await submitExpense(req.ctx, id(req), v(req).body as { version: number });
    ok(res, e, e.status === 'POSTED' ? 'Expense posted' : 'Expense sent for approval');
  }),
  withdraw: h(async (req, res) =>
    ok(
      res,
      await withdrawExpense(req.ctx, id(req), v(req).body as { version: number; reason: string }),
      'Expense withdrawn',
    ),
  ),
  remove: h(async (req, res) =>
    ok(
      res,
      await deleteExpense(req.ctx, id(req), v(req).body as { version: number; reason: string }),
      'Expense cancelled',
    ),
  ),
  reverse: h(async (req, res) =>
    ok(
      res,
      await reverseExpense(
        req.ctx,
        id(req),
        v(req).body as { reversalDate?: string; reason: string; version: number },
      ),
      'Expense reversed',
    ),
  ),
  export: h(async (req, res) => {
    const { format: _format, ...q } = v(req).query as ExpenseListQuery & { format: string };
    const file = await exportExpenses(req.ctx, q);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="expenses.csv"');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(file);
  }),
};
