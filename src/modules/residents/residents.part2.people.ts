import type { Transaction } from 'sequelize';
import { Resident } from '../../models';
import type { ResidentSource } from '../../models/resident.model';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { AUDIT, ENTITY } from './residents.constants';
import { isUniqueViolation, rule } from './residents.shared';

export interface PersonInput {
  name: string;
  mobile?: string | null;
  email?: string | null;
  dateOfBirth?: string | null;
}

/**
 * BR-09-1 for flows that name a person by mobile (tenancy, household, join approval): the resident of the society with
 * that mobile is reused (locked), else a new ACTIVE resident is created. Runs in the caller's transaction.
 */
export async function findOrCreateResident(
  ctx: Ctx,
  societyId: number,
  p: PersonInput,
  source: ResidentSource,
  t: Transaction,
): Promise<{ resident: Resident; created: boolean }> {
  if (p.mobile) {
    const hit = await Resident.findOne({
      where: { societyId, mobile: p.mobile },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (hit) return { resident: hit, created: false };
  }
  let resident: Resident;
  try {
    resident = await Resident.create(
      {
        societyId,
        userId: null,
        memberId: null,
        name: p.name,
        mobile: p.mobile ?? null,
        alternateMobile: null,
        email: p.email ? p.email.toLowerCase() : null,
        dateOfBirth: p.dateOfBirth ?? null,
        gender: null,
        photoFileId: null,
        preferredLanguage: 'en-IN',
        isNri: false,
        overseasPhone: null,
        localRepresentativeResidentId: null,
        status: 'ACTIVE',
        source,
        directoryVisible: true,
        showMobileInDirectory: false,
        showEmailInDirectory: false,
        showPhotoInDirectory: false,
        adminNote: null,
        anonymisedAt: null,
        version: 1,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
        deletedAt: null,
      },
      { transaction: t },
    );
  } catch (err) {
    if (isUniqueViolation(err))
      throw rule(
        409,
        'RESIDENT_MOBILE_EXISTS',
        'A resident with this mobile number already exists',
        'mobile',
      );
    throw err;
  }
  await audit(
    ctx,
    {
      action: AUDIT.residentCreated,
      entityType: ENTITY.resident,
      entityId: resident.id!,
      entityLabel: resident.name,
      societyId,
      after: { name: resident.name, mobile: resident.mobile, email: resident.email, source },
    },
    t,
  );
  return { resident, created: true };
}
