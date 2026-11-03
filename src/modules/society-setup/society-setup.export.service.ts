import { Op, type WhereOptions } from 'sequelize';
import { Building, Society, Unit, sequelize } from '../../models';
import { istDate, now } from '../../lib/clock';
import { enqueue } from '../../lib/queue';
import { emitToUser } from '../../lib/realtime';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { societyPorts } from '../societies/societies.ports';
import { toCsv, type CsvValue } from './society-setup.csv';
import { notifyUser } from './society-setup.notify';
import { actorCtx, buildingNotFound } from './society-setup.shared';
import { AUDIT, ENTITY, JOBS, SOCIETY_SETUP_QUEUE } from './society-setup.types';

/** Unit export (section 8.18): the route queues `export-units`; the job writes the CSV and tells the requester. */
export interface ExportRequest {
  status: 'ACTIVE' | 'ALL';
  buildingId?: number;
}
export interface ExportJobData extends Record<string, unknown> {
  societyId: number;
  userId: number;
  requestId: string;
  status: 'ACTIVE' | 'ALL';
  buildingId: number | null;
}

/** Columns of the import template plus `Label`, `Area Sqft` and `Status` (section 8.18). */
export const EXPORT_HEADER = [
  'Building',
  'Flat No',
  'Floor',
  'Type',
  'BHK',
  'Carpet Area',
  'Built-up Area',
  'Super Built-up Area',
  'Share %',
  'Billable',
  'Possession Date',
  'Notes',
  'Label',
  'Area Sqft',
  'Status',
];

export async function requestExport(
  ctx: Ctx,
  societyId: number,
  input: ExportRequest,
): Promise<{ queued: true }> {
  if (input.buildingId && !(await Building.count({ where: { id: input.buildingId, societyId } })))
    throw buildingNotFound();
  const data: ExportJobData = {
    societyId,
    userId: ctx.user!.id,
    requestId: ctx.requestId,
    status: input.status,
    buildingId: input.buildingId ?? null,
  };
  await enqueue(SOCIETY_SETUP_QUEUE, JOBS.exportUnits, data, {
    jobId: `export:${societyId}:${ctx.requestId}`,
  });
  return { queued: true };
}

const BATCH = 1000;

export async function runExportUnits(d: ExportJobData): Promise<void> {
  const society = await Society.findByPk(d.societyId, { attributes: ['status'] });
  if (!society || society.status === 'SUSPENDED' || society.status === 'CLOSED') {
    logger.warn({ societyId: d.societyId }, 'export-units skipped: society not active');
    return;
  }
  const where: WhereOptions[] = [{ societyId: d.societyId }];
  if (d.status === 'ACTIVE') where.push({ status: 'ACTIVE' });
  if (d.buildingId) {
    const wings = await Building.findAll({
      where: { societyId: d.societyId, parentBuildingId: d.buildingId },
      attributes: ['id'],
    });
    where.push({ buildingId: { [Op.in]: [d.buildingId, ...wings.map(w => w.id!)] } });
  }
  const rows: CsvValue[][] = [];
  for (let offset = 0; ; offset += BATCH) {
    const units = await Unit.findAll({
      where: { [Op.and]: where },
      include: [{ model: Building, attributes: ['code', 'sortOrder'], required: true }],
      order: [
        [Building as never, 'sortOrder', 'ASC'],
        [Building as never, 'code', 'ASC'],
        ['floor', 'ASC'],
        ['positionOnFloor', 'ASC'],
        ['unitNumber', 'ASC'],
        ['id', 'ASC'],
      ],
      limit: BATCH,
      offset,
    });
    for (const u of units) {
      const b = (u as unknown as { Building: Building }).Building;
      rows.push([
        b.code,
        u.unitNumber,
        u.floor,
        u.unitType,
        u.bhk,
        u.carpetAreaSqft,
        u.builtUpAreaSqft,
        u.superBuiltUpAreaSqft,
        u.undividedSharePct,
        Boolean(u.isBillable),
        u.possessionDate,
        u.notes,
        u.label,
        u.areaSqft,
        u.status,
      ]);
    }
    if (units.length < BATCH) break;
  }
  const file = await societyPorts().files.storeSystemFile({
    societyId: d.societyId,
    purpose: 'EXPORT_FILE',
    content: toCsv(EXPORT_HEADER, rows),
    name: `units-${istDate(now())}.csv`,
    contentType: 'text/csv',
    ownerUserId: d.userId,
  });
  const ctx = await actorCtx(d.userId, d.requestId);
  await sequelize.transaction(t =>
    audit(
      ctx,
      {
        action: AUDIT.unitExported,
        entityType: ENTITY.unit,
        entityId: d.societyId,
        societyId: d.societyId,
        after: { status: d.status, buildingId: d.buildingId, rowCount: rows.length, fileId: file.fileId },
      },
      t,
    ),
  );
  emitToUser(d.userId, 'setup.export.ready', { fileId: file.fileId });
  await notifyUser('setup.export.ready', d.societyId, d.userId, {
    fileId: file.fileId,
    link: '/settings/structure',
  });
}
