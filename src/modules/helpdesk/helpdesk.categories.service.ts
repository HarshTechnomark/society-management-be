import { Op, UniqueConstraintError, type Transaction } from 'sequelize';
import { Role, SlaPolicy, TicketCategory, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, ConflictError, NotFoundError, UnprocessableError } from '../../utils/errors';
import type { FieldError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import {
  AUDIT,
  ENTITY,
  ERR,
  LIMITS,
  type CategoryScope,
  type DefaultAssigneeType,
  type Priority,
} from './helpdesk.constants';
import { validateAssignee } from './helpdesk.routing';
import { ensureSeededOnce } from './helpdesk.seed';
import { societyIdOf } from './helpdesk.shared';

/** Categories and sub-categories (spec 8.1 to 8.3, BR-15-63). Two levels, archived instead of deleted, optimistic lock on `version`. */
export interface CategoryDto {
  id: number;
  name: string;
  scope: CategoryScope;
  icon: string | null;
  defaultPriority: Priority | null;
  slaPolicyId: number | null;
  defaultAssigneeType?: DefaultAssigneeType;
  defaultRoleKey?: string | null;
  defaultAssigneeUserId?: number | null;
  defaultStaffId?: number | null;
  defaultVendorId?: number | null;
  isChargeable: boolean;
  requiresAfterPhoto: boolean;
  isSafety: boolean;
  linksInvoice: boolean;
  sortOrder: number;
  status: string;
  version: number;
  parentId: number | null;
  children?: CategoryDto[];
}

const dto = (c: TicketCategory, withAssignee: boolean): CategoryDto => ({
  id: c.id,
  parentId: c.parentId,
  name: c.name,
  scope: c.scope,
  icon: c.icon,
  defaultPriority: c.defaultPriority,
  slaPolicyId: c.slaPolicyId,
  ...(withAssignee
    ? {
        defaultAssigneeType: c.defaultAssigneeType,
        defaultRoleKey: c.defaultRoleKey,
        defaultAssigneeUserId: c.defaultAssigneeUserId,
        defaultStaffId: c.defaultStaffId,
        defaultVendorId: c.defaultVendorId,
      }
    : {}),
  isChargeable: c.isChargeable,
  requiresAfterPhoto: c.requiresAfterPhoto,
  isSafety: c.isSafety,
  linksInvoice: c.linksInvoice,
  sortOrder: c.sortOrder,
  status: c.status,
  version: c.version,
});

const byOrder = (a: TicketCategory, b: TicketCategory) =>
  a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);

/** The tree 8.1. `status` filters admin lists; `kind` (resident, gate, work) returns ACTIVE categories whose scope includes it, without assignee fields. */
async function tree(
  societyId: number,
  o: { status: 'ACTIVE' | 'ARCHIVED' | 'ALL'; scope?: 'PERSONAL' | 'BUILDING'; withAssignee: boolean },
): Promise<CategoryDto[]> {
  const rows = await TicketCategory.findAll({ where: { societyId } });
  const okStatus = (c: TicketCategory) => o.status === 'ALL' || c.status === o.status;
  const okScope = (c: TicketCategory) => !o.scope || c.scope === 'BOTH' || c.scope === o.scope;
  const kids = new Map<number, TicketCategory[]>();
  for (const c of rows) if (c.parentId) kids.set(c.parentId, [...(kids.get(c.parentId) ?? []), c]);
  const out: CategoryDto[] = [];
  for (const p of rows.filter(r => !r.parentId).sort(byOrder)) {
    const children = (kids.get(p.id) ?? []).filter(c => okStatus(c) && okScope(c)).sort(byOrder);
    if (!okScope(p) || !(okStatus(p) || children.length)) continue;
    out.push({ ...dto(p, o.withAssignee), children: children.map(c => ({ ...dto(c, o.withAssignee) })) });
  }
  return out;
}

export async function listCategories(
  ctx: Ctx,
  q: { status: 'ACTIVE' | 'ARCHIVED' | 'ALL'; scope?: 'PERSONAL' | 'BUILDING' },
): Promise<CategoryDto[]> {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  return tree(societyId, { ...q, withAssignee: true });
}

/** `/me`, `/gate` and `/work` lists: ACTIVE only, scope including `kind`, no assignee fields. */
export async function listCategoriesFor(ctx: Ctx, kind: 'PERSONAL' | 'BUILDING'): Promise<CategoryDto[]> {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  return tree(societyId, { status: 'ACTIVE', scope: kind, withAssignee: false });
}

// ---------------------------------------------------------------- validation helpers
const invalid = (code: string, message: string, field: string): AppError =>
  new UnprocessableError(code, message, [{ field, message }]);

const SCOPE_OK: Record<CategoryScope, CategoryScope[]> = {
  BOTH: ['PERSONAL', 'BUILDING', 'BOTH'],
  PERSONAL: ['PERSONAL'],
  BUILDING: ['BUILDING'],
};

interface Draft {
  parentId: number | null;
  name: string;
  scope: CategoryScope;
  icon: string | null;
  defaultPriority: Priority | null;
  slaPolicyId: number | null;
  defaultAssigneeType: DefaultAssigneeType;
  defaultRoleKey: string | null;
  defaultAssigneeUserId: number | null;
  defaultStaffId: number | null;
  defaultVendorId: number | null;
  isChargeable: boolean;
  requiresAfterPhoto: boolean;
  isSafety: boolean;
  linksInvoice: boolean;
  sortOrder: number;
}

/** BR-15-63: scope against the parent, flags against scope, top-level defaults, assignee fields that match the type. */
function checkShape(d: Draft, parent: TicketCategory | null): void {
  if (parent && !SCOPE_OK[parent.scope].includes(d.scope))
    throw invalid(ERR.categoryScopeMismatch, 'A sub-category scope cannot be wider than its parent', 'scope');
  if ((d.isChargeable || d.linksInvoice) && d.scope === 'BUILDING')
    throw invalid(
      ERR.categoryScopeMismatch,
      'Chargeable and invoice-linked categories need the scope PERSONAL or BOTH',
      d.isChargeable ? 'isChargeable' : 'linksInvoice',
    );
  if (!d.parentId) {
    if (!d.defaultPriority)
      throw invalid(
        ERR.categoryDefaultsRequired,
        'A top-level category needs a default priority',
        'defaultPriority',
      );
    if (d.defaultAssigneeType === 'INHERIT')
      throw invalid(
        ERR.categoryDefaultsRequired,
        'A top-level category cannot inherit its assignee',
        'defaultAssigneeType',
      );
  }
  const t = d.defaultAssigneeType;
  const errors: FieldError[] = [];
  const need = (on: boolean, field: string, value: unknown) => {
    if (on && value == null) errors.push({ field, message: `Required for the assignee type ${t}` });
    if (!on && value != null) errors.push({ field, message: `Not allowed for the assignee type ${t}` });
  };
  need(t === 'ROLE', 'defaultRoleKey', d.defaultRoleKey);
  need(t === 'MEMBER', 'defaultAssigneeUserId', d.defaultAssigneeUserId);
  need(t === 'STAFF', 'defaultStaffId', d.defaultStaffId);
  need(t === 'VENDOR', 'defaultVendorId', d.defaultVendorId);
  if (errors.length)
    throw new UnprocessableError(
      ERR.defaultAssigneeInvalid,
      'The default assignee fields do not match its type',
      errors,
    );
}

/** BR-15-35 checks of the default assignee; unknown user, staff or vendor stays `404 ASSIGNEE_NOT_FOUND`, the plan check `402`, the rest `422 DEFAULT_ASSIGNEE_INVALID`. */
async function checkAssignee(ctx: Ctx, d: Draft, t: Transaction): Promise<void> {
  const societyId = societyIdOf(ctx);
  if (d.defaultAssigneeType === 'ROLE') {
    const role = await Role.findOne({
      where: { societyId, key: d.defaultRoleKey!, scope: { [Op.in]: ['society', 'work'] } },
      transaction: t,
    });
    if (!role) throw invalid(ERR.defaultAssigneeInvalid, 'Unknown role for this society', 'defaultRoleKey');
    return;
  }
  const input =
    d.defaultAssigneeType === 'MEMBER'
      ? { type: 'MEMBER' as const, userId: d.defaultAssigneeUserId! }
      : d.defaultAssigneeType === 'STAFF'
        ? { type: 'STAFF' as const, staffId: d.defaultStaffId! }
        : d.defaultAssigneeType === 'VENDOR'
          ? { type: 'VENDOR' as const, vendorId: d.defaultVendorId! }
          : null;
  if (!input) return;
  try {
    await validateAssignee(ctx, input);
  } catch (e) {
    if (e instanceof AppError && e.status !== 402 && e.code !== ERR.assigneeNotFound)
      throw new UnprocessableError(ERR.defaultAssigneeInvalid, 'The default assignee is not valid', [
        { field: 'defaultAssignee', message: e.message },
      ]);
    throw e;
  }
}

async function checkPolicy(societyId: number, id: number | null, t: Transaction): Promise<void> {
  if (id == null) return;
  const p = await SlaPolicy.findOne({ where: { id, societyId, status: 'ACTIVE' }, transaction: t });
  if (!p) throw new NotFoundError(ERR.slaPolicyNotFound, 'SLA policy not found');
}

async function nameFree(
  societyId: number,
  d: { parentId: number | null; name: string },
  selfId: number | null,
  t: Transaction,
) {
  const clash = await TicketCategory.findOne({
    where: {
      societyId,
      parentId: d.parentId,
      name: d.name,
      status: 'ACTIVE',
      ...(selfId ? { id: { [Op.ne]: selfId } } : {}),
    },
    transaction: t,
  });
  if (clash) throw new ConflictError(ERR.categoryNameTaken, 'A category with this name already exists here');
}

const asNameTaken = (e: unknown): never => {
  if (e instanceof UniqueConstraintError)
    throw new ConflictError(ERR.categoryNameTaken, 'A category with this name already exists here');
  throw e;
};

async function checkLimit(societyId: number, parentId: number | null, t: Transaction): Promise<void> {
  const n = await TicketCategory.count({ where: { societyId, parentId, status: 'ACTIVE' }, transaction: t });
  const max = parentId ? LIMITS.maxSubCategoriesPerParent : LIMITS.maxActiveTopCategories;
  if (n >= max)
    throw new UnprocessableError(
      ERR.categoryLimitReached,
      parentId ? `At most ${max} sub-categories per category` : `At most ${max} active categories`,
    );
}

const findCategory = async (societyId: number, id: number, t: Transaction, lock = false) => {
  const c = await TicketCategory.findOne({
    where: { id, societyId },
    transaction: t,
    ...(lock ? { lock: t.LOCK.UPDATE } : {}),
  });
  if (!c) throw new NotFoundError(ERR.categoryNotFound, 'Category not found');
  return c;
};

const stale = (): AppError =>
  new ConflictError(ERR.staleVersion, 'The category was changed by someone else. Reload and try again.');

const snapshot = (c: TicketCategory) => ({
  name: c.name,
  scope: c.scope,
  parentId: c.parentId,
  icon: c.icon,
  defaultPriority: c.defaultPriority,
  slaPolicyId: c.slaPolicyId,
  defaultAssigneeType: c.defaultAssigneeType,
  defaultRoleKey: c.defaultRoleKey,
  defaultAssigneeUserId: c.defaultAssigneeUserId,
  defaultStaffId: c.defaultStaffId,
  defaultVendorId: c.defaultVendorId,
  isChargeable: c.isChargeable,
  requiresAfterPhoto: c.requiresAfterPhoto,
  isSafety: c.isSafety,
  linksInvoice: c.linksInvoice,
  sortOrder: c.sortOrder,
  status: c.status,
});

// ---------------------------------------------------------------- writes
export interface CategoryCreateInput extends Partial<Omit<Draft, 'name' | 'scope'>> {
  name: string;
  scope: CategoryScope;
}

export async function createCategory(ctx: Ctx, input: CategoryCreateInput): Promise<CategoryDto> {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  return sequelize.transaction(async t => {
    let parent: TicketCategory | null = null;
    if (input.parentId) {
      parent = await findCategory(societyId, input.parentId, t, true);
      if (parent.parentId)
        throw invalid(ERR.categoryDepthExceeded, 'Categories have two levels only', 'parentId');
      if (parent.status !== 'ACTIVE')
        throw invalid(ERR.categoryArchived, 'The parent category is archived', 'parentId');
    }
    const d: Draft = {
      parentId: parent?.id ?? null,
      name: input.name,
      scope: input.scope,
      icon: input.icon ?? null,
      defaultPriority: input.defaultPriority ?? null,
      slaPolicyId: input.slaPolicyId ?? null,
      defaultAssigneeType: input.defaultAssigneeType ?? (parent ? 'INHERIT' : (undefined as never)),
      defaultRoleKey: input.defaultRoleKey ?? null,
      defaultAssigneeUserId: input.defaultAssigneeUserId ?? null,
      defaultStaffId: input.defaultStaffId ?? null,
      defaultVendorId: input.defaultVendorId ?? null,
      isChargeable: input.isChargeable ?? false,
      requiresAfterPhoto: input.requiresAfterPhoto ?? false,
      isSafety: input.isSafety ?? false,
      linksInvoice: input.linksInvoice ?? false,
      sortOrder: input.sortOrder ?? 0,
    };
    if (!d.defaultAssigneeType)
      throw invalid(
        ERR.categoryDefaultsRequired,
        'A top-level category needs a default assignee type',
        'defaultAssigneeType',
      );
    checkShape(d, parent);
    await checkPolicy(societyId, d.slaPolicyId, t);
    await checkAssignee(ctx, d, t);
    await checkLimit(societyId, d.parentId, t);
    await nameFree(societyId, d, null, t);
    const row = await TicketCategory.create(
      {
        societyId,
        ...d,
        status: 'ACTIVE',
        archivedAt: null,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: t },
    ).catch(asNameTaken);
    await audit(
      ctx,
      {
        action: AUDIT.categoryCreated,
        entityType: ENTITY.category,
        entityId: row.id,
        entityLabel: row.name,
        societyId,
        after: snapshot(row),
      },
      t,
    );
    return dto(row, true);
  });
}

export type CategoryPatchInput = Partial<CategoryCreateInput> & { version: number };

export async function updateCategory(ctx: Ctx, id: number, input: CategoryPatchInput): Promise<CategoryDto> {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  return sequelize.transaction(async t => {
    const row = await findCategory(societyId, id, t, true);
    if (row.version !== input.version) throw stale();
    if (row.status === 'ARCHIVED') throw invalid(ERR.categoryArchived, 'The category is archived', 'id');
    const before = snapshot(row);
    const parent = row.parentId ? await findCategory(societyId, row.parentId, t) : null;

    const has = (k: keyof CategoryPatchInput) => input[k] !== undefined;
    const typeChanged = has('defaultAssigneeType') && input.defaultAssigneeType !== row.defaultAssigneeType;
    const pick = <K extends keyof Draft>(k: K, resetOnTypeChange = false): Draft[K] =>
      has(k)
        ? (input[k] as Draft[K])
        : resetOnTypeChange && typeChanged
          ? (null as Draft[K])
          : (row[k] as Draft[K]);
    const d: Draft = {
      parentId: row.parentId,
      name: pick('name'),
      scope: pick('scope'),
      icon: pick('icon'),
      defaultPriority: pick('defaultPriority'),
      slaPolicyId: pick('slaPolicyId'),
      defaultAssigneeType: pick('defaultAssigneeType'),
      defaultRoleKey: pick('defaultRoleKey', true),
      defaultAssigneeUserId: pick('defaultAssigneeUserId', true),
      defaultStaffId: pick('defaultStaffId', true),
      defaultVendorId: pick('defaultVendorId', true),
      isChargeable: pick('isChargeable'),
      requiresAfterPhoto: pick('requiresAfterPhoto'),
      isSafety: pick('isSafety'),
      linksInvoice: pick('linksInvoice'),
      sortOrder: pick('sortOrder'),
    };
    checkShape(d, parent);
    if (has('scope') && d.scope !== row.scope && !row.parentId) {
      const kids = await TicketCategory.findAll({
        where: { societyId, parentId: row.id, status: 'ACTIVE' },
        transaction: t,
      });
      if (kids.some(k => !SCOPE_OK[d.scope].includes(k.scope)))
        throw invalid(
          ERR.categoryScopeMismatch,
          'A sub-category scope would be wider than this category',
          'scope',
        );
    }
    if (has('slaPolicyId') && d.slaPolicyId !== row.slaPolicyId)
      await checkPolicy(societyId, d.slaPolicyId, t);
    const assigneeTouched = (
      [
        'defaultAssigneeType',
        'defaultRoleKey',
        'defaultAssigneeUserId',
        'defaultStaffId',
        'defaultVendorId',
      ] as const
    ).some(k => d[k] !== row[k]);
    if (assigneeTouched) await checkAssignee(ctx, d, t);
    if (d.name !== row.name) await nameFree(societyId, d, row.id, t);

    row.set({ ...d });
    if (!row.changed()) return dto(row, true);
    row.updatedBy = ctx.user?.id ?? null;
    row.version += 1;
    await row.save({ transaction: t }).catch(asNameTaken);
    await audit(
      ctx,
      {
        action: AUDIT.categoryUpdated,
        entityType: ENTITY.category,
        entityId: row.id,
        entityLabel: row.name,
        societyId,
        before,
        after: snapshot(row),
      },
      t,
    );
    return dto(row, true);
  });
}

/** 8.3 archive: the category and its active sub-categories. */
export async function archiveCategory(ctx: Ctx, id: number, version: number): Promise<CategoryDto> {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  return sequelize.transaction(async t => {
    const row = await findCategory(societyId, id, t, true);
    if (row.version !== version) throw stale();
    if (row.status === 'ARCHIVED')
      throw new ConflictError(ERR.invalidState, 'The category is already archived');
    const at = now();
    const children = row.parentId
      ? []
      : await TicketCategory.findAll({
          where: { societyId, parentId: row.id, status: 'ACTIVE' },
          transaction: t,
          lock: t.LOCK.UPDATE,
        });
    for (const c of children) {
      c.set({ status: 'ARCHIVED', archivedAt: at, updatedBy: ctx.user?.id ?? null });
      c.version += 1;
      await c.save({ transaction: t });
    }
    row.set({ status: 'ARCHIVED', archivedAt: at, updatedBy: ctx.user?.id ?? null });
    row.version += 1;
    await row.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.categoryArchived,
        entityType: ENTITY.category,
        entityId: row.id,
        entityLabel: row.name,
        societyId,
        before: { status: 'ACTIVE' },
        after: { status: 'ARCHIVED', archivedChildren: children.map(c => c.id) },
      },
      t,
    );
    return dto(row, true);
  });
}

/** 8.3 restore: a sub-category needs an ACTIVE parent and a free name; sub-categories archived with a parent stay archived until restored one by one. */
export async function restoreCategory(ctx: Ctx, id: number, version: number): Promise<CategoryDto> {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  return sequelize.transaction(async t => {
    const row = await findCategory(societyId, id, t, true);
    if (row.version !== version) throw stale();
    if (row.status === 'ACTIVE') throw new ConflictError(ERR.invalidState, 'The category is already active');
    if (row.parentId) {
      const parent = await findCategory(societyId, row.parentId, t, true);
      if (parent.status !== 'ACTIVE')
        throw invalid(ERR.categoryArchived, 'Restore the parent category first', 'id');
    }
    await nameFree(societyId, row, row.id, t);
    await checkLimit(societyId, row.parentId, t);
    let slaPolicyId = row.slaPolicyId;
    if (slaPolicyId) {
      const p = await SlaPolicy.findOne({
        where: { id: slaPolicyId, societyId, status: 'ACTIVE' },
        transaction: t,
      });
      if (!p) slaPolicyId = null; // its policy was archived meanwhile: fall back to the society default
    }
    row.set({ status: 'ACTIVE', archivedAt: null, slaPolicyId, updatedBy: ctx.user?.id ?? null });
    row.version += 1;
    await row.save({ transaction: t }).catch(asNameTaken);
    await audit(
      ctx,
      {
        action: AUDIT.categoryRestored,
        entityType: ENTITY.category,
        entityId: row.id,
        entityLabel: row.name,
        societyId,
        before: { status: 'ARCHIVED' },
        after: { status: 'ACTIVE', slaPolicyId },
      },
      t,
    );
    return dto(row, true);
  });
}
