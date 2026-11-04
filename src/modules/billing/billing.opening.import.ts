import { Op } from 'sequelize';
import { OpeningBalance, Society, Unit, sequelize } from '../../models';
import { istDate, now } from '../../lib/clock';
import { rupeesToPaise } from '../../lib/money';
import { audit } from '../../utils/audit';
import { AppError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { residents } from '../residents/residents.public';
import { toCsv } from '../society-setup/society-setup.csv';
import { parseImportFile, type ParsedSheet } from '../society-setup/society-setup.imports.parse';
import { setupPorts } from '../society-setup/society-setup.ports';
import { AUDIT } from './billing.constants';
import { LEDGER_ENTITY, OPENING_HEADER, type OpeningTotals } from './billing.ledger.types';
import { assertAsOfDate, openingTotals } from './billing.opening.shared';

/**
 * Opening balance import (section 8.23, BR-11-65): reads the CSV (or XLSX) the caller uploaded, checks every row and
 * replaces the society's earlier `DRAFT` and `INVALID` rows with the new ones. With `dryRun` nothing is written: the
 * caller sees what an import would produce. The module 08 file store placeholder (`getImportFile`) is the file source
 * until module 01's files service exists.
 */
const AMOUNT_RE = /^\d{1,9}(\.\d{1,2})?$/;
const AMOUNT_MSG = 'Amount must be digits with up to 2 decimals';
const ERROR_PREVIEW = 50;

export interface ImportRowError {
  rowNo: number;
  unit: string;
  message: string;
}
export interface ImportResult {
  draft: number;
  invalid: number;
  totals: OpeningTotals;
  dryRun: boolean;
  /** The first 50 invalid rows; the full list is `GET /billing/opening-balances?status=INVALID`. */
  errors: ImportRowError[];
}

interface PlannedRow {
  rowNo: number;
  label: string;
  unitId: number | null;
  principalPaise: number;
  interestPaise: number;
  advancePaise: number;
  error: string | null;
}

const fileInvalid = (message: string) =>
  new UnprocessableError('IMPORT_FILE_INVALID', message, [{ field: 'fileId', message }]);

/** A blank template: the header only (the importer ignores the BOM). */
export const openingTemplate = (): Buffer => toCsv([...OPENING_HEADER], []);

async function loadSheet(societyId: number, userId: number, fileId: number): Promise<ParsedSheet> {
  let content: Buffer;
  try {
    content = (await setupPorts().files.getImportFile(societyId, userId, fileId)).content;
  } catch (err) {
    // the files service answers FILE_NOT_LINKABLE for a file of another purpose: for this import that is an invalid file
    if (err instanceof AppError && err.code === 'FILE_NOT_LINKABLE')
      throw fileInvalid('The file is not an import file. Upload the sheet again.');
    throw err;
  }
  const sheet = await parseImportFile(content);
  const header = sheet.headers.map(h => h.toLowerCase());
  if (header.length !== OPENING_HEADER.length || OPENING_HEADER.some((h, i) => header[i] !== h))
    throw fileInvalid(`The header must be: ${OPENING_HEADER.join(',')}`);
  return sheet;
}

const textOf = (c: unknown): string => (typeof c === 'string' ? c.trim() : c === undefined ? '' : '?');

/** `null` for an empty amount cell (= 0), `NaN` for a bad one. */
function paiseOf(c: unknown): number {
  const s = textOf(c);
  if (s === '') return 0;
  return AMOUNT_RE.test(s) ? rupeesToPaise(s) : Number.NaN;
}

async function planRows(societyId: number, asOfDate: string, sheet: ParsedSheet): Promise<PlannedRow[]> {
  const units = await Unit.findAll({ where: { societyId, status: 'ACTIVE' }, attributes: ['id', 'label'] });
  const byLabel = new Map(units.map(u => [u.label.toLowerCase(), Number(u.id)]));
  const posted = new Set(
    (
      await OpeningBalance.findAll({
        where: { societyId, status: 'POSTED' },
        attributes: ['unitId'],
      })
    ).map(r => Number(r.unitId)),
  );
  const seen = new Set<number>();
  const today = istDate(now());
  const out: PlannedRow[] = [];
  for (const r of sheet.rows) {
    const label = textOf(r.cells[0]);
    const p = paiseOf(r.cells[1]);
    const i = paiseOf(r.cells[2]);
    const a = paiseOf(r.cells[3]);
    const row: PlannedRow = {
      rowNo: r.row,
      label,
      unitId: null,
      principalPaise: Number.isNaN(p) ? 0 : p,
      interestPaise: Number.isNaN(i) ? 0 : i,
      advancePaise: Number.isNaN(a) ? 0 : a,
      error: null,
    };
    const unitId = byLabel.get(label.toLowerCase());
    if (unitId) row.unitId = unitId;
    if (!label) row.error = 'Flat is required';
    else if (!unitId) row.error = 'Unknown flat';
    else if (Number.isNaN(p) || Number.isNaN(i) || Number.isNaN(a)) row.error = AMOUNT_MSG;
    else if (seen.has(unitId)) row.error = 'Duplicate flat in file';
    else if (posted.has(unitId)) row.error = 'Already posted; reverse first';
    else if (p + i > 0 && a > 0) row.error = 'A flat has arrears or an advance, not both';
    else if (p + i + a === 0) row.error = 'Enter arrears or an advance';
    else if (p + i > 0 && `OB/${label}`.length > 30)
      row.error = 'Flat label is too long for an arrears invoice number';
    else if (
      p + i > 0 &&
      !((await residents.billToFor(unitId, asOfDate)) ?? (await residents.billToFor(unitId, today)))
    )
      row.error = 'No owner or tenant on record to bill; add the resident first';
    // only a row that will be DRAFT takes the flat: a bad first row does not make the corrected second one a duplicate
    if (unitId && !row.error) seen.add(unitId);
    out.push(row);
  }
  return out;
}

const countsOf = (rows: PlannedRow[]) => {
  const ok = rows.filter(r => !r.error);
  return {
    draft: ok.length,
    invalid: rows.length - ok.length,
    draftArrearsPaise: ok.reduce((s, r) => s + r.principalPaise + r.interestPaise, 0),
    draftAdvancePaise: ok.reduce((s, r) => s + r.advancePaise, 0),
  };
};

/** Imports (or, with `dryRun`, checks) the file. `400` body shape and the 422 codes are in section 8.23. */
export async function importOpening(
  ctx: Ctx,
  societyId: number,
  input: { fileId: number; asOfDate: string; dryRun: boolean },
): Promise<ImportResult> {
  const userId = ctx.user!.id;
  await assertAsOfDate(societyId, input.asOfDate);
  const sheet = await loadSheet(societyId, userId, input.fileId);
  const preview = (rows: PlannedRow[]): ImportRowError[] =>
    rows
      .filter(r => r.error)
      .slice(0, ERROR_PREVIEW)
      .map(r => ({ rowNo: r.rowNo, unit: r.label, message: r.error! }));
  if (input.dryRun) {
    const rows = await planRows(societyId, input.asOfDate, sheet);
    const c = countsOf(rows);
    const posted = (await openingTotals(societyId)).postedCount;
    return {
      draft: c.draft,
      invalid: c.invalid,
      totals: {
        draftArrearsPaise: c.draftArrearsPaise,
        draftAdvancePaise: c.draftAdvancePaise,
        invalidCount: c.invalid,
        postedCount: posted,
      },
      dryRun: true,
      errors: preview(rows),
    };
  }
  const result = await sequelize.transaction(async t => {
    // one import at a time per society; the unique `activeKey` would otherwise reject the second one halfway
    await Society.findByPk(societyId, { attributes: ['id'], transaction: t, lock: t.LOCK.UPDATE });
    const rows = await planRows(societyId, input.asOfDate, sheet);
    await OpeningBalance.destroy({
      where: { societyId, status: { [Op.in]: ['DRAFT', 'INVALID'] } },
      transaction: t,
    });
    for (let i = 0; i < rows.length; i += 200)
      await OpeningBalance.bulkCreate(
        rows.slice(i, i + 200).map(r => ({
          societyId,
          unitId: r.unitId,
          unitLabelInput: r.label.slice(0, 30),
          importFileId: input.fileId,
          importRowNo: r.rowNo,
          asOfDate: input.asOfDate,
          arrearsPrincipalPaise: r.error ? 0 : r.principalPaise,
          arrearsInterestPaise: r.error ? 0 : r.interestPaise,
          advancePaise: r.error ? 0 : r.advancePaise,
          status: r.error ? ('INVALID' as const) : ('DRAFT' as const),
          validationError: r.error,
          activeKey: r.error ? null : `OB:${r.unitId}`,
          invoiceId: null,
          postedAt: null,
          postedBy: null,
          reversedAt: null,
          reversedBy: null,
          reverseReason: null,
          createdBy: userId,
          updatedBy: userId,
          version: 1,
        })),
        { transaction: t },
      );
    const c = countsOf(rows);
    await audit(
      ctx,
      {
        action: AUDIT.openingImported,
        entityType: LEDGER_ENTITY.openingImport,
        entityId: input.fileId,
        societyId,
        after: {
          fileId: input.fileId,
          asOfDate: input.asOfDate,
          draft: c.draft,
          invalid: c.invalid,
          draftArrearsPaise: c.draftArrearsPaise,
          draftAdvancePaise: c.draftAdvancePaise,
        },
      },
      t,
    );
    return { rows, c };
  });
  const totals = await openingTotals(societyId);
  return {
    draft: result.c.draft,
    invalid: result.c.invalid,
    totals,
    dryRun: false,
    errors: preview(result.rows),
  };
}
