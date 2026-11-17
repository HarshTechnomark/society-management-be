import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { UnprocessableError } from '../../utils/errors';
import { cellOf, type Cell } from '../society-setup/society-setup.imports.parse';
import { ERR } from './accounts.constants';

/**
 * Bank statement parser (section 8.16, BR-13-40). One synonym-driven reader serves every `statementFormat` (GENERIC_CSV, HDFC_CSV,
 * ICICI_CSV, SBI_XLSX, AXIS_CSV, KOTAK_CSV, GENERIC_XLSX): it finds the header row (bank files start with a preamble), maps the
 * columns by their usual names, and reads rows below it. The file type is decided by content (a zip signature is XLSX), XLSX is read
 * with `exceljs` (already a project dependency). Amounts are converted to paise by string arithmetic, never through a float.
 */
export const MAX_STATEMENT_ROWS = 5000;
export const MAX_STATEMENT_BYTES = 20 * 1024 * 1024;
export const MAX_GRID_ROWS = 200_000;

export interface ParsedLine {
  lineNo: number;
  txnDate: string;
  valueDate: string | null;
  description: string;
  reference: string | null;
  chequeNumber: string | null;
  debitPaise: number;
  creditPaise: number;
  runningBalancePaise: number | null;
  dedupeHash: string;
}
export interface ParsedStatement {
  fileFormat: 'CSV' | 'XLSX';
  lines: ParsedLine[];
}

export class StatementParseError extends UnprocessableError {
  constructor(
    message: string,
    public readonly row?: number,
  ) {
    super(ERR.statementParseFailed, row ? `Row ${row}: ${message}` : message);
  }
}

const REF_RE = /(?:UTR|REF|NEFT|IMPS|RTGS)(?![A-Z])[\s:/-]*([A-Z0-9]{8,22})/i;
const CHEQUE_RE = /^\d{6,10}$/;
const CHEQUE_IN_TEXT_RE = /(?:CHQ|CHEQUE|CHK)[\s.:/#-]*(?:NO)?[\s.:/#-]*(\d{6,10})/i;
const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  oct: '10',
  nov: '11',
  dec: '12',
};

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const SYNONYMS: Record<
  'date' | 'value' | 'desc' | 'ref' | 'debit' | 'credit' | 'balance' | 'cheque',
  string[]
> = {
  date: ['date', 'txndate', 'transactiondate', 'trandate', 'postingdate', 'transdate'],
  value: ['valuedate', 'valuedt', 'valdate'],
  desc: [
    'description',
    'narration',
    'particulars',
    'transactiondescription',
    'remarks',
    'details',
    'transactionremarks',
  ],
  ref: [
    'reference',
    'refno',
    'referenceno',
    'chqrefno',
    'chqrefnumber',
    'refnochequeno',
    'chequerefno',
    'chqno',
    'utr',
    'utrno',
    'chqrefno',
    'chequeno',
    'chequenumber',
    'chqnumber',
  ],
  debit: [
    'debit',
    'debitamount',
    'withdrawal',
    'withdrawalamt',
    'withdrawalamount',
    'dr',
    'debits',
    'withdrawals',
  ],
  credit: ['credit', 'creditamount', 'deposit', 'depositamt', 'depositamount', 'cr', 'credits', 'deposits'],
  balance: ['balance', 'closingbalance', 'runningbalance', 'bal', 'availablebalance'],
  cheque: ['chequeno', 'chequenumber', 'chqno', 'chqnumber', 'chq'],
};

type Field = keyof typeof SYNONYMS;
const text = (c: Cell | undefined): string => (typeof c === 'string' ? c.trim() : c ? c.date : '');

function readGrid(content: Buffer): Promise<{ grid: Cell[][]; format: 'CSV' | 'XLSX' }> {
  const isZip = content[0] === 0x50 && content[1] === 0x4b;
  if (!isZip) {
    let records: string[][];
    try {
      records = parse(content, {
        bom: true,
        relax_column_count: true,
        relax_quotes: true,
        skip_empty_lines: false,
      }) as string[][];
    } catch {
      throw new StatementParseError('The CSV file could not be read. Save it as UTF-8 CSV and try again.');
    }
    return Promise.resolve({ grid: records, format: 'CSV' });
  }
  return readXlsx(content);
}

async function readXlsx(content: Buffer): Promise<{ grid: Cell[][]; format: 'XLSX' }> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(content as unknown as ExcelJS.Buffer);
  } catch {
    throw new StatementParseError('The Excel file could not be read. Save it as .xlsx and try again.');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new StatementParseError('The workbook has no sheet');
  if (ws.rowCount > MAX_GRID_ROWS) throw new StatementParseError('The sheet has too many rows');
  const width = Math.min(Math.max(ws.columnCount, 1), 40);
  const grid: Cell[][] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells: Cell[] = [];
    for (let c = 1; c <= width; c++) cells.push(cellOf(row.getCell(c).value));
    grid.push(cells);
  }
  return { grid, format: 'XLSX' };
}

/** Maps a header row to column indexes; `null` unless a date, a description and at least one amount column are present. */
function mapHeader(row: Cell[]): Partial<Record<Field, number>> | null {
  const names = row.map(c => norm(text(c)));
  const map: Partial<Record<Field, number>> = {};
  const take = (f: Field, taken: Set<number>) => {
    const i = names.findIndex((nm, ix) => nm !== '' && !taken.has(ix) && SYNONYMS[f].includes(nm));
    if (i >= 0) {
      map[f] = i;
      taken.add(i);
    }
  };
  const taken = new Set<number>();
  // value date first so that `date` does not pick it
  for (const f of ['value', 'date', 'desc', 'debit', 'credit', 'balance'] as Field[]) take(f, taken);
  // the reference column and the dedicated cheque column are tried separately (HDFC `Chq./Ref.No.` is one column)
  const refIdx = names.findIndex(
    (nm, ix) => !taken.has(ix) && SYNONYMS.ref.includes(nm) && nm !== 'chqno' && nm !== 'chequeno',
  );
  if (refIdx >= 0) {
    map.ref = refIdx;
    taken.add(refIdx);
  }
  const chqIdx = names.findIndex((nm, ix) => !taken.has(ix) && SYNONYMS.cheque.includes(nm));
  if (chqIdx >= 0) map.cheque = chqIdx;
  if (map.date === undefined || map.desc === undefined) return null;
  if (map.debit === undefined && map.credit === undefined) return null;
  return map;
}

/** `DD/MM/YYYY`, `DD-MM-YYYY`, `DD-MMM-YYYY` (also `DD MMM YYYY`) and `YYYY-MM-DD`, two-digit years as 20YY. */
export function parseStatementDate(raw: Cell | undefined): string | null {
  if (raw && typeof raw !== 'string') return raw.date;
  const s = (raw ?? '').trim();
  let y: string;
  let m: string;
  let d: string;
  let x = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec(s);
  if (x) [, y, m, d] = x as unknown as string[];
  else if ((x = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(s))) {
    d = x[1]!.padStart(2, '0');
    m = x[2]!.padStart(2, '0');
    y = x[3]!.length === 2 ? `20${x[3]}` : x[3]!;
  } else if ((x = /^(\d{1,2})[ /-]([A-Za-z]{3})[A-Za-z]*[ /-](\d{2}|\d{4})$/.exec(s))) {
    d = x[1]!.padStart(2, '0');
    const mm = MONTHS[x[2]!.toLowerCase()];
    if (!mm) return null;
    m = mm;
    y = x[3]!.length === 2 ? `20${x[3]}` : x[3]!;
  } else return null;
  const dt = new Date(`${y}-${m}-${d}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== `${y}-${m}-${d}`) return null;
  return `${y}-${m}-${d}`;
}

/** An amount with Indian grouping and up to 2 decimals as paise; `0` for an empty cell, `NaN` when invalid. A trailing `Cr`/`Dr` is allowed on balances. */
export function parseStatementAmount(raw: Cell | undefined): number {
  const s = text(raw)
    .replace(/[₹\s]/g, '')
    .replace(/^(?:rs\.?|inr)/i, '');
  if (s === '') return 0;
  const m = /^(-)?(\d{1,3}(?:,\d{2,3})*|\d+)(?:\.(\d{1,2}))?(cr|dr)?$/i.exec(s);
  if (!m) return Number.NaN;
  const digits = m[2]!.replace(/,/g, '');
  if (digits.length > 13) return Number.NaN;
  const paise = Number(digits) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  const negative = Boolean(m[1]) !== (m[4]?.toLowerCase() === 'dr');
  return negative ? -paise : paise;
}

/** The reference a line carries: the reference column when it is a single token, else the keyword reference in the text (UTR, NEFT, IMPS, RTGS, REF). */
export function extractReference(refCell: string, description: string): string | null {
  if (/^[A-Za-z0-9]{8,22}$/.test(refCell) && !CHEQUE_RE.test(refCell)) return refCell.toUpperCase();
  const hit = REF_RE.exec(refCell) ?? REF_RE.exec(description);
  return hit ? hit[1]!.toUpperCase().slice(0, 60) : null;
}

export function extractCheque(refCell: string, chequeCell: string, description: string): string | null {
  for (const c of [chequeCell, refCell]) if (CHEQUE_RE.test(c)) return c;
  return CHEQUE_IN_TEXT_RE.exec(description)?.[1] ?? null;
}

/** BR-13-40 hash: date, amount, direction, reference and description, plus the occurrence number inside the file so two genuine identical rows both import. */
export function dedupeHashOf(
  l: Pick<ParsedLine, 'txnDate' | 'debitPaise' | 'creditPaise' | 'reference' | 'description'>,
  occurrence: number,
): string {
  const dir = l.creditPaise > 0 ? 'C' : 'D';
  const amount = l.creditPaise > 0 ? l.creditPaise : l.debitPaise;
  const desc = l.description.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha256')
    .update([l.txnDate, amount, dir, l.reference ?? '', desc, occurrence].join('|'))
    .digest('hex');
}

export async function parseStatementFile(content: Buffer): Promise<ParsedStatement> {
  if (content.length === 0) throw new StatementParseError('The file is empty');
  if (content.length > MAX_STATEMENT_BYTES) throw new StatementParseError('The file is larger than 20 MB');
  const { grid, format } = await readGrid(content);
  let headerAt = -1;
  let map: Partial<Record<Field, number>> | null = null;
  for (let i = 0; i < Math.min(grid.length, 40); i++) {
    map = mapHeader(grid[i]!);
    if (map) {
      headerAt = i;
      break;
    }
  }
  if (!map || headerAt < 0)
    throw new StatementParseError(
      'No header row found. Expected columns for date, description and debit/credit.',
    );
  const m = map;
  const lines: ParsedLine[] = [];
  const seen = new Map<string, number>();
  for (let i = headerAt + 1; i < grid.length; i++) {
    const row = grid[i]!;
    const rowNo = i + 1;
    if (row.every(c => text(c) === '')) continue;
    const cell = (f: Field): Cell | undefined => (m[f] === undefined ? undefined : row[m[f]!]);
    const dateRaw = cell('date');
    if (text(dateRaw) === '') continue; // footer or total rows carry no date
    if (lines.length >= MAX_STATEMENT_ROWS)
      throw new StatementParseError(`The file has more than ${MAX_STATEMENT_ROWS} data rows`, rowNo);
    const txnDate = parseStatementDate(dateRaw);
    if (!txnDate) throw new StatementParseError(`Date "${text(dateRaw)}" is not a valid date`, rowNo);
    const valueRaw = cell('value');
    const valueDate = text(valueRaw) === '' ? null : parseStatementDate(valueRaw);
    const debit = parseStatementAmount(cell('debit'));
    const credit = parseStatementAmount(cell('credit'));
    if (Number.isNaN(debit) || Number.isNaN(credit) || debit < 0 || credit < 0)
      throw new StatementParseError('The debit or credit amount is not valid', rowNo);
    if (debit > 0 === credit > 0)
      throw new StatementParseError('A row needs exactly one of debit or credit', rowNo);
    const description = text(cell('desc')).replace(/\s+/g, ' ').slice(0, 300);
    if (!description) throw new StatementParseError('The description is empty', rowNo);
    const balance = parseStatementAmount(cell('balance'));
    if (Number.isNaN(balance)) throw new StatementParseError('The balance is not valid', rowNo);
    const refCell = text(cell('ref'));
    const chqCell = text(cell('cheque'));
    const base = {
      txnDate,
      debitPaise: debit,
      creditPaise: credit,
      reference: extractReference(refCell, description),
      description,
    };
    const key = dedupeHashOf(base, 0);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    lines.push({
      lineNo: rowNo,
      ...base,
      valueDate,
      chequeNumber: extractCheque(refCell, chqCell, description),
      runningBalancePaise: text(cell('balance')) === '' ? null : balance,
      dedupeHash: dedupeHashOf(base, occurrence),
    });
  }
  if (!lines.length) throw new StatementParseError('The file has no data rows');
  return { fileFormat: format, lines };
}
