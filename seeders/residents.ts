import {
  EmergencyProfile,
  Pet,
  Resident,
  Society,
  SocietyMember,
  Tenancy,
  UnitResident,
  User,
  sequelize,
} from '../src/models';
import { istDate, now } from '../src/lib/clock';
import { systemCtx } from '../src/types/context';
import { units } from '../src/modules/society-setup/society-setup.public';
import type { UnitDto } from '../src/modules/society-setup/society-setup.types';
import { createLink } from '../src/modules/residents/residents.links.service';
import { syncMembership } from '../src/modules/residents/residents.sync';
import { encryptNotes } from '../src/modules/residents/residents.crypto';
import { addDaysYmd } from '../src/modules/residents/residents.shared';
import type { FamilyRelation } from '../src/models/unit-resident.model';

/**
 * Module 09 demo seed (spec 16 step 9), not run in production. Sky Heights CHS gets owners for 60 of its 72 flats (the
 * chairman, treasurer and secretary of the demo accounts own A-501, B-302 and C-104 and keep their society roles), two
 * flats with co-owners (50 and 50), family members (two of them minors), 14 ACTIVE tenancies (two ending in 20 days, one
 * in overstay, the rest verified or not yet verified), two pets and an emergency profile. Green Park CHS gets owners for 24 of
 * its 30 flats, three tenancies and one pet. Idempotent: a society that already has residents is left alone. The join
 * requests, the approved move and the renovation permit of the spec are seeded by parts 2 and 3.
 */
const FIRST = [
  'Aarav',
  'Vihaan',
  'Aditya',
  'Sai',
  'Arjun',
  'Reyansh',
  'Krishna',
  'Ishaan',
  'Rohan',
  'Kabir',
  'Ananya',
  'Diya',
  'Priya',
  'Neha',
  'Pooja',
  'Sneha',
  'Kavya',
  'Meera',
  'Riya',
  'Isha',
  'Manish',
  'Suresh',
  'Ramesh',
  'Anil',
];
const LAST = [
  'Sharma',
  'Verma',
  'Iyer',
  'Nair',
  'Patil',
  'Desai',
  'Kulkarni',
  'Joshi',
  'Shah',
  'Mehta',
  'Reddy',
  'Rao',
  'Khan',
  'Singh',
  'Gupta',
  'Bhatt',
  'Naik',
  'Pillai',
  'Menon',
  'Kapoor',
];
const nameOf = (i: number): string => `${FIRST[i % FIRST.length]} ${LAST[(i * 7 + 3) % LAST.length]}`;

interface Plan {
  slug: string;
  prefix: string;
  owners: number;
  tenancies: number;
  coOwnerFlats: number;
  family: number;
  /** Demo accounts that own a flat: mobile, flat label. */
  accounts: { mobile: string; flat: string }[];
  pets: { flat: string; name: string; species: 'DOG' | 'CAT'; vaccinationInDays: number | null }[];
}

const PLANS: Plan[] = [
  {
    slug: 'sky-heights',
    prefix: '97',
    owners: 60,
    tenancies: 14,
    coOwnerFlats: 2,
    family: 15,
    accounts: [
      { mobile: '9820011111', flat: 'A-501' },
      { mobile: '9820022222', flat: 'B-302' },
      { mobile: '9820033333', flat: 'C-104' },
    ],
    pets: [
      { flat: 'A-501', name: 'Bruno', species: 'DOG', vaccinationInDays: 40 },
      { flat: 'B-302', name: 'Mishti', species: 'CAT', vaccinationInDays: null },
    ],
  },
  {
    slug: 'green-park',
    prefix: '96',
    owners: 24,
    tenancies: 3,
    coOwnerFlats: 0,
    family: 5,
    accounts: [
      { mobile: '9820066666', flat: 'A-101' },
      { mobile: '9820077777', flat: 'A-202' },
      { mobile: '9820011111', flat: 'B-203' },
    ],
    pets: [{ flat: 'A-202', name: 'Coco', species: 'DOG', vaccinationInDays: 90 }],
  },
];

export interface ResidentsSeedReport {
  societies: string[];
  skipped: string[];
  residents: number;
  links: number;
  tenancies: number;
  pets: number;
}

export async function seedResidents(): Promise<ResidentsSeedReport> {
  if (process.env.NODE_ENV === 'production')
    throw new Error('residents demo seed must not run in production');
  const report: ResidentsSeedReport = {
    societies: [],
    skipped: [],
    residents: 0,
    links: 0,
    tenancies: 0,
    pets: 0,
  };
  const ctx = systemCtx('seed');
  const today = istDate(now());
  for (const plan of PLANS) {
    const society = await Society.findOne({ where: { slug: plan.slug } });
    if (!society) continue;
    const societyId = society.id!;
    if ((await Resident.count({ where: { societyId } })) > 0 || (await units.count(societyId)) === 0) {
      report.skipped.push(plan.slug);
      continue;
    }
    const all = await units.listActive(societyId);
    const byLabel = new Map<string, UnitDto>(all.map(u => [u.label, u]));
    const accountFlats = new Set(plan.accounts.map(a => a.flat));
    // demo accounts first, then the other flats in label order
    const ordered = [
      ...plan.accounts.map(a => byLabel.get(a.flat)).filter((u): u is UnitDto => Boolean(u)),
      ...all.filter(u => !accountFlats.has(u.label)),
    ].slice(0, plan.owners);
    let seq = 0;
    const mobile = () => `${plan.prefix}${String(10_000_000 + seq).padStart(8, '0')}`;
    const make = async (name: string, extra: Partial<Resident> = {}) => {
      seq += 1;
      const r = await Resident.create({
        societyId,
        userId: null,
        memberId: null,
        name,
        mobile: mobile(),
        alternateMobile: null,
        email: null,
        dateOfBirth: null,
        gender: null,
        photoFileId: null,
        preferredLanguage: 'en-IN',
        isNri: false,
        overseasPhone: null,
        localRepresentativeResidentId: null,
        status: 'ACTIVE',
        source: 'ADMIN',
        directoryVisible: true,
        showMobileInDirectory: seq % 3 === 0,
        showEmailInDirectory: false,
        showPhotoInDirectory: false,
        adminNote: null,
        anonymisedAt: null,
        version: 1,
        createdBy: null,
        updatedBy: null,
        deletedAt: null,
        ...extra,
      } as never);
      report.residents += 1;
      return r;
    };
    const link = async (
      residentId: number,
      unitId: number,
      relation: 'OWNER' | 'CO_OWNER' | 'FAMILY' | 'TENANT',
      o: {
        familyRelation?: FamilyRelation;
        tenancyId?: number;
        fromDate?: string;
        isResiding?: boolean;
        share?: string;
        canLogin?: boolean;
      } = {},
    ) => {
      await sequelize.transaction(async t => {
        await createLink(
          ctx,
          societyId,
          {
            residentId,
            unitId,
            relation,
            ...(o.familyRelation ? { familyRelation: o.familyRelation } : {}),
            ...(o.tenancyId ? { tenancyId: o.tenancyId } : {}),
            ...(o.share ? { sharePercent: o.share } : {}),
            ...(o.canLogin !== undefined ? { canLogin: o.canLogin } : {}),
            isResiding: o.isResiding ?? true,
            fromDate: o.fromDate ?? addDaysYmd(today, -400),
          },
          t,
          { checkFeature: false, internal: true, skipShareCheck: true },
        );
      });
      report.links += 1;
    };
    const ownerOf = new Map<number, Resident>();
    for (const [i, u] of ordered.entries()) {
      const acc = plan.accounts.find(a => a.flat === u.label);
      const user = acc ? await User.findOne({ where: { mobile: acc.mobile } }) : null;
      const r = await make(user?.name ?? nameOf(i), { ...(acc ? { mobile: acc.mobile } : {}) });
      if (user) {
        const m = await SocietyMember.findOne({ where: { societyId, userId: user.id! } });
        await r.update({ userId: user.id!, memberId: m?.id ?? null, email: user.email });
      }
      ownerOf.set(u.id, r);
      await link(r.id!, u.id, 'OWNER');
      if (user) await sequelize.transaction(t => syncMembership(ctx, t, r.id!, { societyId }));
    }
    // co-owners (50 and 50): the owner of the flat and one more person
    for (const u of plan.coOwnerFlats ? ordered.slice(-plan.coOwnerFlats) : []) {
      const co = await make(nameOf(100 + u.id));
      await link(co.id!, u.id, 'CO_OWNER');
      await sequelize.transaction(async t => {
        const rows = await UnitResident.findAll({
          where: { societyId, unitId: u.id, toDate: null },
          transaction: t,
        });
        for (const row of rows) {
          row.sharePercent = '50.00';
          row.version += 1;
          await row.save({ transaction: t });
        }
      });
    }
    // family members (a spouse, a child and a minor child in the first flats)
    const rel: [FamilyRelation, string | null][] = [
      ['SPOUSE', '1985-06-12'],
      ['CHILD', '2008-02-20'],
      ['CHILD', addDaysYmd(today, -365 * 9)],
    ];
    for (let i = 0; i < plan.family; i++) {
      const u = ordered[i * 2 + 1];
      if (!u) break;
      const [familyRelation, dob] = rel[i % rel.length]!;
      const f = await make(nameOf(200 + i), { dateOfBirth: dob });
      await link(f.id!, u.id, 'FAMILY', {
        familyRelation,
        canLogin: dob !== null && dob < addDaysYmd(today, -365 * 18),
      });
    }
    // tenancies: flats from position 20 on are rented out by their owners
    const rented = ordered.slice(20, 20 + plan.tenancies);
    for (const [i, u] of rented.entries()) {
      const owner = ownerOf.get(u.id)!;
      const tenant = await make(nameOf(300 + i));
      const overstay = i === 0;
      const endsSoon = i === 1 || i === 2;
      const start = overstay ? addDaysYmd(today, -400) : addDaysYmd(today, -(120 + i * 10));
      const end = overstay
        ? addDaysYmd(today, -5)
        : endsSoon
          ? addDaysYmd(today, 20)
          : addDaysYmd(today, 200 + i * 15);
      const tn = await Tenancy.create({
        societyId,
        unitId: u.id,
        tenantResidentId: tenant.id!,
        landlordResidentId: owner.id!,
        status: overstay ? 'EXPIRED_OVERSTAY' : 'ACTIVE',
        agreementType: 'LEAVE_AND_LICENCE',
        agreementStart: start,
        agreementEnd: end,
        agreementRegistrationNo: null,
        monthlyRentPaise: 2_500_000 + i * 100_000,
        securityDepositPaise: 7_500_000,
        maintenancePayer: i % 3 === 0 ? 'TENANT' : 'OWNER',
        occupantCount: 2,
        policeVerificationStatus: i < Math.ceil(plan.tenancies * 0.65) ? 'VERIFIED' : 'NOT_SUBMITTED',
        policeVerificationRef: i < Math.ceil(plan.tenancies * 0.65) ? `PV-${2026}-${1000 + i}` : null,
        policeVerifiedOn: i < Math.ceil(plan.tenancies * 0.65) ? addDaysYmd(start, 14) : null,
        policeVerificationNote: null,
        policeReminderSentAt: null,
        source: 'ADMIN',
        submittedAt: now(),
        submittedBy: null,
        decidedBy: null,
        decidedAt: now(),
        decisionReason: null,
        moveInDate: start,
        endedOn: null,
        endReason: null,
        endNote: null,
        renewalCount: 0,
        previousAgreementEnd: null,
        lastExpiryReminderDays: null,
        overstayAlertedAt: overstay ? now() : null,
        version: 1,
        createdBy: null,
        updatedBy: null,
      } as never);
      report.tenancies += 1;
      await link(tenant.id!, u.id, 'TENANT', { tenancyId: tn.id!, fromDate: start });
      // the owner lets the flat out and does not live there
      await sequelize.transaction(async t => {
        await UnitResident.update(
          { isResiding: false },
          { where: { societyId, unitId: u.id, residentId: owner.id!, toDate: null }, transaction: t },
        );
      });
    }
    // pets and one emergency profile
    for (const p of plan.pets) {
      const u = byLabel.get(p.flat);
      const owner = u ? ownerOf.get(u.id) : undefined;
      if (!u || !owner) continue;
      await Pet.create({
        societyId,
        unitId: u.id,
        ownerResidentId: owner.id!,
        name: p.name,
        species: p.species,
        breed: p.species === 'DOG' ? 'Labrador' : 'Indian shorthair',
        gender: 'UNKNOWN',
        colour: null,
        dateOfBirth: null,
        photoFileId: null,
        licenceNo: null,
        isNeutered: null,
        temperamentNote: null,
        lastVaccineName: p.vaccinationInDays !== null ? 'Anti-rabies' : null,
        lastVaccinatedOn: p.vaccinationInDays !== null ? addDaysYmd(today, p.vaccinationInDays - 365) : null,
        vaccinationValidUntil: p.vaccinationInDays !== null ? addDaysYmd(today, p.vaccinationInDays) : null,
        vaccinationReminderFor: null,
        status: 'ACTIVE',
        inactiveReason: null,
        version: 1,
        createdBy: null,
        updatedBy: null,
        deletedAt: null,
      } as never);
      report.pets += 1;
    }
    const first = plan.accounts[0] ? byLabel.get(plan.accounts[0].flat) : undefined;
    const demoOwner = first ? ownerOf.get(first.id) : undefined;
    if (demoOwner)
      await EmergencyProfile.create({
        societyId,
        residentId: demoOwner.id!,
        bloodGroup: 'B_POS',
        medicalNotesEnc: encryptNotes('Diabetic, takes insulin in the morning'),
        isSeniorCitizen: false,
        isDifferentlyAbled: false,
        mobilityNote: null,
        preferredHospital: 'Ruby Hall Clinic',
        contact1Name: 'Sunita Kulkarni',
        contact1Relation: 'Spouse',
        contact1Mobile: '9822012345',
        contact2Name: null,
        contact2Relation: null,
        contact2Mobile: null,
        contact3Name: null,
        contact3Relation: null,
        contact3Mobile: null,
        consentGivenAt: now(),
        consentTextVersion: 'v1',
        consentByUserId: demoOwner.userId,
        consentWithdrawnAt: null,
        version: 1,
        createdBy: null,
        updatedBy: null,
      } as never);
    report.societies.push(plan.slug);
  }
  return report;
}
