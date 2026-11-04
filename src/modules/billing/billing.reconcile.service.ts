import { QueryTypes } from 'sequelize';
import { Society, sequelize } from '../../models';
import { logger } from '../../lib/logger';
import { isJobAllowed } from '../societies/societies.guard';
import { billingPorts } from './billing.ports';

/**
 * `billing:reconcile` (section 9.1, BR-11-7), read-only: the invoice identity `outstanding = total + debited - credited - paid`,
 * `total = sum of lines`, line credits within the line amount, per flat `unit ledger balance = sum of open invoices - module 12
 * advance`, and gapless numbers per series (invoices per financial year, credit and debit notes per type and year). Mismatches
 * are logged with ids only (no names) and make the job fail with the details so module 07 reports it.
 */
export interface Mismatch {
  kind: 'INVOICE_BALANCE' | 'INVOICE_TOTAL' | 'LINE_CREDIT' | 'LEDGER_BALANCE' | 'NUMBER_GAP';
  ref: string;
  detail: string;
}

const q = <T extends object>(sql: string, societyId: number) =>
  sequelize.query<T>(sql, { replacements: { societyId }, type: QueryTypes.SELECT });

/** Numbers of one series in order; every missing number between the smallest and the largest is a gap. */
export function gapsOf(numbers: number[]): number[] {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) for (let m = sorted[i - 1]! + 1; m < sorted[i]!; m++) gaps.push(m);
  return gaps;
}

export async function reconcileSociety(societyId: number): Promise<Mismatch[]> {
  const out: Mismatch[] = [];
  for (const r of await q<{ id: number }>(
    `SELECT id FROM invoices WHERE societyId = :societyId AND status <> 'CANCELLED'
        AND (outstandingPaise <> totalPaise + debitedPaise - creditedPaise - paidPaise OR outstandingPaise < 0)`,
    societyId,
  ))
    out.push({
      kind: 'INVOICE_BALANCE',
      ref: `invoice ${r.id}`,
      detail: 'outstanding differs from total + debited - credited - paid',
    });
  for (const r of await q<{ id: number }>(
    `SELECT i.id FROM invoices i WHERE i.societyId = :societyId
        AND i.totalPaise <> (SELECT COALESCE(SUM(l.amountPaise), 0) FROM invoice_lines l WHERE l.invoiceId = i.id)`,
    societyId,
  ))
    out.push({
      kind: 'INVOICE_TOTAL',
      ref: `invoice ${r.id}`,
      detail: 'total differs from the sum of its lines',
    });
  for (const r of await q<{ id: number }>(
    `SELECT id FROM invoice_lines WHERE societyId = :societyId AND lineKind <> 'ROUND_OFF'
        AND (creditedPaise < 0 OR creditedPaise > amountPaise)`,
    societyId,
  ))
    out.push({ kind: 'LINE_CREDIT', ref: `line ${r.id}`, detail: 'credited amount outside 0..amount' });
  // ledger against invoices and the module 12 advance
  const open = await q<{ unitId: number; open: string }>(
    `SELECT unitId, SUM(outstandingPaise) AS open FROM invoices WHERE societyId = :societyId AND status <> 'CANCELLED' GROUP BY unitId`,
    societyId,
  );
  const led = await q<{ unitId: number; bal: string }>(
    `SELECT unitId, SUM(debitPaise) - SUM(creditPaise) AS bal FROM unit_ledger_entries WHERE societyId = :societyId GROUP BY unitId`,
    societyId,
  );
  const units = new Set([...open.map(x => Number(x.unitId)), ...led.map(x => Number(x.unitId))]);
  for (const unitId of [...units].sort((a, b) => a - b)) {
    const o = Number(open.find(x => Number(x.unitId) === unitId)?.open ?? 0);
    const l = Number(led.find(x => Number(x.unitId) === unitId)?.bal ?? 0);
    const advance = await billingPorts().payments.advanceBalance(societyId, unitId);
    if (o - advance !== l)
      out.push({
        kind: 'LEDGER_BALANCE',
        ref: `unit ${unitId}`,
        detail: `ledger ${l} but open invoices ${o} - advance ${advance}`,
      });
  }
  // number series
  const series = new Map<string, number[]>();
  for (const r of await q<{ no: string; fy: string }>(
    `SELECT invoiceNo AS no, financialYear AS fy FROM invoices WHERE societyId = :societyId AND invoiceNo NOT LIKE 'OB/%'`,
    societyId,
  ))
    series.set(`INV ${r.fy}`, [...(series.get(`INV ${r.fy}`) ?? []), Number(r.no.split('/').pop())]);
  for (const r of await q<{ no: string; fy: string; t: string }>(
    `SELECT noteNo AS no, financialYear AS fy, noteType AS t FROM billing_notes WHERE societyId = :societyId AND noteNo IS NOT NULL`,
    societyId,
  ))
    series.set(`${r.t} ${r.fy}`, [...(series.get(`${r.t} ${r.fy}`) ?? []), Number(r.no.split('/').pop())]);
  for (const [name, nums] of series) {
    const gaps = gapsOf(nums.filter(Number.isFinite));
    if (gaps.length)
      out.push({ kind: 'NUMBER_GAP', ref: name, detail: `missing ${gaps.slice(0, 10).join(', ')}` });
  }
  return out;
}

/** The job (tag `health`: it also runs for a suspended society). Throws after checking all societies when something differs. */
export async function runReconcileAll(): Promise<Record<number, Mismatch[]>> {
  const all: Record<number, Mismatch[]> = {};
  let count = 0;
  for (const s of await Society.findAll({ attributes: ['id', 'status'], order: [['id', 'ASC']] })) {
    if (!isJobAllowed(s.status, 'health')) continue;
    const m = await reconcileSociety(s.id!);
    if (m.length) {
      all[s.id!] = m;
      count += m.length;
      logger.error({ societyId: s.id, mismatches: m.slice(0, 20) }, 'billing:reconcile found mismatches');
    }
  }
  if (count) {
    const first = Object.entries(all)[0]!;
    throw new Error(
      `billing:reconcile found ${count} mismatches (society ${first[0]}: ${first[1][0]!.kind} ${first[1][0]!.ref})`,
    );
  }
  return all;
}
