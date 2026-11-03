import { QueryTypes } from 'sequelize';
import { Resident, sequelize } from '../../models';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { AUDIT, ENTITY } from './residents.constants';
import { touchReports } from './residents.ports';
import { ownResident } from './residents.service';
import { ForbiddenError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import { settings } from '../society-setup/society-setup.public';
import { isMinorSql } from './residents.directory.sql';
import { societyToday, staleVersion } from './residents.shared';

/** The neighbour directory (BR-09-73, 8.21): ACTIVE, visible, adult residents with an active link; contacts only by choice. */
export interface DirectoryQuery {
  q?: string;
  buildingId?: number;
  sortBy: 'unitLabel' | 'name';
  page: number;
  limit: number;
}

export async function listDirectory(societyId: number, q: DirectoryQuery) {
  if (!(await settings.get(societyId, 'residents.directoryEnabled')))
    throw new ForbiddenError('DIRECTORY_DISABLED', 'The directory is turned off in this society');
  const showTenants = await settings.get(societyId, 'residents.directoryShowTenants');
  const today = await societyToday(societyId);
  const where = [
    'x.societyId = :societyId',
    'x.fromDate <= :today',
    '(x.toDate IS NULL OR x.toDate >= :today)',
    'r.deletedAt IS NULL',
    "r.status = 'ACTIVE'",
    'r.directoryVisible = 1',
    `NOT (${isMinorSql('r.dateOfBirth')})`,
    "u.status = 'ACTIVE'",
  ];
  const rep: Record<string, unknown> = { societyId, today };
  if (!showTenants) where.push("x.relation <> 'TENANT'");
  if (q.buildingId) {
    where.push('u.buildingId = :buildingId');
    rep.buildingId = q.buildingId;
  }
  if (q.q) {
    rep.prefix = `${q.q.trim().replace(/[\\%_]/g, m => `\\${m}`)}%`;
    where.push('(r.name LIKE :prefix OR u.label LIKE :prefix)');
  }
  const from = `FROM unit_residents x JOIN residents r ON r.id = x.residentId JOIN units u ON u.id = x.unitId WHERE ${where.join(' AND ')}`;
  const total = Number(
    (
      await sequelize.query<{ n: number }>(`SELECT COUNT(*) AS n ${from}`, {
        replacements: rep,
        type: QueryTypes.SELECT,
      })
    )[0]?.n ?? 0,
  );
  const order = q.sortBy === 'name' ? 'r.name ASC, u.label ASC' : 'u.floor ASC, u.label ASC, r.name ASC';
  const rows = await sequelize.query<{
    name: string;
    label: string;
    relation: string;
    mobile: string | null;
    email: string | null;
    photoFileId: number | null;
    showMobileInDirectory: number;
    showEmailInDirectory: number;
    showPhotoInDirectory: number;
  }>(
    `SELECT r.name, u.label, x.relation, r.mobile, r.email, r.photoFileId, r.showMobileInDirectory,
            r.showEmailInDirectory, r.showPhotoInDirectory ${from} ORDER BY ${order}, x.id ASC LIMIT :limit OFFSET :offset`,
    { replacements: { ...rep, limit: q.limit, offset: (q.page - 1) * q.limit }, type: QueryTypes.SELECT },
  );
  const data = rows.map(r => ({
    name: r.name,
    unitLabel: r.label,
    relation:
      r.relation === 'OWNER' || r.relation === 'CO_OWNER'
        ? 'OWNER'
        : r.relation === 'TENANT'
          ? 'TENANT'
          : 'FAMILY',
    ...(r.showMobileInDirectory && r.mobile ? { mobile: r.mobile } : {}),
    ...(r.showEmailInDirectory && r.email ? { email: r.email } : {}),
    ...(r.showPhotoInDirectory && r.photoFileId ? { photoFileId: Number(r.photoFileId) } : {}),
  }));
  return { data, pagination: pageMeta(q.page, q.limit, total) };
}

// ------------------------------------------------------------------ own privacy settings (8.21)
const privacyOf = (r: Resident) => ({
  directoryVisible: Boolean(r.directoryVisible),
  showMobileInDirectory: Boolean(r.showMobileInDirectory),
  showEmailInDirectory: Boolean(r.showEmailInDirectory),
  showPhotoInDirectory: Boolean(r.showPhotoInDirectory),
  version: r.version,
});

export async function getPrivacy(ctx: Ctx, societyId: number) {
  return privacyOf(await ownResident(ctx, societyId));
}

export async function patchPrivacy(
  ctx: Ctx,
  societyId: number,
  input: {
    directoryVisible?: boolean;
    showMobileInDirectory?: boolean;
    showEmailInDirectory?: boolean;
    showPhotoInDirectory?: boolean;
    version: number;
  },
) {
  const own = await ownResident(ctx, societyId);
  return sequelize.transaction(async t => {
    const r = (await Resident.findOne({
      where: { id: own.id!, societyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    }))!;
    if (r.version !== input.version) throw staleVersion('Your settings');
    const before = privacyOf(r);
    const { version: _v, ...fields } = input;
    void _v;
    Object.assign(r, fields);
    r.version += 1;
    r.updatedBy = ctx.user?.id ?? null;
    await r.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.privacyUpdated,
        entityType: ENTITY.resident,
        entityId: r.id!,
        societyId,
        before,
        after: privacyOf(r),
      },
      t,
    );
    touchReports(t, societyId);
    return privacyOf(r);
  });
}
