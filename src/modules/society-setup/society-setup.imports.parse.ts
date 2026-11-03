import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { UnprocessableError } from '../../utils/errors';

/**
 * Reads the first sheet of an import file (BR-08-33): CSV (UTF-8, comma) or XLSX. The first row is the header, empty rows
 * are skipped, formulas are read as their cached result and never evaluated. A cell Excel turned into a date is kept as
 * `{ date }` so the row rules can tell a date from text.
 */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 5000;
const MAX_COLUMNS = 40;
const MAX_SHEET_ROWS = 200_000;

export type Cell = string | { date: string };
export interface ParsedRow {
  /** Row number in the file (the header is row 1). */
  row: number;
  cells: Cell[];
}
export interface ParsedSheet {
  headers: string[];
  rows: ParsedRow[];
}

export const importFileInvalid = (message: string) =>
  new UnprocessableError('IMPORT_FILE_INVALID', message, [{ field: 'fileId', message }]);
const tooManyRows = () =>
  new UnprocessableError(
    'IMPORT_TOO_MANY_ROWS',
    `The file has more than ${MAX_IMPORT_ROWS} rows. Split it and import in parts.`,
    [{ field: 'fileId', message: `At most ${MAX_IMPORT_ROWS} rows` }],
  );

const isEmptyCell = (c: Cell | undefined): boolean =>
  c === undefined || (typeof c === 'string' && c.trim() === '');

function finish(grid: Cell[][]): ParsedSheet {
  if (!grid.length) throw importFileInvalid('The file is empty');
  const headers = grid[0]!.slice(0, MAX_COLUMNS).map(c => (typeof c === 'string' ? c.trim() : ''));
  if (!headers.some(Boolean)) throw importFileInvalid('The first row must hold the column names');
  const rows: ParsedRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const cells = grid[i]!.slice(0, headers.length);
    if (cells.every(isEmptyCell)) continue;
    if (rows.length >= MAX_IMPORT_ROWS) throw tooManyRows();
    rows.push({ row: i + 1, cells });
  }
  if (!rows.length) throw importFileInvalid('The file has no data rows');
  return { headers, rows };
}

function readCsv(content: Buffer): ParsedSheet {
  let records: string[][];
  try {
    records = parse(content, {
      bom: true,
      relax_column_count: true,
      relax_quotes: true,
      skip_empty_lines: false,
    }) as string[][];
  } catch {
    throw importFileInvalid('The CSV file could not be read. Save it as UTF-8 CSV and try again.');
  }
  return finish(records);
}

const numberText = (n: number): string => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6))));

/** An ExcelJS cell value as a plain cell (cached result for formulas). */
export function cellOf(v: unknown): Cell {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : { date: v.toISOString().slice(0, 10) };
  if (typeof v === 'number') return numberText(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('result' in o) return cellOf(o.result);
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map(r => r.text ?? '').join('');
    if (typeof o.text === 'string') return o.text;
    if (typeof o.error === 'string') return o.error;
  }
  return '';
}

const mergeTouchesHeader = (range: string): boolean => {
  const m = /^[A-Z]+(\d+):[A-Z]+(\d+)$/.exec(range);
  return m ? Number(m[1]) <= 1 && Number(m[2]) >= 1 && range.split(':')[0] !== range.split(':')[1] : false;
};

async function readXlsx(content: Buffer): Promise<ParsedSheet> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(content as unknown as ExcelJS.Buffer);
  } catch {
    throw importFileInvalid('The Excel file could not be read. Save it as .xlsx and try again.');
  }
  const ws = wb.worksheets[0];
  if (!ws) throw importFileInvalid('The workbook has no sheet');
  const merges = (ws.model as unknown as { merges?: string[] }).merges ?? [];
  if (merges.some(mergeTouchesHeader))
    throw importFileInvalid('The header row has merged cells. Unmerge them and try again.');
  const lastRow = Math.min(ws.rowCount, MAX_SHEET_ROWS + 1);
  if (ws.rowCount > MAX_SHEET_ROWS + 1) throw tooManyRows();
  const width = Math.min(Math.max(ws.columnCount, 1), MAX_COLUMNS);
  const grid: Cell[][] = [];
  for (let r = 1; r <= lastRow; r++) {
    const row = ws.getRow(r);
    const cells: Cell[] = [];
    for (let c = 1; c <= width; c++) cells.push(cellOf(row.getCell(c).value));
    grid.push(cells);
  }
  return finish(grid);
}

/** Parses by content: a zip signature means XLSX, anything else is read as CSV. */
export async function parseImportFile(content: Buffer): Promise<ParsedSheet> {
  if (content.length === 0) throw importFileInvalid('The file is empty');
  if (content.length > MAX_IMPORT_BYTES) throw importFileInvalid('The file is larger than 20 MB');
  const isZip = content[0] === 0x50 && content[1] === 0x4b;
  return isZip ? readXlsx(content) : readCsv(content);
}
