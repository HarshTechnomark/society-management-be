/**
 * CSV writing for module 08 files (unit export and the import report). BR-08-37: a text cell that starts with `=`, `+`,
 * `-`, `@`, a tab or a carriage return is prefixed with a single quote so a spreadsheet never runs it as a formula.
 * Numbers are written as they are (a floor of -1 is a number, not a formula).
 */
const DANGEROUS_START = /^[=+\-@\t\r]/;

export const escapeCsvInjection = (text: string): string => (DANGEROUS_START.test(text) ? `'${text}` : text);

export type CsvValue = string | number | boolean | null | undefined;

/** One cell: injection-escaped when text, quoted when it holds a comma, quote or line break. */
export function csvCell(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'Y' : 'N';
  const text = escapeCsvInjection(v);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const csvLine = (cells: CsvValue[]): string => cells.map(csvCell).join(',');

/** UTF-8 byte order mark so that Excel reads Hindi text correctly; the importer skips it. */
const BOM = '﻿';
export const toCsv = (header: string[], rows: CsvValue[][]): Buffer =>
  Buffer.from(`${BOM}${[csvLine(header), ...rows.map(csvLine)].join('\r\n')}\r\n`, 'utf8');
