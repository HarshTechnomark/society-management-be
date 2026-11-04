import { randomUUID } from 'node:crypto';
import { sequelize } from '../../src/models';
import { setNow } from '../../src/lib/clock';
import { registerBilling } from '../../src/modules/billing/billing.public';
import { clearMeterSources, setBillingPorts } from '../../src/modules/billing/billing.ports';
import { settings } from '../../src/modules/society-setup/society-setup.public';
import { systemCtx } from '../../src/types/context';
import { residentSociety, resetResidents, type Client } from './residents';

export const idem = (): Record<string, string> => ({ 'Idempotency-Key': randomUUID() });

/** Fresh state with the module 02 to 09 registrations, the billing placeholders and the 11.1 approval types. Call from `beforeEach`. */
export async function resetBillingSetup(): Promise<void> {
  await resetResidents();
  setBillingPorts();
  clearMeterSources();
  registerBilling();
  setNow('2026-11-01T04:30:00Z');
}

/** A PREMIUM society with its chairman and four flats in tower A. */
export const billingWorld = (o: Parameters<typeof residentSociety>[0] = {}) =>
  residentSociety({ flats: 4, ...o });
export type BillingWorld = Awaited<ReturnType<typeof billingWorld>>;

/** `{ id }` of a seeded head by key (GET /billing/charge-heads seeds the heads on first read). */
export async function headId(c: Client, key: string): Promise<number> {
  const r = await c('get', '/billing/charge-heads', undefined, { query: { status: 'ALL', limit: '100' } });
  if (r.status !== 200) throw new Error(`heads ${r.status} ${JSON.stringify(r.body)}`);
  const h = (r.body.data as { id: number; key: string }[]).find(x => x.key === key);
  if (!h) throw new Error(`no head ${key}`);
  return h.id;
}

export const perSqft = (over: Record<string, unknown> = {}) => ({
  rateType: 'PER_SQFT',
  ratePerSqftPaise: 320,
  effectiveFrom: '2026-04-01',
  reason: 'AGM resolution 4 of 2026',
  ...over,
});

export const ruleBody = (chargeHeadId: number, over: Record<string, unknown> = {}) => ({
  chargeHeadId,
  name: 'Maintenance – all flats',
  scopeType: 'ALL_UNITS',
  firstVersion: perSqft(),
  ...over,
});

/** POST /billing/rules; returns the response (expect null) or the rule `data` (default expect 201). */
export async function postRule(
  c: Client,
  body: Record<string, unknown>,
  expect: number | null = 201,
): Promise<any> {
  const r = await c('post', '/billing/rules', body, { headers: idem() });
  if (expect !== null && r.status !== expect)
    throw new Error(`postRule ${r.status} ${JSON.stringify(r.body)}`);
  return expect === null ? r : r.body.data;
}

export async function postVersion(
  c: Client,
  ruleId: number,
  body: Record<string, unknown>,
  expect: number | null = 201,
): Promise<any> {
  const r = await c('post', `/billing/rules/${ruleId}/versions`, body, { headers: idem() });
  if (expect !== null && r.status !== expect)
    throw new Error(`postVersion ${r.status} ${JSON.stringify(r.body)}`);
  return expect === null ? r : r.body.data;
}

/** Ends setup mode (BR-11-21): an ISSUED regular run whose period ends on `periodEnd` (straight into the table). */
export async function issuedRun(
  societyId: number,
  periodStart = '2026-10-01',
  periodEnd = '2026-10-31',
): Promise<void> {
  await sequelize.query(
    `INSERT INTO billing_runs (societyId, runLabel, runType, cycle, periodStart, periodEnd, billDate, scopeType, status, activeKey, createdAt, updatedAt)
     VALUES (:societyId, :label, 'REGULAR', 'MONTHLY', :periodStart, :periodEnd, :periodStart, 'ALL_UNITS', 'ISSUED', :key, NOW(3), NOW(3))`,
    {
      replacements: {
        societyId,
        periodStart,
        periodEnd,
        label: `BR-${periodStart}`,
        key: `REG:${periodStart}`,
      },
    },
  );
}

/** Sets a module 08 setting (the billing cycle, the late fee defaults). */
export const setSetting = (societyId: number, key: string, value: unknown) =>
  sequelize.transaction(t => settings.set(systemCtx('test'), societyId, key as never, value as never, t));
