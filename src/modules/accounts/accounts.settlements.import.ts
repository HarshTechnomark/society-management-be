import { parseImportFile, type Cell } from '../society-setup/society-setup.imports.parse';
import { setupPorts } from '../society-setup/society-setup.ports';
import { UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { ERR } from './accounts.constants';
import { ingestSettlement, type SettlementIngestInput } from './accounts.settlements.service';
import { moneyTx } from '../payments/payments.shared';
import { societyIdOf } from './accounts.shared';

/** A settlement as the report or the JSON body gives it (fee and GST default to the sum of the item columns). */
export interface ReportSettlement {
  gatewaySettlementId: string;
  settlementDate: string;
  utr?: string;
  netPaise: number;
  feePaise?: number;
  feeGstPaise?: number;
  adjustmentPaise?: number;
  items: SettlementIngestInput['items'];
}

const COLS = {
  id: ['settlement_id', 'settlementid'],
  date: ['settlement_date', 'settlementdate', 'date'],
  utr: ['utr'],
  type: ['type'],
  payment: ['payment_id', 'paymentid'],
  refund: ['refund_id', 'refundid'],
  amount: ['amount', 'gross'],
  fee: ['fee'],
  tax: ['tax', 'gst'],
  net: ['net', 'net_amount'],
  adjustment: ['adjustment'],
} as const;

const fail = (row: number, message: string) =>
  new UnprocessableError(ERR.statementParseFailed, `Row ${row}: ${message}`, [
    { field: `row ${row}`, message },
  ]);

const text = (c: Cell | undefined): string =>
  c === undefined ? '' : typeof c === 'string' ? c.trim() : c.date;

/** Rupees with up to two decimals to paise, without floating point arithmetic. */
export function rupeesToPaise(v: string): number | null {
  const m = /^(-?)(\d{1,12})(?:\.(\d{1,2}))?$/.exec(v.replace(/,/g, '').trim());
  if (!m) return null;
  const p = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0') || 0);
  return m[1] ? -p : p;
}

/**
 * CSV or XLSX settlement report: header row then one row per item. Columns (rupees, any order): `settlement_id`, `settlement_date`,
 * `utr`, `type` (payment or refund), `payment_id`, `refund_id`, `amount`, `fee`, `tax`, and on the first row of each settlement `net`
 * and optionally `adjustment`. Rows are grouped by settlement id; fee and GST on fee are the sums of the item columns.
 */
export async function parseSettlementReport(content: Buffer): Promise<ReportSettlement[]> {
  const sheet = await parseImportFile(content);
  const idx = (names: readonly string[]) =>
    sheet.headers.findIndex(h => names.includes(h.toLowerCase().replace(/[\s-]+/g, '_')));
  const col = Object.fromEntries(Object.entries(COLS).map(([k, v]) => [k, idx(v)])) as Record<
    keyof typeof COLS,
    number
  >;
  for (const need of ['id', 'date', 'type', 'payment', 'amount', 'net'] as const)
    if (col[need] < 0)
      throw new UnprocessableError(ERR.statementParseFailed, `The report has no ${COLS[need][0]} column`, [
        { field: 'row 1', message: `Missing column ${COLS[need][0]}` },
      ]);
  const groups = new Map<string, ReportSettlement & { fee: number; tax: number; netSeen: boolean }>();
  for (const r of sheet.rows) {
    const get = (k: keyof typeof COLS) => (col[k] < 0 ? '' : text(r.cells[col[k]]));
    const money = (k: keyof typeof COLS, required: boolean): number => {
      const v = get(k);
      if (!v) {
        if (required) throw fail(r.row, `${COLS[k][0]} is required`);
        return 0;
      }
      const p = rupeesToPaise(v);
      if (p === null) throw fail(r.row, `${COLS[k][0]} is not an amount`);
      return p;
    };
    const sid = get('id');
    if (!sid || sid.length > 60) throw fail(r.row, 'settlement_id is required (at most 60 characters)');
    const date = get('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw fail(r.row, 'settlement_date must be YYYY-MM-DD');
    const type = get('type').toLowerCase();
    if (type !== 'payment' && type !== 'refund') throw fail(r.row, 'type must be payment or refund');
    const pid = get('payment');
    if (!pid) throw fail(r.row, 'payment_id is required');
    const amount = money('amount', true);
    if (amount <= 0) throw fail(r.row, 'amount must be positive');
    let g = groups.get(sid);
    if (!g) {
      g = {
        gatewaySettlementId: sid,
        settlementDate: date,
        utr: get('utr') || undefined,
        netPaise: 0,
        adjustmentPaise: 0,
        items: [],
        fee: 0,
        tax: 0,
        netSeen: false,
      };
      groups.set(sid, g);
    }
    if (!g.utr && get('utr')) g.utr = get('utr');
    if (get('net') && !g.netSeen) {
      g.netPaise = money('net', true);
      g.netSeen = true;
    }
    if (get('adjustment')) g.adjustmentPaise = money('adjustment', false);
    const fee = money('fee', false);
    const tax = money('tax', false);
    g.fee += fee;
    g.tax += tax;
    g.items.push({
      type,
      gatewayPaymentId: pid,
      ...(type === 'refund' && get('refund') ? { gatewayRefundId: get('refund') } : {}),
      amountPaise: amount,
      feePaise: fee,
      taxPaise: tax,
    });
  }
  return [...groups.values()].map(({ fee, tax, netSeen, ...s }) => {
    if (!netSeen) throw fail(0, `settlement ${s.gatewaySettlementId} has no net amount`);
    return { ...s, feePaise: fee, feeGstPaise: tax };
  });
}

export interface ImportResult {
  created: number;
  skipped: number;
  failed: { gatewaySettlementId: string; code: string; message: string }[];
  settlementIds: number[];
}

/** Section 8.15 import: each settlement in its own transaction, so one bad total does not stop the others. */
export async function importSettlements(
  ctx: Ctx,
  input: {
    gatewayProvider: string;
    fileId?: number;
    settlements?: ReportSettlement[];
    skipEnqueue?: boolean;
  },
): Promise<ImportResult> {
  societyIdOf(ctx);
  let list = input.settlements;
  if (!list) {
    const file = await setupPorts().files.getImportFile(ctx.society!.id, ctx.user!.id, input.fileId!);
    list = await parseSettlementReport(file.content);
  }
  const res: ImportResult = { created: 0, skipped: 0, failed: [], settlementIds: [] };
  for (const s of list) {
    const items = s.items;
    try {
      const r = await moneyTx(t =>
        ingestSettlement(
          ctx,
          {
            gatewayProvider: input.gatewayProvider,
            gatewaySettlementId: s.gatewaySettlementId,
            settlementDate: s.settlementDate,
            utr: s.utr,
            netPaise: s.netPaise,
            feePaise: s.feePaise ?? items.reduce((a, i) => a + i.feePaise, 0),
            feeGstPaise: s.feeGstPaise ?? items.reduce((a, i) => a + i.taxPaise, 0),
            adjustmentPaise: s.adjustmentPaise ?? 0,
            items,
            sourceFileId: input.fileId ?? null,
            source: 'REPORT_UPLOAD',
            skipEnqueue: input.skipEnqueue,
          },
          t,
        ),
      );
      res.settlementIds.push(r.settlementId);
      if (r.created) res.created += 1;
      else res.skipped += 1;
    } catch (err) {
      if (err instanceof UnprocessableError)
        res.failed.push({ gatewaySettlementId: s.gatewaySettlementId, code: err.code, message: err.message });
      else throw err;
    }
  }
  return res;
}
