import { Op } from 'sequelize';
import { CommitteeTerm } from '../../models';
import type { ExportProvider } from '../societies/societies.exports';

/**
 * Module 05 export provider of module 10 (section 13): one row per seat of every term, in term id order (soft-deleted drafts
 * included). Term name, dates, status, designation, name, join mode, from, to and exit reason; no contacts, no ids of people.
 * A term without seats still gets one row so that it is not lost.
 */
const BATCH = 200;

async function* streamRows(societyId: number): AsyncGenerator<Record<string, unknown>> {
  let last = 0;
  for (;;) {
    const rows = await CommitteeTerm.findAll({
      where: { societyId, id: { [Op.gt]: last } },
      order: [['id', 'ASC']],
      limit: BATCH,
      paranoid: false,
    });
    if (!rows.length) return;
    for (const t of rows) {
      const term = {
        termId: t.id!,
        termName: t.name,
        kind: t.kind,
        source: t.source,
        status: t.status,
        startDate: t.startDate,
        endDate: t.endDate,
        actualEndDate: t.actualEndDate,
        tookChargeOn: t.tookChargeOn,
        strength: t.strength,
        resolutionRef: t.resolutionRef,
        deletedAt: t.deletedAt,
      };
      const seats = t.members;
      if (!seats.length) yield { ...term };
      for (const s of seats)
        yield {
          ...term,
          seatId: s.seatId,
          designation: s.designation,
          name: s.name,
          joinMode: s.joinMode,
          seatStatus: s.status,
          fromDate: s.fromDate,
          toDate: s.toDate,
          exitReason: s.exitReason,
        };
    }
    last = rows[rows.length - 1]!.id!;
  }
}

export const committeeExportProvider: ExportProvider = {
  module: 'members',
  tables: [{ name: 'committee_terms', file: 'committee_terms.csv', stream: streamRows }],
};
