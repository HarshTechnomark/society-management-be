import { Op } from 'sequelize';
import { Notice } from '../../models';
import { istDayEnd, istDayStart, n } from './communication.notices.shared';

/** 8.38 `reach.forNotices` and `noticeReports.reachByNotice` (module 24): read-only, no audit. */
const REPORTED = ['PUBLISHED', 'EXPIRED', 'RECALLED', 'ARCHIVED'];

/** `read × 100 ÷ total` to one decimal, half up, in integer arithmetic ("0.0" when total is 0). */
export function pct(read: number, total: number): string {
  if (!total) return '0.0';
  const tenths = Math.floor((read * 2000 + total) / (2 * total));
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}
const tenthsOf = (p: string): number => Math.round(parseFloat(p) * 10);
/** Mean of values given in tenths of a percent, rounded half up, shown with one decimal. */
const meanTenths = (xs: number[]): string => {
  if (!xs.length) return '0.0';
  const sum = xs.reduce((a, b) => a + b, 0);
  const t = Math.floor((sum * 2 + xs.length) / (2 * xs.length));
  return `${Math.floor(t / 10)}.${t % 10}`;
};

const rangeWhere = (societyId: number, from: string, to: string) => ({
  societyId,
  status: { [Op.in]: REPORTED },
  publishedAt: { [Op.gte]: istDayStart(from), [Op.lt]: istDayEnd(to) },
});

function totalsOf(rows: Notice[]) {
  const reads = rows.map(r => tenthsOf(pct(n(r.readCount), n(r.recipientCount))));
  const acks = rows.filter(r => r.requiresAck).map(r => tenthsOf(pct(n(r.ackCount), n(r.recipientCount))));
  return { notices: rows.length, avgReadPct: meanTenths(reads), avgAckPct: meanTenths(acks) };
}

export async function forNotices(societyId: number, from: string, to: string) {
  return totalsOf(await Notice.findAll({ where: rangeWhere(societyId, from, to) }));
}

export async function reachByNotice(
  societyId: number,
  from: string,
  to: string,
  opts: {
    deadlineMs: number;
    replica?: boolean;
    sortBy?: 'publishedAt' | 'readPct';
    sortOrder?: 'asc' | 'desc';
    page?: number;
    limit?: number;
  },
) {
  const work = (async () => {
    const all = await Notice.findAll({ where: rangeWhere(societyId, from, to) });
    const dir = opts.sortOrder === 'asc' ? 1 : -1;
    const keyed = all.map(r => ({
      r,
      read: n(r.recipientCount) ? (n(r.readCount) * 1000) / n(r.recipientCount) : 0,
    }));
    keyed.sort((a, b) =>
      opts.sortBy === 'readPct'
        ? dir * (a.read - b.read) || n(a.r.id) - n(b.r.id)
        : dir * (a.r.publishedAt!.getTime() - b.r.publishedAt!.getTime()) || n(a.r.id) - n(b.r.id),
    );
    const page = opts.page ?? 1;
    const limit = opts.limit ?? 20;
    const rows = keyed.slice((page - 1) * limit, page * limit).map(({ r }) => ({
      noticeId: n(r.id),
      title: r.title,
      publishedAt: r.publishedAt!.toISOString(),
      audienceSize: n(r.recipientCount),
      readPct: pct(n(r.readCount), n(r.recipientCount)),
      ackPct: r.requiresAck ? pct(n(r.ackCount), n(r.recipientCount)) : null,
    }));
    return { rows, total: all.length, totals: totalsOf(all) };
  })();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_res, rej) => {
    timer = setTimeout(
      () => rej(new Error('noticeReports.reachByNotice: deadline exceeded')),
      opts.deadlineMs,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
