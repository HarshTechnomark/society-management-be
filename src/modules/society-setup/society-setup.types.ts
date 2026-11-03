import type { Transaction } from 'sequelize';
import type { Bhk, UnitType } from '../../models/unit.model';

/** Shared constants and DTO types of module 08 (Society Setup and Onboarding). Audit actions follow section 9.2. */
export const SOCIETY_SETUP_QUEUE = 'society-setup';

/** Job names of section 9.1 (queue `society-setup`). */
export const JOBS = {
  validateImport: 'society-setup:validate-import',
  commitImport: 'society-setup:commit-import',
  exportUnits: 'society-setup:export-units',
  goLiveInvites: 'society-setup:go-live-invites',
} as const;

export const AUDIT = {
  societyUpdated: 'setup.society.updated',
  societyWentLive: 'setup.society.went_live',
  settingUpdated: 'setup.settings.updated',
  buildingCreated: 'setup.building.created',
  buildingUpdated: 'setup.building.updated',
  buildingArchived: 'setup.building.archived',
  buildingRestored: 'setup.building.restored',
  buildingDeleted: 'setup.building.deleted',
  unitCreated: 'setup.unit.created',
  unitUpdated: 'setup.unit.updated',
  unitArchived: 'setup.unit.archived',
  unitRestored: 'setup.unit.restored',
  unitDeleted: 'setup.unit.deleted',
  unitBulkUpdated: 'setup.unit.bulk_updated',
  unitGenerated: 'setup.unit.generated',
  unitAreaRecomputed: 'setup.unit.area_recomputed',
  unitExported: 'setup.unit.exported',
  importCommitted: 'setup.import.committed',
  locationCreated: 'setup.location.created',
  locationUpdated: 'setup.location.updated',
  locationMoved: 'setup.location.moved',
  locationArchived: 'setup.location.archived',
  locationRestored: 'setup.location.restored',
  locationQrRegenerated: 'setup.location.qr_regenerated',
  holidayCreated: 'setup.holiday.created',
  holidayUpdated: 'setup.holiday.updated',
  holidayDeleted: 'setup.holiday.deleted',
  stepCompleted: 'setup.onboarding.step_completed',
  stepSkipped: 'setup.onboarding.step_skipped',
  stepReopened: 'setup.onboarding.step_reopened',
} as const;

export const ENTITY = {
  society: 'society',
  setting: 'society_setting',
  building: 'building',
  unit: 'unit',
  location: 'location_node',
  holiday: 'holiday',
  step: 'onboarding_step',
  import: 'unit_import',
} as const;

/** Entitlement keys of section 2. */
export const FEATURE = {
  profile: 'property.society_profile',
  settings: 'property.society_settings',
  hierarchy: 'property.property_hierarchy',
  registry: 'property.unit_registry',
  generator: 'property.bulk_unit_generator',
  spreadsheetImport: 'property.spreadsheet_import',
  exportStructure: 'property.export_structure',
  commonAreas: 'property.common_areas_registry',
  gates: 'property.gates_registry',
  qr: 'property.unit_qr_codes',
} as const;

export const FLATS_LIMIT = 'limit.flats' as const;

export type AreaBasis = 'CARPET' | 'BUILT_UP' | 'SUPER_BUILT_UP';
export const AREA_COLUMN: Record<AreaBasis, 'carpetAreaSqft' | 'builtUpAreaSqft' | 'superBuiltUpAreaSqft'> = {
  CARPET: 'carpetAreaSqft',
  BUILT_UP: 'builtUpAreaSqft',
  SUPER_BUILT_UP: 'superBuiltUpAreaSqft',
};

export interface UnitDto {
  id: number;
  societyId: number;
  buildingId: number;
  buildingCode: string;
  label: string;
  unitNumber: string;
  floor: number;
  floorLabel: string;
  positionOnFloor: number | null;
  unitType: UnitType;
  bhk: Bhk | null;
  areaSqft: string | null;
  carpetAreaSqft: string | null;
  builtUpAreaSqft: string | null;
  superBuiltUpAreaSqft: string | null;
  undividedSharePct: string | null;
  isBillable: boolean;
  status: 'ACTIVE' | 'ARCHIVED';
}

export interface BuildingDto {
  id: number;
  code: string;
  name: string;
  kind: string;
  parentBuildingId: number | null;
  floorsAboveGround: number;
  basements: number;
  liftCount: number;
  sortOrder: number;
  status: string;
  floorLabels: { min: string; max: string };
  unitCounts: { active: number; archived: number; countable: number };
  wings: { id: number; code: string; name: string; status: string }[];
  locationNodeId: number | null;
  version: number;
  createdAt: string;
}

export interface LocationDto {
  id: number;
  nodeType: 'BUILDING' | 'FLOOR' | 'AREA';
  areaType: string | null;
  name: string;
  buildingId: number | null;
  floor: number | null;
  parentId: number | null;
  pathLabel: string;
  sortOrder: number;
  status: string;
  notes: string | null;
  qrToken?: string;
  version: number;
}
export interface LocationTreeDto extends Omit<LocationDto, 'pathLabel'> {
  pathLabel?: string;
  children: LocationTreeDto[];
}

export interface HolidayDto {
  id: number;
  holidayDate: string;
  name: string;
  holidayType: string;
  isOfficeClosed: boolean;
  notes: string | null;
  version: number;
}

/** A guard another module registers to block archive or delete of a unit (BR-08-26, BR-08-28). */
export interface UnitGuard {
  module: string;
  /** Returns a reason code (`UNIT_HAS_RESIDENTS`, ...) or null when the unit may go. */
  check(
    societyId: number,
    unitId: number,
    action: 'ARCHIVE' | 'DELETE',
    t: Transaction,
  ): Promise<string | null>;
}

export const PATCH_UNIT_ERROR = 'VALIDATION_FAILED';
