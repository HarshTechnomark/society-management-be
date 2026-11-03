import { Op, QueryTypes } from 'sequelize';
import { Resident, UnitResident, sequelize } from '../../models';
import { istDate, now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { societyPorts } from '../societies/societies.ports';
import { toCsv, type CsvValue } from '../society-setup/society-setup.csv';
import { AUDIT, ENTITY, EXPORT_MAX_ROWS } from './residents.constants';
import { linkDtos } from './residents.dto';
import { kycStatusOf, residentFilter, type ListResidentsQuery } from './residents.service';
import { maskMail, maskMobile } from './residents.shared';

/** `GET /residents/export` (8.12): one CSV row per open link; contacts masked unless the caller holds `residents.contacts.view`. */
export const EXPORT_HEADER = [
  'Resident id',
  'Name',
  'Mobile',
  'Email',
  'Flat',
  'Relation',
  'Share %',
  'Primary',
  'Residing',
  'From',
  'To',
  'Has login',
  'KYC status',
];

export async function exportResidents(
  ctx: Ctx,
  societyId: number,
  q: Omit<ListResidentsQuery, 'page' | 'limit' | 'sortBy' | 'sortOrder'>,
) {
  const f = residentFilter(societyId, q);
  const ids = (
    await sequelize.query<{ id: number }>(
      `SELECT r.id FROM residents r WHERE ${f.sql} ORDER BY r.name ASC, r.id ASC`,
      {
        replacements: f.rep,
        type: QueryTypes.SELECT,
      },
    )
  ).map(r => Number(r.id));
  const reveal = ctx.permissions?.has('residents.contacts.view') ?? false;
  const rows: CsvValue[][] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const part = ids.slice(i, i + 500);
    const people = new Map(
      (await Resident.findAll({ where: { societyId, id: { [Op.in]: part } } })).map(r => [r.id!, r]),
    );
    const links = await UnitResident.findAll({
      where: { societyId, residentId: { [Op.in]: part }, toDate: null },
      order: [['id', 'ASC']],
    });
    const dtos = await linkDtos(societyId, links);
    const kyc = await kycStatusOf(societyId, part);
    for (const id of part) {
      const r = people.get(id)!;
      const own = dtos.filter(d => links.some(l => l.id === d.linkId && l.residentId === id));
      const base = (): CsvValue[] => [
        id,
        r.name,
        reveal ? r.mobile : maskMobile(r.mobile),
        reveal ? r.email : maskMail(r.email),
      ];
      const tail = [r.userId !== null, kyc.get(id) ?? 'NONE'];
      if (!own.length) rows.push([...base(), '', '', '', '', '', '', '', ...tail]);
      for (const d of own)
        rows.push([
          ...base(),
          d.unitLabel,
          d.relation,
          d.sharePercent,
          d.isPrimary,
          d.isResiding,
          d.fromDate,
          d.toDate,
          ...tail,
        ]);
    }
    if (rows.length > EXPORT_MAX_ROWS)
      throw new UnprocessableError(
        'EXPORT_TOO_LARGE',
        `More than ${EXPORT_MAX_ROWS} rows. Narrow the filters.`,
      );
  }
  const file = await societyPorts().files.storeSystemFile({
    societyId,
    purpose: 'EXPORT_FILE',
    content: toCsv(EXPORT_HEADER, rows),
    name: `residents-${istDate(now())}.csv`,
    contentType: 'text/csv',
    ownerUserId: ctx.user?.id ?? null,
  });
  const link = await societyPorts().files.downloadUrl(file.fileId, 5);
  await sequelize.transaction(t =>
    audit(
      ctx,
      {
        action: AUDIT.residentExported,
        entityType: ENTITY.resident,
        entityId: societyId,
        societyId,
        after: { filters: q, rowCount: rows.length, fileId: file.fileId, unmasked: reveal },
      },
      t,
    ),
  );
  return {
    fileId: file.fileId,
    downloadUrl: link.url,
    expiresAt: link.expiresAt.toISOString(),
    rowCount: rows.length,
  };
}
