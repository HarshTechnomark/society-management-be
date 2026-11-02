import { z } from 'zod';
import { BUILDING_KINDS } from '../../models/building.model';
import { BHK_VALUES, UNIT_TYPES } from '../../models/unit.model';
import { AREA_TYPES } from '../../models/location-node.model';
import { HOLIDAY_TYPES } from '../../models/holiday.model';
import { INDIAN_STATES, SOCIETY_LOCALES } from '../societies/societies.types';
import { GSTIN_PATTERN } from './society-setup.gstin';
import { CLIENT_STEP_KEYS } from './society-setup.onboarding.service';
import { SETTING_NAMESPACES, settingDef } from './society-setup.settings-registry';

/** Zod schemas for module 08 (section 8). Bodies are `.strict()`; ids are positive integers. */
const id = z.coerce.number().int().positive();
const version = z.number().int().min(1);
const page = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
const bool = z.union([z.boolean(), z.enum(['true', 'false'])]).transform(v => v === true || v === 'true');
const text = (min: number, max: number, what = 'Text') =>
  z
    .string()
    .trim()
    .min(min, `${what} must be at least ${min} characters`)
    .max(max, `${what} must be at most ${max} characters`);
const reason = (min: number, max: number) => text(min, max, 'Reason');
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
const many = <T extends z.ZodType>(s: T) =>
  z.preprocess(
    v => (v === undefined || v === '' ? undefined : Array.isArray(v) ? v : String(v).split(',')),
    z.array(s).min(1).optional(),
  );

const idParam = z.object({ id });
const empty = z.object({}).strict();

// ------------------------------------------------------------------ society profile (8.3) and settings (8.4, 8.5)
const timezone = z
  .string()
  .max(40)
  .refine(tz => {
    try {
      new Intl.DateTimeFormat('en-IN', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Not a valid IANA time zone');

const profileExtras = z
  .object({
    societyType: settingDef('profile.societyType').schema.optional(),
    pan: settingDef('profile.pan').schema.optional(),
    tan: settingDef('profile.tan').schema.optional(),
    registrationDate: settingDef('profile.registrationDate').schema.optional(),
    contactEmail: settingDef('profile.contactEmail').schema.optional(),
    contactPhone: settingDef('profile.contactPhone').schema.optional(),
  })
  .strict();

const profileUpdate = z
  .object({
    version,
    name: text(3, 150, 'Name').optional(),
    legalName: text(3, 200, 'Legal name').nullable().optional(),
    registrationNo: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .regex(/^[A-Za-z0-9/().,\- ]+$/, 'Use letters, digits and / ( ) . , - only')
      .nullable()
      .optional(),
    gstin: z.string().trim().toUpperCase().regex(GSTIN_PATTERN, 'Not a valid GSTIN').nullable().optional(),
    addressLine1: text(5, 200, 'Address').optional(),
    addressLine2: z.string().trim().max(200).nullable().optional(),
    city: text(2, 80, 'City').optional(),
    state: z.enum(INDIAN_STATES).optional(),
    pincode: z
      .string()
      .regex(/^[1-9]\d{5}$/, 'Use a 6-digit pincode')
      .optional(),
    timezone: timezone.optional(),
    locale: z.enum(SOCIETY_LOCALES).optional(),
    logoFileId: id.nullable().optional(),
    profile: profileExtras.optional(),
    reason: reason(5, 500).optional(),
  })
  .strict();

const settingsQuery = z.object({ namespace: z.enum(SETTING_NAMESPACES).optional() });

const settingsPatch = z
  .object({
    changes: z
      .array(
        z
          .object({
            key: z.string().min(3).max(80),
            value: z.unknown(),
            version: z.number().int().min(0),
          })
          .strict()
          .refine(c => c.value !== undefined, { message: 'A value is required', path: ['value'] }),
      )
      .min(1)
      .max(30)
      .refine(a => new Set(a.map(c => c.key)).size === a.length, 'Keys must be unique'),
    reason: reason(5, 500).optional(),
  })
  .strict();

// ------------------------------------------------------------------ buildings (8.6 to 8.9)
const code = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{1,6}$/, 'Use 1 to 6 letters or digits');
const buildingFields = {
  code,
  name: text(2, 80, 'Name'),
  kind: z.enum(BUILDING_KINDS),
  parentBuildingId: id.nullable(),
  floorsAboveGround: z.number().int().min(0).max(200),
  basements: z.number().int().min(0).max(5),
  liftCount: z.number().int().min(0).max(50),
  sortOrder: z.number().int().min(0).max(9999),
};
const buildingList = z.object({
  status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).default('ACTIVE'),
  kind: z.enum(BUILDING_KINDS).optional(),
  parentBuildingId: id.optional(),
  q: z.string().trim().min(1).max(40).optional(),
  sortBy: z.enum(['sortOrder', 'code', 'name', 'createdAt']).default('sortOrder'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  ...page,
});
const buildingCreate = z
  .object({
    code: buildingFields.code,
    name: buildingFields.name,
    kind: buildingFields.kind,
    parentBuildingId: buildingFields.parentBuildingId.optional(),
    floorsAboveGround: buildingFields.floorsAboveGround,
    basements: buildingFields.basements.optional(),
    liftCount: buildingFields.liftCount.optional(),
    sortOrder: buildingFields.sortOrder.optional(),
  })
  .strict();
const buildingPatch = z
  .object({
    version,
    code: buildingFields.code.optional(),
    name: buildingFields.name.optional(),
    kind: buildingFields.kind.optional(),
    parentBuildingId: buildingFields.parentBuildingId.optional(),
    floorsAboveGround: buildingFields.floorsAboveGround.optional(),
    basements: buildingFields.basements.optional(),
    liftCount: buildingFields.liftCount.optional(),
    sortOrder: buildingFields.sortOrder.optional(),
  })
  .strict();
const archiveBody = z.object({ reason: reason(5, 300), version }).strict();
const versionBody = z.object({ version }).strict();
const gridQuery = z.object({ includeArchived: bool.default(false) });

// ------------------------------------------------------------------ units (8.10 to 8.14)
const area = z
  .string()
  .regex(/^\d{1,6}(\.\d{1,3})?$/, 'Use a number with at most 3 decimals')
  .refine(v => Number(v) >= 1 && Number(v) <= 100000, 'Between 1 and 100000 sq ft');
const share = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Use a number with at most 4 decimals')
  .refine(v => Number(v) > 0 && Number(v) <= 100, 'Greater than 0 and at most 100');
const unitNumber = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9/-]{0,19}$/, 'Use 1 to 20 letters, digits, / or -');
const floor = z.number().int().min(-5).max(200);
const unitFields = {
  buildingId: id,
  unitNumber,
  floor,
  positionOnFloor: z.number().int().min(1).max(50).nullable(),
  unitType: z.enum(UNIT_TYPES),
  bhk: z.enum(BHK_VALUES).nullable(),
  carpetAreaSqft: area.nullable(),
  builtUpAreaSqft: area.nullable(),
  superBuiltUpAreaSqft: area.nullable(),
  undividedSharePct: share.nullable(),
  isBillable: z.boolean(),
  possessionDate: ymd.nullable(),
  notes: z.string().trim().max(500).nullable(),
};
const unitCreate = z
  .object({
    buildingId: unitFields.buildingId,
    unitNumber: unitFields.unitNumber,
    floor: unitFields.floor,
    positionOnFloor: unitFields.positionOnFloor.optional(),
    unitType: unitFields.unitType.optional(),
    bhk: unitFields.bhk.optional(),
    carpetAreaSqft: unitFields.carpetAreaSqft.optional(),
    builtUpAreaSqft: unitFields.builtUpAreaSqft.optional(),
    superBuiltUpAreaSqft: unitFields.superBuiltUpAreaSqft.optional(),
    undividedSharePct: unitFields.undividedSharePct.optional(),
    isBillable: unitFields.isBillable.optional(),
    possessionDate: unitFields.possessionDate.optional(),
    notes: unitFields.notes.optional(),
  })
  .strict();
const unitPatch = z
  .object({
    version,
    buildingId: unitFields.buildingId.optional(),
    unitNumber: unitFields.unitNumber.optional(),
    floor: unitFields.floor.optional(),
    positionOnFloor: unitFields.positionOnFloor.optional(),
    unitType: unitFields.unitType.optional(),
    bhk: unitFields.bhk.optional(),
    carpetAreaSqft: unitFields.carpetAreaSqft.optional(),
    builtUpAreaSqft: unitFields.builtUpAreaSqft.optional(),
    superBuiltUpAreaSqft: unitFields.superBuiltUpAreaSqft.optional(),
    undividedSharePct: unitFields.undividedSharePct.optional(),
    isBillable: unitFields.isBillable.optional(),
    possessionDate: unitFields.possessionDate.optional(),
    notes: unitFields.notes.optional(),
  })
  .strict();
const unitList = z.object({
  buildingId: id.optional(),
  floor: z.coerce.number().int().min(-5).max(200).optional(),
  unitType: many(z.enum(UNIT_TYPES)),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).default('ACTIVE'),
  bhk: z.enum(BHK_VALUES).optional(),
  isBillable: bool.optional(),
  missingArea: bool.optional(),
  q: z.string().trim().min(1).max(40).optional(),
  sortBy: z.enum(['position', 'label', 'floor', 'areaSqft', 'createdAt']).default('position'),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
  ...page,
});

const bulkUpdate = z
  .object({
    unitIds: z
      .array(id)
      .min(1)
      .max(500)
      .refine(a => new Set(a).size === a.length, 'Ids must be distinct')
      .optional(),
    selector: z
      .object({
        buildingId: id,
        positions: z
          .array(z.number().int().min(1).max(50))
          .min(1)
          .max(50)
          .refine(a => new Set(a).size === a.length, 'Positions must be distinct'),
        floorFrom: floor.optional(),
        floorTo: floor.optional(),
      })
      .strict()
      .optional(),
    set: z
      .object({
        unitType: unitFields.unitType.optional(),
        bhk: unitFields.bhk.optional(),
        carpetAreaSqft: unitFields.carpetAreaSqft.optional(),
        builtUpAreaSqft: unitFields.builtUpAreaSqft.optional(),
        superBuiltUpAreaSqft: unitFields.superBuiltUpAreaSqft.optional(),
        undividedSharePct: unitFields.undividedSharePct.optional(),
        isBillable: unitFields.isBillable.optional(),
        possessionDate: unitFields.possessionDate.optional(),
      })
      .strict()
      .refine(s => Object.values(s).some(v => v !== undefined), 'Set at least one field'),
  })
  .strict()
  .refine(b => (b.unitIds === undefined) !== (b.selector === undefined), {
    message: 'Send either unitIds or selector',
    path: ['unitIds'],
  });

const positionConfig = z
  .object({
    position: z.number().int().min(1).max(50),
    unitType: unitFields.unitType.optional(),
    bhk: unitFields.bhk.optional(),
    carpetAreaSqft: unitFields.carpetAreaSqft.optional(),
    builtUpAreaSqft: unitFields.builtUpAreaSqft.optional(),
    superBuiltUpAreaSqft: unitFields.superBuiltUpAreaSqft.optional(),
    isBillable: unitFields.isBillable.optional(),
  })
  .strict();
const generatorBase = z
  .object({
    buildings: z
      .array(
        z.union([
          z.object({ buildingId: id }).strict(),
          z
            .object({
              newBuilding: z
                .object({
                  code,
                  name: text(2, 80, 'Name'),
                  kind: z.enum(['TOWER', 'WING', 'COMMERCIAL']),
                  parentBuildingId: id.nullable().optional(),
                })
                .strict(),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(10),
    floorFrom: floor,
    floorTo: floor,
    positions: z.array(positionConfig).min(1).max(50),
    pattern: z.string().min(1).max(40),
    skipFloors: z.array(floor).max(50).optional(),
    skipCells: z
      .array(z.object({ floor, position: z.number().int().min(1).max(50) }).strict())
      .max(200)
      .optional(),
  })
  .strict();
const generatorPreview = generatorBase.refine(g => g.floorTo >= g.floorFrom, {
  message: 'Must not be below floorFrom',
  path: ['floorTo'],
});
const generatorCommit = generatorBase
  .extend({ previewHash: z.string().regex(/^[0-9a-f]{64}$/, 'Use the 64-character hash of the preview') })
  .refine(g => g.floorTo >= g.floorFrom, { message: 'Must not be below floorFrom', path: ['floorTo'] });

// ------------------------------------------------------------------ locations (8.19 to 8.21)
const areaType = z.enum(AREA_TYPES);
const locationQuery = z.object({
  status: z.enum(['ACTIVE', 'ALL']).default('ACTIVE'),
  buildingId: id.optional(),
  areaType: areaType.optional(),
  rootOnly: bool.optional(),
});
const locationCreate = z
  .object({
    parentId: id.nullable(),
    nodeType: z.enum(['FLOOR', 'AREA']),
    floor: floor.optional(),
    areaType: areaType.optional(),
    name: text(2, 80, 'Name').optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    notes: z.string().trim().max(300).nullable().optional(),
  })
  .strict();
const locationPatch = z
  .object({
    version,
    name: text(2, 80, 'Name').optional(),
    areaType: areaType.optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    notes: z.string().trim().max(300).nullable().optional(),
    parentId: id.nullable().optional(),
  })
  .strict();

// ------------------------------------------------------------------ holidays (8.22)
const holidayFields = {
  holidayDate: ymd,
  name: text(2, 80, 'Name'),
  holidayType: z.enum(HOLIDAY_TYPES),
  isOfficeClosed: z.boolean(),
  notes: z.string().trim().max(300).nullable(),
};
const holidayCreate = z
  .object({
    holidayDate: holidayFields.holidayDate,
    name: holidayFields.name,
    holidayType: holidayFields.holidayType.optional(),
    isOfficeClosed: holidayFields.isOfficeClosed.optional(),
    notes: holidayFields.notes.optional(),
  })
  .strict();
const holidayPatch = z
  .object({
    version,
    holidayDate: holidayFields.holidayDate.optional(),
    name: holidayFields.name.optional(),
    holidayType: holidayFields.holidayType.optional(),
    isOfficeClosed: holidayFields.isOfficeClosed.optional(),
    notes: holidayFields.notes.optional(),
  })
  .strict();
const holidayBulk = z.object({ items: z.array(holidayCreate).min(1).max(60) }).strict();
const holidayYear = z.object({ year: z.coerce.number().int().min(1900).max(2200).optional() });

// ------------------------------------------------------------------ onboarding (8.24, 8.25)
const stepParam = z.object({ stepKey: z.enum(CLIENT_STEP_KEYS) });
const skipBody = z.object({ reason: reason(5, 300) }).strict();

export const setupSchemas = {
  idParam,
  empty,
  profileUpdate,
  settingsQuery,
  settingsPatch,
  buildingList,
  buildingCreate,
  buildingPatch,
  archiveBody,
  versionBody,
  gridQuery,
  unitCreate,
  unitPatch,
  unitList,
  bulkUpdate,
  generatorPreview,
  generatorCommit,
  locationQuery,
  locationCreate,
  locationPatch,
  holidayCreate,
  holidayPatch,
  holidayBulk,
  holidayYear,
  stepParam,
  skipBody,
};
