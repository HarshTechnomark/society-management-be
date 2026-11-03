import { Op, QueryTypes, type Transaction } from 'sequelize';
import { Building, Unit, sequelize } from '../../models';
import { BHK_VALUES, UNIT_TYPES, type Bhk, type UnitType } from '../../models/unit.model';
import { istDate, now } from '../../lib/clock';
import { entitlements } from '../subscriptions/subscriptions.public';
import { isCountable } from './society-setup.limits';
import { UNIT_NUMBER_RE } from './society-setup.generator.pattern';
import { floorLabelSettings, inFloorRange } from './society-setup.shared';
import { defaultBillable } from './society-setup.units.service';
import { FLATS_LIMIT } from './society-setup.types';
import { importFileInvalid, type Cell, type ParsedSheet } from './society-setup.imports.parse';

/**
 * Row rules of the unit import (BR-08-33 to BR-08-36, section 8.15). One function plans every row: the dry run calls it
 * without a transaction, the commit job inside the commit transaction with the society share rows and buildings locked.
 * A row gets exactly one outcome: CREATE, UPDATE, UNCHANGED or ERROR with the first problem found.
 */
export type ImportMode = 'CREATE_ONLY' | 'UPSERT';
export type RowAction = 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'ERROR';

export const FIELDS = [
  'building',
  'unit',
  'floor',
  'unitType',
  'bhk',
  'carpetAreaSqft',
  'builtUpAreaSqft',
  'superBuiltUpAreaSqft',
  'undividedSharePct',
  'isBillable',
  'possessionDate',
  'notes',
] as const;
export type Field = (typeof FIELDS)[number];

const DEFAULT_LABEL: Record<Field, string> = {
  building: 'Building',
  unit: 'Flat No',
  floor: 'Floor',
  unitType: 'Type',
  bhk: 'BHK',
  carpetAreaSqft: 'Carpet',
  builtUpAreaSqft: 'Built-up',
  superBuiltUpAreaSqft: 'Super',
  undividedSharePct: 'Share %',
  isBillable: 'Billable',
  possessionDate: 'Possession Date',
  notes: 'Notes',
};

/** Header synonyms (section 8.15), already normalised: lower case without spaces, `_`, `.` and `-`. */
const SYNONYMS: Record<Field, string[]> = {
  building: ['building', 'tower', 'wing', 'block', 'भवन'],
  unit: ['flat', 'flatno', 'flatnumber', 'unit', 'unitno', 'unitnumber', 'doorno', 'फ्लैट'],
  floor: ['floor', 'floorno', 'मंजिल'],
  unitType: ['type', 'unittype'],
  bhk: ['bhk', 'configuration'],
  carpetAreaSqft: ['carpet', 'carpetarea', 'carpetareasqft'],
  builtUpAreaSqft: ['builtup', 'builtuparea', 'builtupareasqft'],
  superBuiltUpAreaSqft: [
    'super',
    'superarea',
    'saleablearea',
    'superbuiltup',
    'superbuiltuparea',
    'superbuiltupareasqft',
  ],
  undividedSharePct: ['share%', 'share', 'sharepct', 'undividedshare', 'undividedsharepct'],
  isBillable: ['billable', 'isbillable'],
  possessionDate: ['possessiondate', 'possession'],
  notes: ['notes', 'note', 'remarks'],
};
const SYNONYM_FIELD = new Map<string, Field>(
  FIELDS.flatMap(f => SYNONYMS[f].map(s => [s, f] as [string, Field])),
);
const normaliseHeader = (h: string): string => h.toLowerCase().replace(/[\s_.-]/g, '');

/** Stored form of a row: the cells by field, only for the columns the file has. */
export interface StoredRow {
  row: number;
  cells: Partial<Record<Field, Cell>>;
}
export interface MappedSheet {
  /** The header text of each recognised column. */
  columns: Partial<Record<Field, string>>;
  rows: StoredRow[];
}

/** Maps the header row to fields. Missing `unit` column or a column named twice is `422 IMPORT_FILE_INVALID`. */
export function mapSheet(sheet: ParsedSheet): MappedSheet {
  const index = new Map<Field, number>();
  const columns: Partial<Record<Field, string>> = {};
  sheet.headers.forEach((h, i) => {
    if (!h) return;
    const f = SYNONYM_FIELD.get(normaliseHeader(h));
    if (!f) return;
    if (index.has(f)) throw importFileInvalid(`The column "${h}" is given twice (${columns[f]} and ${h})`);
    index.set(f, i);
    columns[f] = h;
  });
  if (!index.has('unit'))
    throw importFileInvalid('The file needs a flat number column (Flat No, Flat, Unit or Door No)');
  const rows = sheet.rows.map(r => {
    const cells: Partial<Record<Field, Cell>> = {};
    for (const [f, i] of index) cells[f] = r.cells[i] ?? '';
    return { row: r.row, cells };
  });
  return { columns, rows };
}

// ------------------------------------------------------------------ cell parsers
class RowError extends Error {
  constructor(
    readonly field: Field,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const fail = (field: Field, code: string, message: string): never => {
  throw new RowError(field, code, message);
};

const DECIMAL_RE = /^\d+(\.\d+)?$/;
function parseDecimal(
  field: Field,
  text: string,
  maxDecimals: number,
  min: number,
  max: number,
  label: string,
): string {
  const t = text.trim();
  if (!DECIMAL_RE.test(t) || (t.split('.')[1]?.length ?? 0) > maxDecimals)
    return fail(field, 'INVALID_NUMBER', `${label} must be a number with at most ${maxDecimals} decimals`);
  const n = Number(t);
  if (n < min || n > max) return fail(field, 'OUT_OF_RANGE', `${label} must be between ${min} and ${max}`);
  return t;
}

function parseFloorCell(text: string, ground: string, basementPrefix: string): number {
  const t = text.trim();
  const lower = t.toLowerCase();
  let n: number | null = null;
  if (/^[+-]?\d+(\.0+)?$/.test(t)) n = Math.trunc(Number(t));
  else if (['g', 'ground', 'ground floor', ground.toLowerCase()].includes(lower)) n = 0;
  else {
    const b = new RegExp(
      `^(?:b|basement\\s*|${basementPrefix.toLowerCase().replace(/[^a-z0-9]/g, '')})(\\d+)$`,
    ).exec(lower);
    if (b) n = -Number(b[1]);
  }
  if (n === null)
    return fail('floor', 'INVALID_NUMBER', 'Floor must be a number, G for ground or B1 for a basement');
  if (n < -5 || n > 200) return fail('floor', 'OUT_OF_RANGE', 'Floor must be between -5 and 200');
  return n;
}

const TYPE_MAP: Record<string, UnitType> = {
  FLAT: 'FLAT',
  SHOP: 'SHOP',
  OFFICE: 'OFFICE',
  PARKING: 'PARKING_ONLY',
  PARKING_ONLY: 'PARKING_ONLY',
};
function parseType(text: string): UnitType {
  const t =
    TYPE_MAP[
      text
        .trim()
        .toUpperCase()
        .replace(/[\s-]+/g, '_')
    ];
  if (!t || !(UNIT_TYPES as readonly string[]).includes(t))
    return fail('unitType', 'INVALID_ENUM', 'Type must be Flat, Shop, Office or Parking');
  return t;
}

function parseBhk(text: string): Bhk {
  const t = text.trim().toUpperCase().replace(/\s+/g, '');
  if ((BHK_VALUES as readonly string[]).includes(t)) return t as Bhk;
  const m = /^(\d)(?:\.(0|5))?(BHK)?(\+)?$/.exec(t);
  if (m) {
    const n = Number(m[1]);
    const half = m[2] === '5';
    if (n >= 5 && (m[4] || (n === 5 && !half))) return '5BHK_PLUS';
    const v = `${n}${half ? '_5' : ''}BHK`;
    if ((BHK_VALUES as readonly string[]).includes(v)) return v as Bhk;
  }
  if (t === '1RK') return '1RK';
  return fail('bhk', 'INVALID_ENUM', 'BHK must be Studio, 1RK, 1, 1.5, 2, 2.5, 3, 3.5, 4 or 5+');
}

function parseBool(text: string): boolean {
  const t = text.trim().toUpperCase();
  if (['Y', 'YES', 'TRUE', '1'].includes(t)) return true;
  if (['N', 'NO', 'FALSE', '0'].includes(t)) return false;
  return fail('isBillable', 'INVALID_ENUM', 'Billable must be Y or N');
}

function validYmd(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}
function parseDate(cell: Cell): string {
  if (typeof cell !== 'string') return cell.date;
  const t = cell.trim();
  let r: string | null = null;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) r = validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
  else if ((m = /^(\d{2})[-/](\d{2})[-/](\d{4})$/.exec(t)))
    r = validYmd(Number(m[3]), Number(m[2]), Number(m[1]));
  return r ?? fail('possessionDate', 'INVALID_DATE', 'Use YYYY-MM-DD, DD-MM-YYYY or DD/MM/YYYY');
}

// ------------------------------------------------------------------ plan
export interface UnitValues {
  floor: number;
  unitType: UnitType;
  bhk: Bhk | null;
  carpetAreaSqft: string | null;
  builtUpAreaSqft: string | null;
  superBuiltUpAreaSqft: string | null;
  undividedSharePct: string | null;
  isBillable: boolean;
  possessionDate: string | null;
  notes: string | null;
}
export interface RowIssue {
  column: string;
  value: string;
  code: string;
  message: string;
}
export interface PlannedRow {
  row: number;
  action: RowAction;
  issue?: RowIssue;
  buildingCode: string;
  unitNumber: string;
  /** Existing building, or null for a building the commit creates. */
  buildingId: number | null;
  create?: UnitValues;
  /** UPDATE: the locked unit, the values to set and the values they replace. */
  update?: { unit: Unit; set: Partial<UnitValues>; before: Partial<UnitValues> };
}
export interface ImportCounts {
  create: number;
  update: number;
  unchanged: number;
  error: number;
}
export interface Plan {
  rows: PlannedRow[];
  counts: ImportCounts;
  /** Buildings to create, with the floor span of their CREATE rows. */
  newBuildings: Map<string, { minFloor: number; maxFloor: number }>;
  /** Row numbers refused because the plan limit ran out (carried to the commit). */
  limitRows: number[];
}

export interface PlanInput {
  societyId: number;
  mode: ImportMode;
  createMissingBuildings: boolean;
  sheet: MappedSheet;
  /** Commit transaction: buildings and units are read with locks. */
  t?: Transaction;
  /** Commit: rows the dry run refused for the limit stay refused (the real limit is enforced by `consumeLimit`). */
  carryLimitRows?: ReadonlySet<number>;
}

const DECIMAL_KEYS = new Set<string>([
  'carpetAreaSqft',
  'builtUpAreaSqft',
  'superBuiltUpAreaSqft',
  'undividedSharePct',
]);
const toBp = (v: string | null | undefined): number => Math.round(Number(v ?? 0) * 10_000);
const sameDecimal = (a: string | null, b: string | null): boolean =>
  a === null || b === null ? a === b : Number(a) === Number(b);
const showCell = (c: Cell | undefined): string => {
  const t = c === undefined ? '' : typeof c === 'string' ? c.trim() : c.date;
  return t.length > 100 ? `${t.slice(0, 100)}...` : t;
};

const fiveYearsAhead = (): string => {
  const today = istDate(now());
  return `${Number(today.slice(0, 4)) + 5}${today.slice(4)}`;
};

export async function planImport(input: PlanInput): Promise<Plan> {
  const { societyId, mode, createMissingBuildings, sheet, t } = input;
  const labels = await floorLabelSettings(societyId);
  const buildings = await Building.findAll({
    where: { societyId },
    order: [['id', 'ASC']],
    transaction: t,
    ...(t ? { lock: t.LOCK.UPDATE } : {}),
  });
  const byCode = new Map(buildings.map(b => [b.code, b]));
  const withWings = new Set(
    buildings.filter(b => b.parentBuildingId !== null && b.status === 'ACTIVE').map(b => b.parentBuildingId!),
  );

  // pass 1: identity of every row (building code, unit number)
  const colName = (f: Field): string => sheet.columns[f] ?? DEFAULT_LABEL[f];
  const hasBuildingColumn = 'building' in sheet.columns;
  const textOf = (r: StoredRow, f: Field): string => {
    const c = r.cells[f];
    return c === undefined ? '' : typeof c === 'string' ? c.trim() : c.date;
  };
  const isDateCell = (r: StoredRow, f: Field): boolean => typeof r.cells[f] === 'object';
  const identity = (r: StoredRow): { code: string; unit: string } => {
    if (isDateCell(r, 'unit'))
      return fail('unit', 'INVALID_DATE', 'The flat number looks like a date. Format the column as text.');
    let unit = textOf(r, 'unit').toUpperCase();
    if (!unit) return fail('unit', 'REQUIRED', 'The flat number is required');
    let code = '';
    if (hasBuildingColumn) {
      if (isDateCell(r, 'building'))
        return fail('building', 'INVALID_DATE', 'The building looks like a date. Format the column as text.');
      code = textOf(r, 'building').toUpperCase();
    }
    if (!code) {
      const i = unit.indexOf('-');
      if (i < 1 || i === unit.length - 1)
        return fail(
          'building',
          'REQUIRED',
          'The building is required: add a Building column or write the flat as A-101',
        );
      code = unit.slice(0, i);
      unit = unit.slice(i + 1);
    }
    if (!UNIT_NUMBER_RE.test(unit))
      return fail('unit', 'OUT_OF_RANGE', 'Use 1 to 20 letters, digits, / or - for the flat number');
    return { code, unit };
  };
  const ids = sheet.rows.map((r): { ok?: { code: string; unit: string }; err?: RowError } => {
    try {
      return { ok: identity(r) };
    } catch (err) {
      if (err instanceof RowError) return { err };
      throw err;
    }
  });

  // existing active units of the referenced buildings
  const buildingIds = new Set<number>();
  const unitNumbers = new Set<string>();
  for (const x of ids)
    if (x.ok) {
      const b = byCode.get(x.ok.code);
      if (b) {
        buildingIds.add(b.id!);
        unitNumbers.add(x.ok.unit);
      }
    }
  const existingRows = buildingIds.size
    ? await Unit.findAll({
        where: {
          societyId,
          status: 'ACTIVE',
          buildingId: { [Op.in]: [...buildingIds] },
          unitNumber: { [Op.in]: [...unitNumbers] },
        },
        order: [['id', 'ASC']],
        transaction: t,
        ...(t ? { lock: t.LOCK.UPDATE } : {}),
      })
    : [];
  const existing = new Map(existingRows.map(u => [`${u.buildingId}|${u.unitNumber}`, u]));

  const shareRows = await sequelize.query<{ total: string | null }>(
    `SELECT SUM(undividedSharePct) AS total FROM units WHERE societyId = :societyId AND status = 'ACTIVE'${t ? ' FOR SHARE' : ''}`,
    { replacements: { societyId }, type: QueryTypes.SELECT, transaction: t },
  );
  let shareBp = toBp(shareRows[0]?.total);

  const usage = await entitlements.getUsage(societyId, FLATS_LIMIT);
  let remaining = usage.limit === null ? Infinity : Math.max(0, usage.limit - usage.used);
  const carry = input.carryLimitRows;

  const seen = new Map<string, number>();
  const out: PlannedRow[] = [];
  const limitRows: number[] = [];
  const today5 = fiveYearsAhead();

  /** Plans one row; the first problem is thrown as a `RowError`. */
  const planRow = (
    r: StoredRow,
    idn: { ok?: { code: string; unit: string }; err?: RowError },
    base: { row: number; buildingCode: string; unitNumber: string },
  ): PlannedRow => {
    if (idn.err) throw idn.err;
    const { code, unit } = idn.ok!;
    const key = `${code}|${unit}`;
    const first = seen.get(key);
    if (first !== undefined)
      return fail('unit', 'DUPLICATE_IN_FILE', `Same as row ${first} in building ${code}`);
    seen.set(key, r.row);

    const b = byCode.get(code);
    if (!b) {
      if (!createMissingBuildings)
        return fail('building', 'UNKNOWN_BUILDING', `Building ${code} does not exist`);
      if (!/^[A-Z0-9]{1,6}$/.test(code))
        return fail('building', 'UNKNOWN_BUILDING', 'A building code has 1 to 6 letters or digits');
    } else if (b.status !== 'ACTIVE') {
      return fail('building', 'BUILDING_ARCHIVED', `Building ${code} is archived`);
    } else if (withWings.has(b.id!)) {
      return fail('building', 'BUILDING_STRUCTURE_CONFLICT', `Building ${code} has wings; use the wing code`);
    }
    const buildingId = b?.id ?? null;
    const ex = b ? existing.get(`${b.id}|${unit}`) : undefined;
    if (ex && mode === 'CREATE_ONLY')
      return fail('unit', 'UNIT_EXISTS', `Unit ${unit} already exists in building ${code}`);

    // cells
    const given = (f: Field): boolean => f in r.cells && textOf(r, f) !== '';
    const numeric = (
      f: Field,
      maxDec: number,
      min: number,
      max: number,
      label: string,
    ): string | undefined => {
      if (!given(f)) return undefined;
      if (isDateCell(r, f))
        return fail(f, 'INVALID_DATE', `${label} looks like a date. Format the column as a number.`);
      return parseDecimal(f, textOf(r, f), maxDec, min, max, label);
    };
    const set: Partial<UnitValues> = {};
    if (given('floor')) {
      if (isDateCell(r, 'floor'))
        fail('floor', 'INVALID_DATE', 'Floor looks like a date. Format the column as a number.');
      set.floor = parseFloorCell(textOf(r, 'floor'), labels.ground, labels.basementPrefix);
    }
    if (given('unitType')) set.unitType = parseType(textOf(r, 'unitType'));
    if (given('bhk')) set.bhk = parseBhk(textOf(r, 'bhk'));
    const carpet = numeric('carpetAreaSqft', 3, 1, 100000, 'Carpet area');
    if (carpet !== undefined) set.carpetAreaSqft = carpet;
    const built = numeric('builtUpAreaSqft', 3, 1, 100000, 'Built-up area');
    if (built !== undefined) set.builtUpAreaSqft = built;
    const sup = numeric('superBuiltUpAreaSqft', 3, 1, 100000, 'Super built-up area');
    if (sup !== undefined) set.superBuiltUpAreaSqft = sup;
    const share = numeric('undividedSharePct', 4, 0.0001, 100, 'Share');
    if (share !== undefined) set.undividedSharePct = share;
    if (given('isBillable')) set.isBillable = parseBool(textOf(r, 'isBillable'));
    if (given('possessionDate')) {
      set.possessionDate = parseDate(r.cells.possessionDate!);
      if (set.possessionDate > today5)
        fail('possessionDate', 'INVALID_DATE', 'The possession date is more than 5 years away');
    }
    if (given('notes')) {
      const n = textOf(r, 'notes');
      if (n.length > 500) fail('notes', 'OUT_OF_RANGE', 'Notes can have at most 500 characters');
      set.notes = n;
    }

    if (!ex && set.floor === undefined)
      return fail('floor', 'REQUIRED', 'The floor is required for a new unit');
    const floor = set.floor ?? ex!.floor;
    if (b && !inFloorRange(b, floor))
      return fail(
        'floor',
        'FLOOR_OUT_OF_RANGE',
        `Building ${code} runs from floor ${-b.basements} to ${b.floorsAboveGround}`,
      );

    // the values the unit would have
    const unitType = set.unitType ?? ex?.unitType ?? 'FLAT';
    const merged: UnitValues = {
      floor,
      unitType,
      bhk: ex?.bhk ?? null,
      carpetAreaSqft: ex?.carpetAreaSqft ?? null,
      builtUpAreaSqft: ex?.builtUpAreaSqft ?? null,
      superBuiltUpAreaSqft: ex?.superBuiltUpAreaSqft ?? null,
      undividedSharePct: ex?.undividedSharePct ?? null,
      isBillable: ex ? Boolean(ex.isBillable) : defaultBillable(unitType),
      possessionDate: ex?.possessionDate ?? null,
      notes: ex?.notes ?? null,
      ...set,
    };
    if (merged.bhk !== null && merged.unitType !== 'FLAT')
      return fail('bhk', 'INVALID_ENUM', 'BHK is only for flats');
    const num = (v: string | null): number | null => (v === null ? null : Number(v));
    const [c, bu, su] = [
      num(merged.carpetAreaSqft),
      num(merged.builtUpAreaSqft),
      num(merged.superBuiltUpAreaSqft),
    ];
    if ((c !== null && bu !== null && c > bu) || (bu !== null && su !== null && bu > su))
      return fail(
        'carpetAreaSqft',
        'AREA_ORDER_INVALID',
        'Carpet area cannot be above built-up, nor built-up above super built-up',
      );

    let update: PlannedRow['update'];
    if (ex) {
      const changed = (Object.keys(set) as (keyof UnitValues)[]).filter(k => {
        const nv = (set[k] ?? null) as unknown;
        const ov = (ex[k as keyof Unit] ?? null) as unknown;
        if (k === 'isBillable') return Boolean(ov) !== nv;
        if (DECIMAL_KEYS.has(k)) return !sameDecimal(ov as string | null, nv as string | null);
        return ov !== nv;
      });
      if (!changed.length) return { ...base, action: 'UNCHANGED', buildingId };
      const onlyChanged: Record<string, unknown> = {};
      const before: Record<string, unknown> = {};
      for (const k of changed) {
        onlyChanged[k] = set[k];
        before[k] = k === 'isBillable' ? Boolean(ex[k]) : (ex[k as keyof Unit] ?? null);
      }
      update = { unit: ex, set: onlyChanged as Partial<UnitValues>, before: before as Partial<UnitValues> };
    }

    // share total and plan limit are running checks in file order, so they come last
    const nextBp = shareBp - toBp(ex?.undividedSharePct) + toBp(merged.undividedSharePct);
    if (set.undividedSharePct !== undefined && nextBp > 1_000_000)
      fail('undividedSharePct', 'SHARE_TOTAL_EXCEEDS_100', 'The shares of all units would pass 100%');
    if (isCountable(merged.unitType) && (!ex || !isCountable(ex.unitType))) {
      if (carry ? carry.has(r.row) : remaining <= 0) {
        limitRows.push(r.row);
        fail('unit', 'LIMIT_EXCEEDED', 'The flat limit of the plan is reached');
      }
      remaining -= 1;
    }
    shareBp = nextBp;
    return update
      ? { ...base, action: 'UPDATE', buildingId, update }
      : { ...base, action: 'CREATE', buildingId, create: merged };
  };

  sheet.rows.forEach((r, idx) => {
    const idn = ids[idx]!;
    const base = { row: r.row, buildingCode: idn.ok?.code ?? '', unitNumber: idn.ok?.unit ?? '' };
    try {
      out.push(planRow(r, idn, base));
    } catch (err) {
      if (!(err instanceof RowError)) throw err;
      out.push(errorRow(base, r, colName, err));
    }
  });

  const counts: ImportCounts = { create: 0, update: 0, unchanged: 0, error: 0 };
  const newBuildings = new Map<string, { minFloor: number; maxFloor: number }>();
  for (const p of out) {
    counts[p.action.toLowerCase() as keyof ImportCounts] += 1;
    if (p.action === 'CREATE' && p.buildingId === null) {
      const f = p.create!.floor;
      const cur = newBuildings.get(p.buildingCode);
      newBuildings.set(p.buildingCode, {
        minFloor: Math.min(cur?.minFloor ?? f, f),
        maxFloor: Math.max(cur?.maxFloor ?? f, f),
      });
    }
  }
  return { rows: out, counts, newBuildings, limitRows };
}

function errorRow(
  base: { row: number; buildingCode: string; unitNumber: string },
  r: StoredRow,
  colName: (f: Field) => string,
  e: RowError,
): PlannedRow {
  return {
    ...base,
    action: 'ERROR',
    buildingId: null,
    issue: { column: colName(e.field), value: showCell(r.cells[e.field]), code: e.code, message: e.message },
  };
}
