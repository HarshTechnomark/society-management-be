import { QueryTypes, type Transaction } from 'sequelize';
import { sequelize } from '../models';
import { SERIES_PREFIX, type NumberSeries } from '../models/number-sequence.model';
import { istDate, now } from '../lib/clock';

/**
 * BR-01-12: financial year `YYYY-YY` starting 1 April. A `Date` is read as its Asia/Kolkata calendar date; a
 * `YYYY-MM-DD` string is taken as is. 15 March 2027 → 2026-27; 1 April 2027 → 2027-28.
 */
export function financialYearOf(date: Date | string = now()): string {
  const ymd = typeof date === 'string' ? date : istDate(date);
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(ymd);
  if (!m) throw new Error(`Invalid date for financial year: ${ymd}`);
  const year = Number(m[1]);
  const start = Number(m[2]) >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

export interface NextNumberOptions {
  /** Document date (back-dated vouchers); today in Asia/Kolkata when omitted. */
  date?: Date | string;
  /** Used only when the financial year's row is first created (BR-01-11). */
  prefix?: string;
  transaction: Transaction;
}

/**
 * BR-01-11: the next gapless document number, e.g. `PLT/2026-27/000184`. Must run inside the caller's transaction:
 * the sequence row stays locked until it commits, and a rollback gives the number back.
 *
 * The row is created (or, when it exists, X-locked) by `INSERT … ON DUPLICATE KEY UPDATE` instead of a locking
 * SELECT on a missing row, because concurrent gap locks followed by inserts deadlock in InnoDB. Platform sequences use
 * `societyId = 0`.
 */
export async function nextNumber(
  societyId: number,
  series: NumberSeries,
  opts: NextNumberOptions,
): Promise<string> {
  const t = opts.transaction;
  if (!t) throw new Error('nextNumber must be called inside a transaction');
  const fy = financialYearOf(opts.date ?? now());
  // DATETIME(3) in UTC, as Sequelize writes model timestamps (raw replacements would use the process time zone)
  const at = now().toISOString().slice(0, 23).replace('T', ' ');
  await sequelize.query(
    `INSERT INTO number_sequences (societyId, series, financialYear, prefix, nextValue, padding, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, 1, 6, ?, ?) ON DUPLICATE KEY UPDATE id = id`,
    {
      replacements: [societyId, series, fy, opts.prefix ?? SERIES_PREFIX[series], at, at],
      transaction: t,
    },
  );
  const [row] = await sequelize.query<{ id: number; nextValue: number; prefix: string; padding: number }>(
    `SELECT id, nextValue, prefix, padding FROM number_sequences
     WHERE societyId = ? AND series = ? AND financialYear = ? FOR UPDATE`,
    { replacements: [societyId, series, fy], type: QueryTypes.SELECT, transaction: t },
  );
  if (!row) throw new Error(`number sequence ${series} ${fy} missing`);
  await sequelize.query('UPDATE number_sequences SET nextValue = nextValue + 1, updatedAt = ? WHERE id = ?', {
    replacements: [at, row.id],
    transaction: t,
  });
  return `${row.prefix}/${fy}/${String(row.nextValue).padStart(row.padding, '0')}`;
}
