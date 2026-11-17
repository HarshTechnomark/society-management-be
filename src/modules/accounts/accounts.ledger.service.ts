import { UniqueConstraintError } from 'sequelize';
import { LedgerAccount, SocietyBalance, sequelize } from '../../models';
import { audit } from '../../utils/audit';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from '../../utils/errors';
import { moneyTx } from '../payments/payments.shared';
import { AUDIT, ERR, PERM } from './accounts.constants';
import { ensureBooks } from './accounts.chart';
import { n, societyIdOf } from './accounts.shared';
import type { LedgerCreateInput, LedgerListQuery, LedgerPatchInput } from './accounts.ledger.validation';
import type { Ctx } from './accounts.types';

/** Groups whose children the system creates (bank accounts and funds, 13.2): custom accounts cannot go under them. */
const SYSTEM_MANAGED_PARENTS = ['1110', '2440', '2450'];

export interface LedgerNode {
  id: number;
  code: string;
  name: string;
  accountType: string;
  subtype: string;
  isGroup: boolean;
  isActive: boolean;
  isSystem: boolean;
  isCashBookCategory: boolean;
  transparencyCategory: string | null;
  description: string | null;
  version: number;
  balancePaise?: number;
  children: LedgerNode[];
}

const toNode = (a: LedgerAccount, withBalance: boolean): LedgerNode => ({
  id: n(a.id),
  code: a.code,
  name: a.name,
  accountType: a.accountType,
  subtype: a.subtype,
  isGroup: Boolean(a.isGroup),
  isActive: Boolean(a.isActive),
  isSystem: Boolean(a.isSystem),
  isCashBookCategory: Boolean(a.isCashBookCategory),
  transparencyCategory: a.transparencyCategory,
  description: a.description,
  version: n(a.version),
  ...(withBalance ? { balancePaise: n(a.balancePaise) } : {}),
  children: [],
});

const auditShape = (a: LedgerAccount) => ({
  code: a.code,
  name: a.name,
  accountType: a.accountType,
  subtype: a.subtype,
  parentId: a.parentId === null ? null : n(a.parentId),
  isGroup: Boolean(a.isGroup),
  isActive: Boolean(a.isActive),
  isCashBookCategory: Boolean(a.isCashBookCategory),
  transparencyCategory: a.transparencyCategory,
  description: a.description,
});

/** 8.10 GET: the chart as a tree; group balances are sums of their children; `balancePaise` is left out without `finance.accounts.view`. */
export async function listLedgerAccounts(ctx: Ctx, q: LedgerListQuery): Promise<LedgerNode[]> {
  const societyId = societyIdOf(ctx);
  const books = await SocietyBalance.findOne({ where: { societyId }, attributes: ['chartSeededAt'] });
  if (!books?.chartSeededAt) await sequelize.transaction(t => ensureBooks(t, societyId));
  const rows = await LedgerAccount.findAll({ where: { societyId }, order: [['code', 'ASC']] });
  const withBalance = Boolean(ctx.permissions?.has(PERM.accountsView));
  const nodes = new Map<number, LedgerNode>(rows.map(a => [n(a.id), toNode(a, withBalance)]));
  const roots: LedgerNode[] = [];
  for (const a of rows) {
    const node = nodes.get(n(a.id))!;
    const parent = a.parentId === null ? undefined : nodes.get(n(a.parentId));
    (parent ? parent.children : roots).push(node);
  }
  const sumUp = (node: LedgerNode): number => {
    if (!node.children.length) return node.balancePaise ?? 0;
    const total = node.children.reduce((s, c) => s + sumUp(c), 0);
    if (withBalance) node.balancePaise = total;
    return total;
  };
  if (withBalance) roots.forEach(sumUp);
  const keep = (node: LedgerNode): boolean => {
    node.children = node.children.filter(keep);
    if (q.activeOnly && !node.isActive) return false;
    if (q.type && node.accountType !== q.type) return false;
    if (q.cashBookOnly) return node.children.length > 0 || node.isCashBookCategory;
    return true;
  };
  return roots.filter(keep);
}

const dup = () => new ConflictError(ERR.duplicateLedgerCode, 'This account code is already used');

/** 8.10 POST (Premium): a custom account under a non-system-managed group of the chart. */
export async function createLedgerAccount(ctx: Ctx, input: LedgerCreateInput): Promise<LedgerNode> {
  const societyId = societyIdOf(ctx);
  try {
    return await moneyTx(async t => {
      await ensureBooks(t, societyId);
      const parent = await LedgerAccount.findOne({
        where: { id: input.parentId, societyId },
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!parent) throw new NotFoundError(ERR.ledgerAccountNotFound, 'Parent account not found');
      if (!parent.isGroup || SYSTEM_MANAGED_PARENTS.includes(parent.code))
        throw new UnprocessableError(ERR.invalidParent, 'Choose a group account that is not system-managed', [
          { field: 'parentId', message: 'Not a group, or a system-managed group' },
        ]);
      if (input.code[0] !== parent.code[0])
        throw new ValidationError([
          { field: 'code', message: `The code must start with ${parent.code[0]}, like its parent` },
        ]);
      if (input.isCashBookCategory && (parent.accountType !== 'EXPENSE' || input.isGroup))
        throw new ValidationError([
          {
            field: 'isCashBookCategory',
            message: 'Only expense accounts that take postings can be cash book categories',
          },
        ]);
      if (await LedgerAccount.count({ where: { societyId, code: input.code }, transaction: t })) throw dup();
      const a = await LedgerAccount.create(
        {
          societyId,
          code: input.code,
          name: input.name,
          accountType: parent.accountType,
          subtype: input.subtype,
          parentId: n(parent.id),
          systemKey: null,
          isGroup: input.isGroup,
          isSystem: false,
          isActive: true,
          isCashBookCategory: input.isCashBookCategory,
          transparencyCategory: input.transparencyCategory ?? null,
          description: input.description ?? null,
          createdBy: ctx.user?.id ?? null,
          updatedBy: ctx.user?.id ?? null,
        },
        { transaction: t },
      );
      await audit(
        ctx,
        {
          action: AUDIT.ledgerAccountCreated,
          entityType: 'ledger_account',
          entityId: n(a.id),
          entityLabel: `${a.code} ${a.name}`,
          societyId,
          after: auditShape(a),
        },
        t,
      );
      return toNode(a, true);
    });
  } catch (e) {
    if (e instanceof UniqueConstraintError) throw dup();
    throw e;
  }
}

/** 8.10 PATCH (Premium): rename, activate or deactivate, category flags. Never writes `balancePaise`. */
export async function updateLedgerAccount(
  ctx: Ctx,
  id: number,
  input: LedgerPatchInput,
): Promise<LedgerNode> {
  const societyId = societyIdOf(ctx);
  return moneyTx(async t => {
    await ensureBooks(t, societyId); // the books lock first, then the account row (BR-13-10)
    const a = await LedgerAccount.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!a) throw new NotFoundError(ERR.ledgerAccountNotFound, 'Ledger account not found');
    if (n(a.version) !== input.version)
      throw new ConflictError(ERR.staleVersion, 'This account was changed by someone else; reload it');
    if (a.isSystem) {
      const locked = (['name', 'isActive'] as const).filter(k => input[k] !== undefined && input[k] !== a[k]);
      if (locked.length)
        throw new UnprocessableError(
          ERR.systemAccountLocked,
          'A system account cannot be renamed or deactivated',
          [...locked.map(field => ({ field, message: 'Locked on a system account' }))],
        );
    }
    const before = auditShape(a);
    const isCategory = input.isCashBookCategory ?? Boolean(a.isCashBookCategory);
    if (isCategory && input.isCashBookCategory !== undefined && (a.accountType !== 'EXPENSE' || a.isGroup))
      throw new ValidationError([
        {
          field: 'isCashBookCategory',
          message: 'Only expense accounts that take postings can be cash book categories',
        },
      ]);
    if (input.isActive === false && a.isActive) {
      const activeChildren = await LedgerAccount.count({
        where: { societyId, parentId: n(a.id), isActive: true },
        transaction: t,
      });
      if (n(a.balancePaise) !== 0 || activeChildren > 0)
        throw new UnprocessableError(
          ERR.accountBalanceNotZero,
          'An account can be deactivated only with a zero balance and no active children',
          [{ field: 'isActive', message: 'Balance is not zero, or it has active children' }],
        );
    }
    const patch: Partial<LedgerAccount> = { updatedBy: ctx.user?.id ?? null, version: n(a.version) + 1 };
    if (input.name !== undefined) patch.name = input.name;
    if (input.isActive !== undefined) patch.isActive = input.isActive;
    if (input.isCashBookCategory !== undefined) patch.isCashBookCategory = input.isCashBookCategory;
    if (input.transparencyCategory !== undefined) patch.transparencyCategory = input.transparencyCategory;
    if (input.description !== undefined) patch.description = input.description;
    await a.update(patch, { transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.ledgerAccountUpdated,
        entityType: 'ledger_account',
        entityId: n(a.id),
        entityLabel: `${a.code} ${a.name}`,
        societyId,
        before,
        after: auditShape(a),
      },
      t,
    );
    return toNode(a, Boolean(ctx.permissions?.has(PERM.accountsView)));
  });
}
