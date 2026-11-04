import { QueryTypes } from 'sequelize';
import { Unit, sequelize } from '../../models';
import { istDate, now } from '../../lib/clock';
import { financialYearOf } from '../../utils/numberSequences';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { csvCell } from '../society-setup/society-setup.csv';
import type { LedgerEntryType, LedgerRefType } from './billing.constants';
import { STATEMENT_MAX_DAYS, type StatementDto } from './billing.ledger.types';

/**
 * Statement of account of a flat (section 8.20, BR-11-59): entries ordered by `entryDate`, then `id`; the running balance
 * is a window `SUM` over that order; the opening balance of the range is the sum of the entries before `from`.
 */
/** UTF-8 byte order mark so Excel reads the file as UTF-8. */
const BOM = String.fromCharCode(0xfeff);
const DAY_MS = 86_400_000;
const dayNo = (ymd: string): number => Date.parse(`${ymd}T00:00:00.000Z`) / DAY_MS;

/** Default range: the current financial year up to today (society-local date). */
export function defaultRange(): { from: string; to: string } {
  const to = istDate(now());
  return { from: `${financialYearOf(to).slice(0, 4)}-04-01`, to };
}

/** `from` ≤ `to` and at most 1,100 days (both days counted); else `400 VALIDATION_FAILED`. */
export function checkRange(from: string, to: string): void {
  if (from > to) throw new ValidationError([{ field: 'from', message: 'From must not be after to' }]);
  if (dayNo(to) - dayNo(from) + 1 > STATEMENT_MAX_DAYS)
    throw new ValidationError([{ field: 'to', message: `The range is at most ${STATEMENT_MAX_DAYS} days` }]);
}

interface Row {
  id: number | string;
  entryDate: string | Date;
  entryType: LedgerEntryType;
  refType: LedgerRefType;
  refId: number | string;
  narration: string;
  debitPaise: number | string;
  creditPaise: number | string;
  runningPaise: number | string;
}

const ymdOf = (v: string | Date): string =>
  typeof v === 'string' ? v.slice(0, 10) : v.toISOString().slice(0, 10);

/** `404 UNIT_NOT_FOUND` for an unknown, other society's or archived unit. */
export async function getStatement(
  societyId: number,
  unitId: number,
  range: { from?: string; to?: string },
): Promise<StatementDto> {
  const d = defaultRange();
  const from = range.from ?? d.from;
  const to = range.to ?? d.to;
  checkRange(from, to);
  const unit = await Unit.findOne({
    where: { id: unitId, societyId, status: 'ACTIVE' },
    attributes: ['id', 'label'],
  });
  if (!unit) throw new NotFoundError('UNIT_NOT_FOUND', 'Unit not found');
  const [before] = await sequelize.query<{ balance: string | number | null }>(
    `SELECT COALESCE(SUM(debitPaise), 0) - COALESCE(SUM(creditPaise), 0) AS balance
       FROM unit_ledger_entries WHERE societyId = :societyId AND unitId = :unitId AND entryDate < :from`,
    { replacements: { societyId, unitId, from }, type: QueryTypes.SELECT },
  );
  const opening = Number(before?.balance ?? 0);
  const rows = await sequelize.query<Row>(
    `SELECT id, entryDate, entryType, refType, refId, narration, debitPaise, creditPaise,
            SUM(debitPaise - creditPaise) OVER (ORDER BY entryDate, id ROWS UNBOUNDED PRECEDING) AS runningPaise
       FROM unit_ledger_entries
      WHERE societyId = :societyId AND unitId = :unitId AND entryDate >= :from AND entryDate <= :to
      ORDER BY entryDate, id`,
    { replacements: { societyId, unitId, from, to }, type: QueryTypes.SELECT },
  );
  const entries = rows.map(r => ({
    id: Number(r.id),
    entryDate: ymdOf(r.entryDate),
    entryType: r.entryType,
    refType: r.refType,
    refId: Number(r.refId),
    narration: r.narration,
    debitPaise: Number(r.debitPaise),
    creditPaise: Number(r.creditPaise),
    balancePaise: opening + Number(r.runningPaise),
  }));
  return {
    unit: { id: Number(unit.id), label: unit.label },
    from,
    to,
    openingBalancePaise: opening,
    entries,
    closingBalancePaise: entries.length ? entries[entries.length - 1]!.balancePaise : opening,
  };
}

/** Whole paise as `-1234.50`; built from integers so no float rounding and no spreadsheet formula (a pure number). */
export const rupeeText = (paise: number): string => {
  const abs = Math.abs(paise);
  return `${paise < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

/**
 * The statement as CSV: `Date,Type,Reference,Narration,Debit,Credit,Balance` with an opening and a closing row. Text cells go
 * through the module 08 injection-safe helper (a cell starting with `= + - @` gets a leading `'`); amounts are plain numbers.
 */
export function statementCsv(s: StatementDto): Buffer {
  const line = (cells: string[]) => cells.join(',');
  const text = (v: string) => csvCell(v);
  const lines = [
    line(['Date', 'Type', 'Reference', 'Narration', 'Debit', 'Credit', 'Balance']),
    line([s.from, '', '', text('Opening balance'), '', '', rupeeText(s.openingBalancePaise)]),
    ...s.entries.map(e =>
      line([
        e.entryDate,
        text(e.entryType),
        text(`${e.refType} ${e.refId}`),
        text(e.narration),
        e.debitPaise ? rupeeText(e.debitPaise) : '',
        e.creditPaise ? rupeeText(e.creditPaise) : '',
        rupeeText(e.balancePaise),
      ]),
    ),
    line([s.to, '', '', text('Closing balance'), '', '', rupeeText(s.closingBalancePaise)]),
  ];
  return Buffer.from(`${BOM}${lines.join('\r\n')}\r\n`, 'utf8');
}
