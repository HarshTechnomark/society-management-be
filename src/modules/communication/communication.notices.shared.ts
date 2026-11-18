import type { Transaction } from 'sequelize';
import { Notice } from '../../models';
import { emitToRoom } from '../../lib/realtime';
import { settings } from '../society-setup/society-setup.public';
import { ConflictError, NotFoundError } from '../../utils/errors';
import type { Ctx, SystemCtx } from '../../types/context';
import { ERR, RT, roomAdmin, LANGUAGE_TO_LOCALE } from './communication.constants';
import { AppError } from '../../utils/errors';

/** Small helpers shared by the notice files (16.1). */
export const n = (v: unknown): number => Number(v);
export const noticeNumber = (id: number): string => `NTC-${String(id).padStart(6, '0')}`;
export const notFound = (): NotFoundError => new NotFoundError(ERR.noticeNotFound, 'Notice not found');
export const stale = (): AppError =>
  new AppError(409, ERR.staleVersion, 'This notice changed. Reload and try again.');

export function societyIdOf(ctx: Ctx | SystemCtx): number {
  const id = ctx.society?.id;
  if (!id) throw new Error('communication: the context carries no society');
  return id;
}

/** BR-16-4 / 8.5: `404 NOTICE_NOT_FOUND` for unknown, deleted or other-society ids. */
export async function findNotice(
  ctx: Ctx | SystemCtx,
  id: number,
  t?: Transaction,
  lock = false,
): Promise<Notice> {
  const row = await Notice.findOne({
    where: { id, societyId: societyIdOf(ctx) },
    ...(t ? { transaction: t } : {}),
    ...(t && lock ? { lock: t.LOCK.UPDATE } : {}),
  });
  if (!row) throw notFound();
  return row;
}

/** Row lock plus the optional optimistic-lock check. */
export async function lockNotice(
  ctx: Ctx | SystemCtx,
  id: number,
  t: Transaction,
  version?: number,
): Promise<Notice> {
  const row = await findNotice(ctx, id, t, true);
  if (version !== undefined && n(row.version) !== version) throw stale();
  return row;
}

export const settingNum = async (societyId: number, key: string): Promise<number> =>
  Number(await settings.get(societyId, key as never));

export async function societyLocale(societyId: number): Promise<string> {
  const lang = String(await settings.get(societyId, 'communication.defaultLanguage' as never));
  return LANGUAGE_TO_LOCALE[lang] ?? 'en-IN';
}

export const emitNoticeUpdated = (societyId: number, noticeId: number, status: string): void =>
  emitToRoom(roomAdmin(societyId), RT.noticeUpdated, { noticeId, status });

export const conflict = (code: string, message: string): ConflictError => new ConflictError(code, message);

/** Society-local day bounds (societies run on IST, BR-08). `to` is inclusive. */
export const istDayStart = (ymd: string): Date => new Date(`${ymd}T00:00:00.000+05:30`);
export const istDayEnd = (ymd: string): Date =>
  new Date(new Date(`${ymd}T00:00:00.000+05:30`).getTime() + 86_400_000);
