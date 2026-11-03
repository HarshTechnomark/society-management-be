import { Op, type InferAttributes } from 'sequelize';
import { EmergencyProfile, Resident, Unit, UnitResident, sequelize } from '../../models';
import type { BloodGroup } from '../../models/emergency-profile.model';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { AUDIT, EMERGENCY_CONSENT_VERSION, ENTITY, FEATURE } from './residents.constants';
import { decryptNotes, encryptNotes } from './residents.crypto';
import { residentPorts, touchReports } from './residents.ports';
import { ageOf, assertFeatureFor, rule, societyToday, staleVersion } from './residents.shared';

/** Emergency profiles (BR-09-71, BR-09-72, 8.20). The medical notes are encrypted at rest and never audited or logged. */
export interface EmergencyContact {
  name: string;
  relation: string;
  mobile: string;
}
export interface EmergencyInput {
  bloodGroup?: BloodGroup | null;
  medicalNotes?: string | null;
  isSeniorCitizen?: boolean;
  isDifferentlyAbled?: boolean;
  mobilityNote?: string | null;
  preferredHospital?: string | null;
  contacts?: EmergencyContact[];
  consent?: boolean;
  withdrawConsent?: boolean;
  keepContacts?: boolean;
  version?: number;
}

const contactsOf = (p: EmergencyProfile): EmergencyContact[] =>
  [1, 2, 3]
    .map(i => {
      const g = p as unknown as Record<string, string | null>;
      return {
        name: g[`contact${i}Name`],
        relation: g[`contact${i}Relation`],
        mobile: g[`contact${i}Mobile`],
      };
    })
    .filter((c): c is EmergencyContact => Boolean(c.name && c.mobile))
    .map(c => ({ ...c, relation: c.relation ?? '' }));

/** The resident's own view (decrypted notes) or `exists: false` with empty values. */
export function profileView(p: EmergencyProfile | null) {
  return {
    exists: Boolean(p),
    bloodGroup: p?.bloodGroup ?? null,
    medicalNotes: p?.medicalNotesEnc ? decryptNotes(Buffer.from(p.medicalNotesEnc)) : null,
    isSeniorCitizen: Boolean(p?.isSeniorCitizen),
    isDifferentlyAbled: Boolean(p?.isDifferentlyAbled),
    mobilityNote: p?.mobilityNote ?? null,
    preferredHospital: p?.preferredHospital ?? null,
    contacts: p ? contactsOf(p) : [],
    consent: {
      given: Boolean(p?.consentGivenAt),
      givenAt: p?.consentGivenAt ? p.consentGivenAt.toISOString() : null,
      textVersion: p?.consentTextVersion ?? null,
      withdrawnAt: p?.consentWithdrawnAt ? p.consentWithdrawnAt.toISOString() : null,
    },
    version: p?.version ?? 0,
  };
}

export async function getProfile(societyId: number, residentId: number) {
  return profileView(await EmergencyProfile.findOne({ where: { societyId, residentId } }));
}

/** `PUT /me/emergency-profile` and `PUT /me/household/members/:linkId/emergency-profile`. */
export async function saveProfile(ctx: Ctx, societyId: number, resident: Resident, input: EmergencyInput) {
  await sequelize.transaction(async t => {
    const existing = await EmergencyProfile.findOne({
      where: { societyId, residentId: resident.id! },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (existing && input.version !== undefined && existing.version !== input.version)
      throw staleVersion('This emergency profile');
    if (existing && input.version === undefined)
      throw new ValidationError([{ field: 'version', message: 'Send the version of the profile you saved' }]);
    const p =
      existing ??
      EmergencyProfile.build({
        societyId,
        residentId: resident.id!,
        bloodGroup: null,
        medicalNotesEnc: null,
        isSeniorCitizen: false,
        isDifferentlyAbled: false,
        mobilityNote: null,
        preferredHospital: null,
        contact1Name: null,
        contact1Relation: null,
        contact1Mobile: null,
        contact2Name: null,
        contact2Relation: null,
        contact2Mobile: null,
        contact3Name: null,
        contact3Relation: null,
        contact3Mobile: null,
        consentGivenAt: null,
        consentTextVersion: null,
        consentByUserId: null,
        consentWithdrawnAt: null,
        version: 0,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
      });
    const changed: string[] = [];
    const set = <K extends keyof InferAttributes<EmergencyProfile>>(k: K, v: EmergencyProfile[K]) => {
      if (p[k] !== v) {
        p.set(k, v as never);
        changed.push(String(k));
      }
    };
    if (input.withdrawConsent) {
      set('bloodGroup', null);
      set('medicalNotesEnc', null);
      set('isSeniorCitizen', false);
      set('isDifferentlyAbled', false);
      set('mobilityNote', null);
      set('consentGivenAt', null);
      set('consentWithdrawnAt', now());
      set('consentByUserId', ctx.user?.id ?? null);
      if (input.keepContacts === false) {
        set('preferredHospital', null);
        for (const i of [1, 2, 3]) {
          p.set(`contact${i}Name` as 'contact1Name', null);
          p.set(`contact${i}Relation` as 'contact1Relation', null);
          p.set(`contact${i}Mobile` as 'contact1Mobile', null);
        }
        changed.push('contacts');
      }
    } else {
      const careFlag =
        input.isSeniorCitizen === true || input.isDifferentlyAbled === true || Boolean(input.mobilityNote);
      if (careFlag) await assertFeatureFor(societyId, FEATURE.careFlags);
      const health =
        careFlag ||
        Boolean(input.bloodGroup) ||
        (input.medicalNotes !== undefined && input.medicalNotes !== null && input.medicalNotes !== '');
      if (health && input.consent !== true)
        throw rule(422, 'CONSENT_REQUIRED', 'Health details can be saved only with consent', 'consent');
      if (health) {
        set('consentGivenAt', now());
        set('consentTextVersion', EMERGENCY_CONSENT_VERSION);
        set('consentByUserId', ctx.user?.id ?? null);
        set('consentWithdrawnAt', null);
      }
      if (input.bloodGroup !== undefined) set('bloodGroup', input.bloodGroup);
      if (input.medicalNotes !== undefined) {
        p.set('medicalNotesEnc', input.medicalNotes ? encryptNotes(input.medicalNotes) : null);
        changed.push('medicalNotes');
      }
      if (input.isSeniorCitizen !== undefined) set('isSeniorCitizen', input.isSeniorCitizen);
      if (input.isDifferentlyAbled !== undefined) set('isDifferentlyAbled', input.isDifferentlyAbled);
      if (input.mobilityNote !== undefined) set('mobilityNote', input.mobilityNote);
      if (input.preferredHospital !== undefined) set('preferredHospital', input.preferredHospital);
      if (input.contacts !== undefined) {
        const mobiles = input.contacts.map(c => c.mobile);
        if (
          new Set(mobiles).size !== mobiles.length ||
          (resident.mobile && mobiles.includes(resident.mobile))
        )
          throw new ValidationError([
            { field: 'contacts', message: 'Each contact needs a different mobile number, not your own' },
          ]);
        for (const i of [1, 2, 3]) {
          const c = input.contacts[i - 1];
          p.set(`contact${i}Name` as 'contact1Name', c?.name ?? null);
          p.set(`contact${i}Relation` as 'contact1Relation', c?.relation ?? null);
          p.set(`contact${i}Mobile` as 'contact1Mobile', c?.mobile ?? null);
        }
        changed.push('contacts');
      }
    }
    if (!changed.length && existing) return;
    p.version = (existing?.version ?? 0) + 1;
    p.updatedBy = ctx.user?.id ?? null;
    await p.save({ transaction: t });
    await audit(
      ctx,
      {
        action: input.withdrawConsent ? AUDIT.emergencyConsentWithdrawn : AUDIT.emergencyUpdated,
        entityType: ENTITY.emergency,
        entityId: p.id!,
        societyId,
        after: { residentId: resident.id, changedFields: changed },
      },
      t,
    );
    touchReports(t, societyId);
  });
  return getProfile(societyId, resident.id!);
}

// ------------------------------------------------------------------ SOS card (BR-09-72)
export interface SosProfileDto {
  sosId: number;
  unitLabel: string;
  people: {
    name: string;
    age: number | null;
    bloodGroup: string | null;
    isSeniorCitizen: boolean;
    isDifferentlyAbled: boolean;
    mobilityNote: string | null;
    medicalNotes: string | null;
    preferredHospital: string | null;
    contacts: EmergencyContact[];
  }[];
}

/**
 * Profiles of the residents of the SOS flat, only while module 17 reports the SOS as ACTIVE. Contacts are unmasked on
 * purpose (the guard must call them). Medical notes are decrypted here only. Every view is audited with the SOS id.
 */
export async function forSos(
  ctx: Ctx,
  sosId: number,
  o: { societyId?: number } = {},
): Promise<SosProfileDto> {
  const societyId = o.societyId ?? ctx.society?.id;
  if (!societyId) throw new NotFoundError('SOS_NOT_FOUND', 'SOS not found');
  const sos = await residentPorts().sos.getActive(societyId, sosId);
  if (!sos) throw new NotFoundError('SOS_NOT_FOUND', 'SOS not found');
  if (sos.status !== 'ACTIVE')
    throw new ForbiddenError(
      'EMERGENCY_PROFILE_LOCKED',
      'The emergency profiles are available only during an active SOS',
    );
  const today = await societyToday(societyId);
  const unit = await Unit.findOne({ where: { id: sos.unitId, societyId }, attributes: ['id', 'label'] });
  if (!unit) throw new NotFoundError('SOS_NOT_FOUND', 'SOS not found');
  const links = await UnitResident.findAll({
    where: {
      societyId,
      unitId: sos.unitId,
      fromDate: { [Op.lte]: today },
      [Op.or]: [{ toDate: null }, { toDate: { [Op.gte]: today } }],
    },
    attributes: ['residentId'],
  });
  const ids = [...new Set(links.map(l => l.residentId))];
  const residents = await Resident.findAll({
    where: { societyId, id: { [Op.in]: ids } },
    order: [['name', 'ASC']],
  });
  const profiles = new Map(
    (await EmergencyProfile.findAll({ where: { societyId, residentId: { [Op.in]: ids } } })).map(p => [
      p.residentId,
      p,
    ]),
  );
  const people: SosProfileDto['people'] = [];
  for (const r of residents) {
    const p = profiles.get(r.id!);
    if (!p) continue;
    const consent = Boolean(p.consentGivenAt) && !p.consentWithdrawnAt;
    const contacts = contactsOf(p);
    if (!consent && !contacts.length) continue;
    people.push({
      name: r.name,
      age: ageOf(r.dateOfBirth, today),
      bloodGroup: consent ? p.bloodGroup : null,
      isSeniorCitizen: consent && Boolean(p.isSeniorCitizen),
      isDifferentlyAbled: consent && Boolean(p.isDifferentlyAbled),
      mobilityNote: consent ? p.mobilityNote : null,
      medicalNotes: consent && p.medicalNotesEnc ? decryptNotes(Buffer.from(p.medicalNotesEnc)) : null,
      preferredHospital: p.preferredHospital,
      contacts,
    });
  }
  await sequelize.transaction(t =>
    audit(
      ctx,
      {
        action: AUDIT.emergencyViewed,
        entityType: ENTITY.sos,
        entityId: sosId,
        societyId,
        after: { unitId: sos.unitId, people: people.length },
      },
      t,
    ),
  );
  return { sosId, unitLabel: unit.label, people };
}
