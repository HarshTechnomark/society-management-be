import { Op, QueryTypes } from 'sequelize';
import { Pet, Resident, ResidentDocument, Unit, UnitResident, sequelize } from '../../models';
import type { PetSpecies } from '../../models/pet.model';
import { audit } from '../../utils/audit';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { settings } from '../society-setup/society-setup.public';
import { AUDIT, ENTITY, type PET_VACCINATION_FILTERS } from './residents.constants';
import { attachDocuments } from './residents.documents.service';
import { emitAfterCommit, notifyAfterCommit, recipients } from './residents.notify';
import { residentPorts, touchReports } from './residents.ports';
import { ownResident } from './residents.service';
import {
  addDaysYmd,
  invalidState,
  petNotFound,
  rule,
  societyToday,
  staleVersion,
  unitNotFound,
} from './residents.shared';
import { isFeatureOn } from '../subscriptions/entitlements.service';

/** The pets register (BR-09-69, 8.19). */
export interface PetFields {
  name: string;
  species: PetSpecies;
  breed?: string | null;
  gender?: 'MALE' | 'FEMALE' | 'UNKNOWN';
  colour?: string | null;
  dateOfBirth?: string | null;
  photoFileId?: number | null;
  licenceNo?: string | null;
  isNeutered?: boolean | null;
  temperamentNote?: string | null;
  lastVaccineName?: string | null;
  lastVaccinatedOn?: string | null;
  vaccinationValidUntil?: string | null;
  vaccinationFileId?: number | null;
}

export const petDto = (p: Pet) => ({
  id: p.id!,
  unitId: p.unitId,
  ownerResidentId: p.ownerResidentId,
  name: p.name,
  species: p.species,
  breed: p.breed,
  gender: p.gender,
  colour: p.colour,
  dateOfBirth: p.dateOfBirth,
  photoFileId: p.photoFileId,
  licenceNo: p.licenceNo,
  isNeutered: p.isNeutered === null ? null : Boolean(p.isNeutered),
  temperamentNote: p.temperamentNote,
  lastVaccineName: p.lastVaccineName,
  lastVaccinatedOn: p.lastVaccinatedOn,
  vaccinationValidUntil: p.vaccinationValidUntil,
  status: p.status,
  inactiveReason: p.inactiveReason,
  version: p.version,
});

const checkDates = (f: PetFields, today: string): void => {
  if (f.dateOfBirth && f.dateOfBirth > today)
    throw rule(422, 'VALIDATION_FAILED', 'The birth date is in the future', 'dateOfBirth');
  if (f.lastVaccinatedOn && f.lastVaccinatedOn > today)
    throw rule(422, 'VALIDATION_FAILED', 'The vaccination date is in the future', 'lastVaccinatedOn');
  if (f.vaccinationValidUntil && f.lastVaccinatedOn && f.vaccinationValidUntil < f.lastVaccinatedOn)
    throw rule(
      422,
      'VALIDATION_FAILED',
      'The vaccination cannot expire before it was given',
      'vaccinationValidUntil',
    );
};

/** `POST /me/pets`: the caller owns the pet on one of their flats. */
export async function createPet(ctx: Ctx, societyId: number, unitId: number, f: PetFields) {
  if (!(ctx.unitIds ?? []).includes(unitId)) throw unitNotFound();
  return sequelize.transaction(async t => {
    const owner = await ownResident(ctx, societyId);
    const today = await societyToday(societyId);
    const link = await UnitResident.findOne({
      where: {
        societyId,
        unitId,
        residentId: owner.id!,
        fromDate: { [Op.lte]: today },
        [Op.or]: [{ toDate: null }, { toDate: { [Op.gte]: today } }],
      },
      transaction: t,
    });
    if (!link) throw unitNotFound();
    checkDates(f, today);
    if (
      f.species === 'DOG' &&
      (await settings.get(societyId, 'residents.dogVaccinationRequired')) &&
      (!f.vaccinationValidUntil || f.vaccinationValidUntil < today)
    )
      throw rule(422, 'PET_VACCINATION_REQUIRED', 'A dog needs a valid vaccination', 'vaccinationValidUntil');
    if (f.photoFileId) await residentPorts().files.linkPhoto(ctx, { fileId: f.photoFileId, societyId }, t);
    const pet = await Pet.create(
      {
        societyId,
        unitId,
        ownerResidentId: owner.id!,
        name: f.name,
        species: f.species,
        breed: f.breed ?? null,
        gender: f.gender ?? 'UNKNOWN',
        colour: f.colour ?? null,
        dateOfBirth: f.dateOfBirth ?? null,
        photoFileId: f.photoFileId ?? null,
        licenceNo: f.licenceNo ?? null,
        isNeutered: f.isNeutered ?? null,
        temperamentNote: f.temperamentNote ?? null,
        lastVaccineName: f.lastVaccineName ?? null,
        lastVaccinatedOn: f.lastVaccinatedOn ?? null,
        vaccinationValidUntil: f.vaccinationValidUntil ?? null,
        vaccinationReminderFor: null,
        status: 'ACTIVE',
        inactiveReason: null,
        version: 1,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
        deletedAt: null,
      },
      { transaction: t },
    );
    if (f.vaccinationFileId)
      await attachDocuments(ctx, societyId, t, {
        residentId: owner.id!,
        unitId,
        refType: 'pet',
        refId: pet.id!,
        items: [{ fileId: f.vaccinationFileId, docType: 'VACCINATION_CERTIFICATE' }],
      });
    await audit(
      ctx,
      {
        action: AUDIT.petCreated,
        entityType: ENTITY.pet,
        entityId: pet.id!,
        entityLabel: pet.name,
        societyId,
        after: { unitId, species: pet.species, name: pet.name },
      },
      t,
    );
    emitAfterCommit(t, `unit:${unitId}`, 'household.changed', { unitId });
    touchReports(t, societyId);
    return petDto(pet);
  });
}

export type PatchPetInput = Partial<PetFields> & {
  status?: 'ACTIVE' | 'INACTIVE';
  inactiveReason?: 'MOVED_OUT' | 'DECEASED' | 'REHOMED' | 'OTHER';
  version: number;
};

async function mine(
  ctx: Ctx,
  societyId: number,
  id: number,
  lock?: import('sequelize').Transaction,
): Promise<Pet> {
  const p = await Pet.findOne({
    where: { id, societyId },
    transaction: lock,
    lock: lock ? lock.LOCK.UPDATE : undefined,
  });
  if (!p || !(ctx.unitIds ?? []).includes(p.unitId)) throw petNotFound();
  return p;
}

export async function patchPet(ctx: Ctx, societyId: number, id: number, input: PatchPetInput) {
  return sequelize.transaction(async t => {
    const p = await mine(ctx, societyId, id, t);
    if (p.version !== input.version) throw staleVersion('This pet');
    const today = await societyToday(societyId);
    const { version: _v, status, inactiveReason, vaccinationFileId, ...rest } = input;
    void _v;
    const merged = {
      dateOfBirth: rest.dateOfBirth !== undefined ? rest.dateOfBirth : p.dateOfBirth,
      lastVaccinatedOn: rest.lastVaccinatedOn !== undefined ? rest.lastVaccinatedOn : p.lastVaccinatedOn,
      vaccinationValidUntil:
        rest.vaccinationValidUntil !== undefined ? rest.vaccinationValidUntil : p.vaccinationValidUntil,
    } as PetFields;
    checkDates(merged, today);
    if (rest.photoFileId && rest.photoFileId !== p.photoFileId)
      await residentPorts().files.linkPhoto(ctx, { fileId: rest.photoFileId, societyId }, t);
    const before = { name: p.name, status: p.status, vaccinationValidUntil: p.vaccinationValidUntil };
    for (const [k, v] of Object.entries(rest))
      if (v !== undefined) (p as unknown as Record<string, unknown>)[k] = v;
    if (
      rest.vaccinationValidUntil !== undefined &&
      rest.vaccinationValidUntil !== before.vaccinationValidUntil
    )
      p.vaccinationReminderFor = null;
    if (status) {
      if (status === 'INACTIVE' && !inactiveReason)
        throw rule(422, 'VALIDATION_FAILED', 'Say why the pet is no longer in the flat', 'inactiveReason');
      p.status = status;
      p.inactiveReason = status === 'INACTIVE' ? (inactiveReason ?? null) : null;
    }
    if (vaccinationFileId) {
      const owner = await Resident.findByPk(p.ownerResidentId, { transaction: t });
      await attachDocuments(ctx, societyId, t, {
        residentId: owner?.id ?? null,
        unitId: p.unitId,
        refType: 'pet',
        refId: p.id!,
        items: [{ fileId: vaccinationFileId, docType: 'VACCINATION_CERTIFICATE' }],
      });
    }
    p.version += 1;
    p.updatedBy = ctx.user?.id ?? null;
    await p.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.petUpdated,
        entityType: ENTITY.pet,
        entityId: id,
        entityLabel: p.name,
        societyId,
        before,
        after: { name: p.name, status: p.status, vaccinationValidUntil: p.vaccinationValidUntil },
      },
      t,
    );
    emitAfterCommit(t, `unit:${p.unitId}`, 'household.changed', { unitId: p.unitId });
    touchReports(t, societyId);
    return petDto(p);
  });
}

export async function deletePet(ctx: Ctx, societyId: number, id: number): Promise<void> {
  await sequelize.transaction(async t => {
    const p = await mine(ctx, societyId, id, t);
    if (p.deletedAt) throw invalidState('This pet was removed already');
    await p.destroy({ transaction: t });
    await ResidentDocument.destroy({ where: { societyId, refType: 'pet', refId: id }, transaction: t });
    await audit(
      ctx,
      { action: AUDIT.petDeleted, entityType: ENTITY.pet, entityId: id, entityLabel: p.name, societyId },
      t,
    );
    emitAfterCommit(t, `unit:${p.unitId}`, 'household.changed', { unitId: p.unitId });
    touchReports(t, societyId);
  });
}

export async function listMine(ctx: Ctx, societyId: number) {
  const unitIds = ctx.unitIds ?? [];
  if (!unitIds.length) return [];
  const rows = await Pet.findAll({
    where: { societyId, unitId: { [Op.in]: unitIds } },
    order: [['id', 'ASC']],
  });
  return rows.map(petDto);
}

export interface ListPetsQuery {
  unitId?: number;
  species?: PetSpecies;
  vaccination?: (typeof PET_VACCINATION_FILTERS)[number];
  status?: 'ACTIVE' | 'INACTIVE';
  page: number;
  limit: number;
}

/** `GET /pets` (admin register). */
export async function listPets(societyId: number, q: ListPetsQuery) {
  const today = await societyToday(societyId);
  const where: Record<string, unknown> = { societyId };
  if (q.unitId) where.unitId = q.unitId;
  if (q.species) where.species = q.species;
  if (q.status) where.status = q.status;
  if (q.vaccination === 'EXPIRED') where.vaccinationValidUntil = { [Op.lt]: today };
  if (q.vaccination === 'EXPIRING_30')
    where.vaccinationValidUntil = { [Op.between]: [today, addDaysYmd(today, 30)] };
  if (q.vaccination === 'VALID') where.vaccinationValidUntil = { [Op.gt]: addDaysYmd(today, 30) };
  if (q.vaccination === 'NONE') where.vaccinationValidUntil = null;
  const { rows, count } = await Pet.findAndCountAll({
    where,
    order: [['id', 'DESC']],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const labels = new Map(
    (
      await Unit.findAll({
        where: { societyId, id: { [Op.in]: [...new Set(rows.map(r => r.unitId))] } },
        attributes: ['id', 'label'],
      })
    ).map(u => [u.id!, u.label]),
  );
  const owners = new Map(
    (
      await Resident.findAll({
        where: { societyId, id: { [Op.in]: [...new Set(rows.map(r => r.ownerResidentId))] } },
        paranoid: false,
        attributes: ['id', 'name'],
      })
    ).map(r => [r.id!, r.name]),
  );
  return {
    data: rows.map(p => ({
      ...petDto(p),
      unitLabel: labels.get(p.unitId) ?? '',
      ownerName: owners.get(p.ownerResidentId) ?? '',
      vaccinationState:
        p.vaccinationValidUntil === null
          ? 'NONE'
          : p.vaccinationValidUntil < today
            ? 'EXPIRED'
            : p.vaccinationValidUntil <= addDaysYmd(today, 30)
              ? 'EXPIRING_30'
              : 'VALID',
    })),
    pagination: pageMeta(q.page, q.limit, count),
  };
}

// ------------------------------------------------------------------ reminders job (9.1 residents:pet-reminders)
/** Reminds the owner of every ACTIVE pet whose vaccination expires within 30 days, once per expiry date. */
export async function runPetReminders(societyId: number): Promise<number> {
  if (!(await isFeatureOn(societyId, 'residents.pets_registry'))) return 0;
  const today = await societyToday(societyId);
  const due = await sequelize.query<{ id: number }>(
    `SELECT id FROM pets WHERE societyId = :societyId AND deletedAt IS NULL AND status = 'ACTIVE'
        AND vaccinationValidUntil BETWEEN :today AND :limit
        AND (vaccinationReminderFor IS NULL OR vaccinationReminderFor <> vaccinationValidUntil)
      ORDER BY id`,
    { replacements: { societyId, today, limit: addDaysYmd(today, 30) }, type: QueryTypes.SELECT },
  );
  let sent = 0;
  for (const { id } of due)
    await sequelize.transaction(async t => {
      const p = await Pet.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
      if (!p || p.status !== 'ACTIVE' || !p.vaccinationValidUntil) return;
      if (p.vaccinationReminderFor === p.vaccinationValidUntil) return;
      const owner = await Resident.findByPk(p.ownerResidentId, { transaction: t });
      p.vaccinationReminderFor = p.vaccinationValidUntil;
      await p.save({ transaction: t });
      if (owner?.userId)
        notifyAfterCommit(t, 'residents.pet_vaccination_due', societyId, recipients.users([owner.userId]), {
          petName: p.name,
          validUntil: p.vaccinationValidUntil,
          link: '/pets',
        });
      sent += 1;
    });
  return sent;
}
