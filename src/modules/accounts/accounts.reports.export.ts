import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { Society, sequelize } from '../../models';
import { enqueue } from '../../lib/queue';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { NotFoundError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { societyPorts } from '../societies/societies.ports';
import { systemCtx } from '../../types/context';
import { QueryTypes } from 'sequelize';
import { toCsv } from '../society-setup/society-setup.csv';
import { PAGE_H, PAGE_W, PdfDoc, textWidth } from '../platform-billing/platform-billing.pdf-writer';
import { AUDIT, ENTITY, ERR, JOBS, NOTIFY, ACCOUNTS_QUEUE } from './accounts.constants';
import { accountsPorts } from './accounts.ports';
import { loadChart } from './accounts.reports.queries';
import { runReport, resolvePeriod, type AnyReport, type RunQuery } from './accounts.reports.service';
import { n } from './accounts.shared';

/** 8.19 exports (66): the request validates, audits and queues; the job `accounts:report-export` renders and stores the file. */
export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

export const MAX_EXPORT_ROWS = 50_000;
const DEADLINE_MS = 60_000;

export const rupees = (paise: number): string => {
  const abs = Math.abs(paise);
  return `${paise < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

export interface ExportJobData extends Record<string, unknown> {
  societyId: number;
  ids: number[];
  requestId: string;
  userId: number;
  exportJobId: string;
  report: AnyReport;
  params: RunQuery;
  format: ExportFormat;
}

export async function requestExport(
  ctx: Ctx,
  societyId: number,
  input: { report: AnyReport; params: RunQuery; format: ExportFormat },
): Promise<{ exportJobId: string }> {
  // fail now, not in the job: a bad period or an unknown account
  await resolvePeriod(societyId, input.report, input.params);
  if (input.report === 'general-ledger') {
    if (!input.params.ledgerAccountId)
      throw new ValidationError([
        { field: 'params.ledgerAccountId', message: 'Required for the general ledger' },
      ]);
    const chart = await loadChart(societyId, { deadlineMs: DEADLINE_MS });
    if (!chart.has(input.params.ledgerAccountId))
      throw new NotFoundError(ERR.ledgerAccountNotFound, 'Ledger account not found');
  }
  const exportJobId = randomUUID();
  await sequelize.transaction(t =>
    audit(
      ctx,
      {
        action: AUDIT.reportExported,
        entityType: ENTITY.societyBalance,
        entityId: societyId,
        societyId,
        after: { report: input.report, params: input.params, format: input.format, exportJobId },
      },
      t,
    ),
  );
  const data: ExportJobData = {
    societyId,
    ids: [],
    requestId: ctx.requestId,
    userId: ctx.user!.id,
    exportJobId,
    report: input.report,
    params: input.params,
    format: input.format,
  };
  await enqueue(ACCOUNTS_QUEUE, JOBS.reportExport, data, { jobId: `report-export:${exportJobId}` });
  return { exportJobId };
}

// ------------------------------------------------------------------ tables
interface Table {
  title: string;
  subtitle: string;
  header: string[];
  /** Columns right-aligned (money). */
  numeric: number[];
  rows: (string | number)[][];
  footer: (string | number)[][];
}

const TITLES: Record<AnyReport, string> = {
  'trial-balance': 'Trial balance',
  'income-expenditure': 'Income and expenditure',
  'balance-sheet': 'Balance sheet',
  'general-ledger': 'General ledger',
  'receipts-payments': 'Receipts and payments',
  'gst-summary': 'GST summary',
  'tds-register': 'TDS register',
};
export const titleOf = (r: AnyReport): string => TITLES[r];

const R = rupees;
type Row = Record<string, unknown>;

export async function buildTable(societyId: number, report: AnyReport, q: RunQuery): Promise<Table> {
  const opts = { deadlineMs: DEADLINE_MS };
  const first = await runReport(societyId, report, { ...q, page: 1, limit: 1000 }, opts);
  const b = first.body as Record<string, unknown> & { rows: Row[] };
  const period = b.asOf ? `As of ${b.asOf}` : `${b.from} to ${b.to}`;
  const t = (
    header: string[],
    numeric: number[],
    rows: (string | number)[][],
    footer: (string | number)[][],
  ): Table => ({
    title: TITLES[report],
    subtitle: `${period} (FY ${b.financialYear ?? ''})`.replace(' (FY )', ''),
    header,
    numeric,
    rows,
    footer,
  });
  const tot = (b.totals ?? {}) as Record<string, number>;
  switch (report) {
    case 'trial-balance':
      return t(
        ['Code', 'Account', 'Debit', 'Credit'],
        [2, 3],
        b.rows.map(r => [String(r.code), String(r.name), R(n(r.debitPaise)), R(n(r.creditPaise))]),
        [['', 'Total', R(tot.debitPaise ?? 0), R(tot.creditPaise ?? 0)]],
      );
    case 'income-expenditure':
      return t(
        ['Section', 'Code', 'Account', 'Amount'],
        [3],
        b.rows.map(r => [String(r.section), String(r.code), String(r.name), R(n(r.amountPaise))]),
        [
          ['', '', 'Total income', R(tot.incomePaise ?? 0)],
          ['', '', 'Total expenditure', R(tot.expenditurePaise ?? 0)],
          ['', '', 'Surplus (deficit)', R(tot.surplusPaise ?? 0)],
        ],
      );
    case 'balance-sheet':
      return t(
        ['Section', 'Code', 'Account', 'Amount'],
        [3],
        b.rows.map(r => [String(r.section), String(r.code ?? ''), String(r.name), R(n(r.amountPaise))]),
        [
          ['', '', 'Total assets', R(tot.assetsPaise ?? 0)],
          ['', '', 'Liabilities, funds and surplus', R(tot.liabilitiesAndFundsPaise ?? 0)],
        ],
      );
    case 'receipts-payments':
      return t(
        ['Side', 'Code', 'Account', 'Amount'],
        [3],
        [
          ['OPENING', '', 'Cash and bank at the start', R(tot.openingPaise ?? 0)],
          ...b.rows.map(r => [String(r.side), String(r.code), String(r.name), R(n(r.amountPaise))]),
        ],
        [
          ['', '', 'Total receipts', R(tot.receiptsPaise ?? 0)],
          ['', '', 'Total payments', R(tot.paymentsPaise ?? 0)],
          ['', '', 'Cash and bank at the end', R(tot.closingPaise ?? 0)],
        ],
      );
    case 'gst-summary':
      return t(
        ['Month', 'Output CGST', 'Output SGST', 'Output IGST', 'Output total', 'Input credit', 'Net payable'],
        [1, 2, 3, 4, 5, 6],
        b.rows.map(r => [
          String(r.month),
          R(n(r.outputCgstPaise)),
          R(n(r.outputSgstPaise)),
          R(n(r.outputIgstPaise)),
          R(n(r.outputTotalPaise)),
          R(n(r.inputCreditPaise)),
          R(n(r.netPayablePaise)),
        ]),
        [
          [
            'Total',
            R(tot.outputCgstPaise ?? 0),
            R(tot.outputSgstPaise ?? 0),
            R(tot.outputIgstPaise ?? 0),
            R(tot.outputTotalPaise ?? 0),
            R(tot.inputCreditPaise ?? 0),
            R(tot.netPayablePaise ?? 0),
          ],
        ],
      );
    case 'tds-register':
      return t(
        ['Date', 'Voucher', 'Payee', 'Section', 'Gross', 'Deducted', 'Deposited', 'Challan'],
        [4, 5, 6],
        b.rows.map(r => [
          String(r.date),
          String(r.voucherNo ?? ''),
          String(r.payee ?? ''),
          String(r.tdsSection ?? ''),
          r.grossAmountPaise === null ? '' : R(n(r.grossAmountPaise)),
          R(n(r.deductedPaise)),
          R(n(r.depositedPaise)),
          String(r.challanNo ?? ''),
        ]),
        [['Total', '', '', '', '', R(tot.deductedPaise ?? 0), R(tot.depositedPaise ?? 0), '']],
      );
    case 'general-ledger': {
      const rows: Row[] = [...b.rows];
      const total = n((b.pagination as { total: number }).total);
      for (let page = 2; rows.length < total && rows.length < MAX_EXPORT_ROWS; page++) {
        const more = await runReport(societyId, report, { ...q, page, limit: 1000 }, opts);
        if (!more.body.rows.length) break;
        rows.push(...more.body.rows);
      }
      const acc = b.ledgerAccount as { code: string; name: string };
      const g = t(
        ['Date', 'Voucher', 'Type', 'Narration', 'Debit', 'Credit', 'Balance'],
        [4, 5, 6],
        [
          ['', '', '', 'Opening balance', '', '', R(n(b.openingPaise))],
          ...rows.map(r => [
            String(r.date),
            String(r.voucherNo ?? ''),
            String(r.voucherType),
            String(r.narration),
            R(n(r.debitPaise)),
            R(n(r.creditPaise)),
            R(n(r.runningPaise)),
          ]),
        ],
        [['', '', '', 'Total', R(tot.debitPaise ?? 0), R(tot.creditPaise ?? 0), R(n(b.closingPaise))]],
      );
      g.title = `General ledger: ${acc.code} ${acc.name}`;
      return g;
    }
  }
}

// ------------------------------------------------------------------ files
export function renderCsv(t: Table): Buffer {
  return toCsv(t.header, [...t.rows, ...t.footer]);
}

export async function renderXlsx(t: Table, society: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(t.title.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
  ws.addRow([society]).font = { bold: true, size: 13 };
  ws.addRow([t.title]).font = { bold: true };
  ws.addRow([t.subtitle]);
  ws.addRow([]);
  ws.addRow(t.header).font = { bold: true };
  for (const r of [...t.rows, ...t.footer])
    ws.addRow(r.map((v, i) => (t.numeric.includes(i) && v !== '' ? Number(v) : v)));
  for (const i of t.numeric) ws.getColumn(i + 1).numFmt = '#,##0.00';
  ws.columns.forEach(c => (c.width = 18));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** `1234567.5` shown as `₹12,34,567.50` (Indian grouping; the PDF writer prints the rupee sign as "Rs."). */
export function inrPdf(v: string | number): string {
  const s = String(v);
  const m = /^(-?)(\d+)\.(\d{2})$/.exec(s);
  if (!m) return s;
  const whole = m[2]!;
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${m[1]}₹${rest ? `${rest},` : ''}${last3}.${m[3]}`;
}

/** Breaks `text` into lines that fit `maxWidth` at `size` (on spaces; a long word is cut). */
function wrapText(text: string, size: number, bold: boolean, maxWidth: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const word of text.split(' ')) {
    const next = cur ? `${cur} ${word}` : word;
    if (textWidth(next, size, bold) <= maxWidth) cur = next;
    else {
      if (cur) lines.push(cur);
      let w = word;
      while (textWidth(w, size, bold) > maxWidth && w.length > 1) {
        let k = w.length - 1;
        while (k > 1 && textWidth(w.slice(0, k), size, bold) > maxWidth) k--;
        lines.push(w.slice(0, k));
        w = w.slice(k);
      }
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

export function renderPdf(t: Table, society: string): Buffer {
  const d = new PdfDoc();
  const L = 36;
  const Rt = PAGE_W - 36;
  // column widths follow the longest content (capped), amounts always get room for ₹ and grouping
  const weight = t.header.map((h, i) => {
    const longest = Math.max(
      String(h).length,
      ...[...t.rows, ...t.footer].map(r =>
        t.numeric.includes(i) ? inrPdf(r[i] ?? '').length : String(r[i] ?? '').length,
      ),
    );
    return Math.min(Math.max(longest, 6), t.numeric.includes(i) ? 16 : 40);
  });
  const total = weight.reduce((a, b) => a + b, 0);
  const widths = weight.map(w => ((Rt - L) * w) / total);
  const xs = widths.map((_, i) => L + widths.slice(0, i).reduce((a, b) => a + b, 0));
  const head = (y0: number) => {
    d.text(L, y0, society, { size: 12, bold: true });
    d.text(L, y0 + 15, t.title, { size: 10.5, bold: true });
    d.text(L, y0 + 28, t.subtitle, { size: 8.5 });
    let y = y0 + 46;
    t.header.forEach((h, i) =>
      t.numeric.includes(i)
        ? d.text(xs[i]! + widths[i]! - 4, y, h, {
            size: 8,
            bold: true,
            align: 'right',
            maxWidth: widths[i]! - 6,
          })
        : d.text(xs[i]! + 2, y, h, { size: 8, bold: true, maxWidth: widths[i]! - 6 }),
    );
    y += 4;
    d.line(L, y, Rt, y, 0.8);
    return y + 12;
  };
  let y = head(48);
  const put = (r: (string | number)[], bold: boolean) => {
    const cells = r.map((v, i) =>
      t.numeric.includes(i) ? [inrPdf(v)] : wrapText(String(v), 8, bold, widths[i]! - 6),
    );
    const height = Math.max(...cells.map(c => c.length)) * 10 + 2;
    if (y + height > PAGE_H - 50) {
      d.addPage();
      y = head(48);
    }
    cells.forEach((lines, i) =>
      lines.forEach((line, k) =>
        t.numeric.includes(i)
          ? d.text(xs[i]! + widths[i]! - 4, y + k * 10, line, { size: 8, bold, align: 'right' })
          : d.text(xs[i]! + 2, y + k * 10, line, { size: 8, bold }),
      ),
    );
    y += height;
  };
  for (const r of t.rows) put(r, false);
  d.line(L, y - 8, Rt, y - 8, 0.5);
  for (const r of t.footer) put(r, true);
  return d.build(t.title);
}

const CONTENT_TYPE: Record<ExportFormat, string> = {
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

/** The job body: renders and stores the file, then tells the requester. Re-delivery stores a second copy at worst. */
export async function runExportJob(d: ExportJobData): Promise<{ fileId: number }> {
  try {
    return await renderAndStore(d);
  } catch (err) {
    await recordOutcome(d, AUDIT.reportExportFailed, {}).catch(() => undefined);
    throw err;
  }
}

/** The status route reads these rows (spec 8.19 gives no job table): one audit row per outcome, keyed by the export job id. */
async function recordOutcome(
  d: ExportJobData,
  action: string,
  after: Record<string, unknown>,
): Promise<void> {
  await audit(systemCtx(d.requestId), {
    action,
    entityType: ENTITY.societyBalance,
    entityId: d.exportJobId,
    societyId: d.societyId,
    after: { exportJobId: d.exportJobId, ...after },
    actor: { userId: d.userId, name: 'Export job', role: 'system' },
  });
}

async function renderAndStore(d: ExportJobData): Promise<{ fileId: number }> {
  const society = await Society.findByPk(d.societyId, { attributes: ['name'] });
  const table = await buildTable(d.societyId, d.report, d.params);
  const content =
    d.format === 'csv'
      ? renderCsv(table)
      : d.format === 'xlsx'
        ? await renderXlsx(table, society?.name ?? '')
        : renderPdf(table, society?.name ?? '');
  const stored = await societyPorts().files.storeSystemFile({
    societyId: d.societyId,
    purpose: 'EXPORT_FILE',
    content,
    name: `${d.report}-${now().toISOString().slice(0, 10)}.${d.format}`,
    contentType: CONTENT_TYPE[d.format],
    ownerUserId: d.userId,
  });
  await recordOutcome(d, AUDIT.reportExportReady, { fileId: stored.fileId, format: d.format });
  await accountsPorts().notifications.send(NOTIFY.exportReady, [d.userId], {
    exportJobId: d.exportJobId,
    report: d.report,
    reportTitle: TITLES[d.report],
    format: d.format,
    fileId: stored.fileId,
    link: '/accounts/reports',
  });
  return { fileId: stored.fileId };
}

export interface ExportStatus {
  exportJobId: string;
  status: 'PREPARING' | 'READY' | 'FAILED';
  report: AnyReport | null;
  format: ExportFormat | null;
  downloadUrl: string | null;
  expiresAt: string | null;
}

/** `GET /accounts/exports/:id`: only the user who asked sees the job; a link is issued fresh (5 minutes) on every READY answer. */
export async function exportStatus(
  societyId: number,
  userId: number,
  exportJobId: string,
): Promise<ExportStatus> {
  const rows = await sequelize.query<{ action: string; actorUserId: number | null; after: unknown }>(
    `SELECT action, actorUserId, after FROM audit_logs
      WHERE societyId = :societyId AND action IN (:actions)
        AND JSON_UNQUOTE(JSON_EXTRACT(after, '$.exportJobId')) = :exportJobId
      ORDER BY id DESC`,
    {
      replacements: {
        societyId,
        exportJobId,
        actions: [AUDIT.reportExported, AUDIT.reportExportReady, AUDIT.reportExportFailed],
      },
      type: QueryTypes.SELECT,
    },
  );
  const asObj = (v: unknown): Record<string, unknown> =>
    typeof v === 'string'
      ? (JSON.parse(v) as Record<string, unknown>)
      : ((v ?? {}) as Record<string, unknown>);
  const requested = rows.find(r => r.action === AUDIT.reportExported);
  if (!requested || Number(requested.actorUserId) !== userId)
    throw new NotFoundError('EXPORT_NOT_FOUND', 'Export not found');
  const req = asObj(requested.after);
  const base = {
    exportJobId,
    report: (req.report as AnyReport) ?? null,
    format: (req.format as ExportFormat) ?? null,
    downloadUrl: null,
    expiresAt: null,
  };
  const ready = rows.find(r => r.action === AUDIT.reportExportReady);
  if (ready) {
    const link = await societyPorts().files.downloadUrl(Number(asObj(ready.after).fileId), 5);
    return { ...base, status: 'READY', downloadUrl: link.url, expiresAt: link.expiresAt.toISOString() };
  }
  if (rows.some(r => r.action === AUDIT.reportExportFailed)) return { ...base, status: 'FAILED' };
  return { ...base, status: 'PREPARING' };
}
