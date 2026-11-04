import { addDaysYmd, daysInclusive, maxYmd } from './billing.calc.period';

/**
 * Liable segments of a flat inside a period (BR-11-26, BR-11-27). Pure functions. The period is cut at every `fromDate` and
 * `toDate + 1` of the flat's links and at the possession date; each segment has one owner party and knows whether a tenancy
 * (a TENANT link) covers it. Days without an owner, and days before possession, are not liable and are not in any segment.
 */
export interface LinkRow {
  linkId: number;
  residentId: number;
  name: string;
  relation: 'OWNER' | 'CO_OWNER' | 'TENANT' | string;
  isPrimary: boolean;
  fromDate: string;
  toDate: string | null;
}
export interface Party {
  residentId: number;
  relation: 'OWNER' | 'CO_OWNER' | 'TENANT';
  name: string;
}
export interface Segment {
  from: string;
  to: string;
  days: number;
  owner: Party;
  tenancyActive: boolean;
  /** The party of `BILL_TO` heads; filled by the engine from module 09 `billToFor` (the owner when it returns nothing). */
  billTo: Party;
}

const covers = (l: LinkRow, from: string, to: string): boolean =>
  l.fromDate <= from && (l.toDate === null || l.toDate >= to);

/** BR-11-9: among the owner links, the primary one, else the OWNER link, else the CO_OWNER with the lowest link id. */
export function ownerParty(links: LinkRow[]): Party | null {
  const owners = links.filter(l => l.relation === 'OWNER' || l.relation === 'CO_OWNER');
  const pick =
    owners.filter(l => l.isPrimary).sort((a, b) => a.linkId - b.linkId)[0] ??
    owners.filter(l => l.relation === 'OWNER').sort((a, b) => a.linkId - b.linkId)[0] ??
    owners.filter(l => l.relation === 'CO_OWNER').sort((a, b) => a.linkId - b.linkId)[0];
  return pick
    ? { residentId: pick.residentId, relation: pick.relation as 'OWNER' | 'CO_OWNER', name: pick.name }
    : null;
}

export function liableSegments(
  links: LinkRow[],
  periodStart: string,
  periodEnd: string,
  possessionDate: string | null,
): Segment[] {
  const cuts = new Set<string>([periodStart]);
  const add = (d: string) => {
    if (d > periodStart && d <= periodEnd) cuts.add(d);
  };
  for (const l of links) {
    add(l.fromDate);
    if (l.toDate) add(addDaysYmd(l.toDate, 1));
  }
  if (possessionDate) add(possessionDate);
  const starts = [...cuts].sort();
  const out: Segment[] = [];
  const keys: string[] = [];
  starts.forEach((from, i) => {
    const to = i + 1 < starts.length ? addDaysYmd(starts[i + 1]!, -1) : periodEnd;
    if (possessionDate && from < possessionDate) return;
    const live = links.filter(l => covers(l, from, to));
    const owner = ownerParty(live);
    if (!owner) return;
    const tenants = live.filter(l => l.relation === 'TENANT');
    const tenancyActive = tenants.length > 0;
    const key = `${owner.residentId}|${tenants
      .map(l => l.residentId)
      .sort()
      .join(',')}`;
    const last = out[out.length - 1];
    if (last && keys[keys.length - 1] === key && addDaysYmd(last.to, 1) === from) {
      last.to = to;
      last.days = daysInclusive(last.from, to);
      return;
    }
    keys.push(key);
    out.push({
      from: maxYmd(from, periodStart),
      to,
      days: daysInclusive(from, to),
      owner,
      tenancyActive,
      billTo: owner,
    });
  });
  return out;
}
