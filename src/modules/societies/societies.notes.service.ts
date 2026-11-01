import { Society, SocietyNote, User, sequelize } from '../../models';
import type { NoteCategory } from '../../models/society-note.model';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { AUDIT } from './societies.types';
import { societyNotFound } from './societies.lifecycle';

/** Platform-internal society notes (8.16, BR-05-34). Never returned by a society route or included in exports. */

const noteNotFound = () => new NotFoundError('SOCIETY_NOTE_NOT_FOUND', 'Note not found');
const EDIT_WINDOW_MS = 24 * 3_600_000;
const PIN_LIMIT = 3;
const canEditAny = (ctx: Ctx) => Boolean(ctx.platformPermissions?.has('platform.societies.edit'));

type NoteRow = SocietyNote & { author?: User };
function view(ctx: Ctx, n: NoteRow) {
  const own = n.createdBy === ctx.user?.id;
  return {
    id: n.id!,
    category: n.category,
    body: n.body,
    isPinned: n.isPinned,
    author: { id: n.createdBy, name: n.author?.name ?? 'Platform user' },
    createdAt: n.createdAt!.toISOString(),
    updatedAt: n.updatedAt!.toISOString(),
    canEdit: (own && now().getTime() - n.createdAt!.getTime() < EDIT_WINDOW_MS) || canEditAny(ctx),
    canDelete: own || canEditAny(ctx),
    version: n.version,
  };
}

async function assertSociety(societyId: number): Promise<void> {
  if (!(await Society.findByPk(societyId, { attributes: ['id'] }))) throw societyNotFound();
}

export async function listNotes(
  ctx: Ctx,
  societyId: number,
  q: { category?: NoteCategory; page: number; limit: number },
) {
  await assertSociety(societyId);
  const where: Record<string, unknown> = { societyId };
  if (q.category) where.category = q.category;
  const { rows, count } = await SocietyNote.findAndCountAll({
    where,
    include: [{ model: User, as: 'author', attributes: ['id', 'name'] }],
    order: [
      ['isPinned', 'DESC'],
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
    distinct: true,
  });
  return { data: rows.map(r => view(ctx, r as NoteRow)), pagination: pageMeta(q.page, q.limit, count) };
}

async function pinnedCount(societyId: number, t: import('sequelize').Transaction, exceptId?: number) {
  const rows = await SocietyNote.findAll({
    where: { societyId, isPinned: true },
    attributes: ['id'],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  return rows.filter(r => r.id !== exceptId).length;
}

async function loadView(ctx: Ctx, id: number) {
  const n = (await SocietyNote.findByPk(id, {
    include: [{ model: User, as: 'author', attributes: ['id', 'name'] }],
  })) as NoteRow;
  return view(ctx, n);
}

export async function createNote(
  ctx: Ctx,
  societyId: number,
  input: { body: string; category: NoteCategory; isPinned: boolean },
) {
  const id = await sequelize.transaction(async t => {
    const s = await Society.findByPk(societyId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!s) throw societyNotFound();
    if (input.isPinned && (await pinnedCount(societyId, t)) >= PIN_LIMIT)
      throw new UnprocessableError('NOTE_PIN_LIMIT', 'At most 3 notes can be pinned');
    const n = await SocietyNote.create(
      {
        societyId,
        category: input.category,
        body: input.body,
        isPinned: input.isPinned,
        version: 1,
        createdBy: ctx.user!.id,
        updatedBy: ctx.user!.id,
      },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.noteCreated,
        entityType: 'society_note',
        entityId: n.id!,
        societyId,
        after: { category: n.category, isPinned: n.isPinned, body: n.body },
      },
      t,
    );
    return n.id!;
  });
  return loadView(ctx, id);
}

export async function updateNote(
  ctx: Ctx,
  societyId: number,
  noteId: number,
  input: { body?: string; category?: NoteCategory; isPinned?: boolean; version: number },
) {
  await sequelize.transaction(async t => {
    const n = await SocietyNote.findOne({
      where: { id: noteId, societyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!n) throw noteNotFound();
    if (n.version !== input.version) throw new ConflictError('STALE_VERSION', 'Reload and try again');
    const own = n.createdBy === ctx.user!.id;
    const changesBody = input.body !== undefined && input.body !== n.body;
    const changesCategory = input.category !== undefined && input.category !== n.category;
    const changesPin = input.isPinned !== undefined && input.isPinned !== n.isPinned;
    if ((changesBody || changesCategory) && !own)
      throw new ForbiddenError('NOT_NOTE_AUTHOR', 'Only the author can edit this note');
    if (changesBody && now().getTime() - n.createdAt!.getTime() >= EDIT_WINDOW_MS)
      throw new UnprocessableError('NOTE_EDIT_WINDOW_CLOSED', 'Notes can be edited for 24 hours only');
    if (changesPin && !own && !canEditAny(ctx))
      throw new ForbiddenError('NOT_NOTE_AUTHOR', 'Only the author can pin this note');
    if (changesPin && input.isPinned && (await pinnedCount(societyId, t, n.id!)) >= PIN_LIMIT)
      throw new UnprocessableError('NOTE_PIN_LIMIT', 'At most 3 notes can be pinned');
    const before = { body: n.body, category: n.category, isPinned: n.isPinned };
    if (input.body !== undefined) n.body = input.body;
    if (input.category !== undefined) n.category = input.category;
    if (input.isPinned !== undefined) n.isPinned = input.isPinned;
    n.version += 1;
    n.updatedBy = ctx.user!.id;
    await n.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.noteUpdated,
        entityType: 'society_note',
        entityId: n.id!,
        societyId,
        before,
        after: { body: n.body, category: n.category, isPinned: n.isPinned },
      },
      t,
    );
  });
  return loadView(ctx, noteId);
}

export async function deleteNote(ctx: Ctx, societyId: number, noteId: number): Promise<void> {
  await sequelize.transaction(async t => {
    const n = await SocietyNote.findOne({
      where: { id: noteId, societyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!n) throw noteNotFound();
    if (n.createdBy !== ctx.user!.id && !canEditAny(ctx))
      throw new ForbiddenError('NOT_NOTE_AUTHOR', 'Only the author can delete this note');
    await n.destroy({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.noteDeleted,
        entityType: 'society_note',
        entityId: n.id!,
        societyId,
        before: { body: n.body, category: n.category },
      },
      t,
    );
  });
}
