import { Op, type Model, type ModelStatic } from 'sequelize';
import {
  EmergencyProfile,
  JoinRequest,
  MoveRequest,
  OwnershipTransfer,
  Pet,
  RenovationPermit,
  Resident,
  ResidentDocument,
  Tenancy,
  UnitResident,
} from '../../models';
import type { ExportProvider } from '../societies/societies.exports';
import { decryptNotes } from './residents.crypto';

/**
 * Module 05 export provider of module 09 (section 13): every society table of the module, in id order, in batches. Soft
 * deleted rows are included. The society's own full export carries the medical notes decrypted (section 13); the document
 * files themselves are exported by module 01.
 */
const BATCH = 500;

async function* streamRows<M extends Model>(
  model: ModelStatic<M>,
  societyId: number,
  map: (row: Record<string, unknown>) => Record<string, unknown> = r => r,
): AsyncGenerator<Record<string, unknown>> {
  let last = 0;
  for (;;) {
    const rows = await model.findAll({
      where: { societyId, id: { [Op.gt]: last } } as never,
      order: [['id', 'ASC']],
      limit: BATCH,
      paranoid: false,
    });
    if (!rows.length) return;
    for (const r of rows) yield map(r.get({ plain: true }) as Record<string, unknown>);
    last = (rows[rows.length - 1] as unknown as { id: number }).id;
  }
}

const withNotes = (r: Record<string, unknown>): Record<string, unknown> => {
  const { medicalNotesEnc, ...rest } = r;
  return {
    ...rest,
    medicalNotes: medicalNotesEnc ? decryptNotes(Buffer.from(medicalNotesEnc as Buffer)) : null,
  };
};

export const residentsExportProvider: ExportProvider = {
  module: 'residents',
  tables: [
    { name: 'residents', file: 'residents.csv', stream: sid => streamRows(Resident, sid) },
    { name: 'unit_residents', file: 'unit_residents.csv', stream: sid => streamRows(UnitResident, sid) },
    { name: 'tenancies', file: 'tenancies.csv', stream: sid => streamRows(Tenancy, sid) },
    {
      name: 'resident_documents',
      file: 'resident_documents.csv',
      stream: sid => streamRows(ResidentDocument, sid),
    },
    { name: 'join_requests', file: 'join_requests.csv', stream: sid => streamRows(JoinRequest, sid) },
    { name: 'move_requests', file: 'move_requests.csv', stream: sid => streamRows(MoveRequest, sid) },
    {
      name: 'renovation_permits',
      file: 'renovation_permits.csv',
      stream: sid => streamRows(RenovationPermit, sid),
    },
    {
      name: 'ownership_transfers',
      file: 'ownership_transfers.csv',
      stream: sid => streamRows(OwnershipTransfer, sid),
    },
    { name: 'pets', file: 'pets.csv', stream: sid => streamRows(Pet, sid) },
    {
      name: 'emergency_profiles',
      file: 'emergency_profiles.csv',
      stream: sid => streamRows(EmergencyProfile, sid, withNotes),
    },
  ],
};
