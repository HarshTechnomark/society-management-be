import { randomUUID } from 'node:crypto';
import { setNow } from '../../src/lib/clock';
import { registerBilling } from '../../src/modules/billing/billing.public';
import { setBillingPorts } from '../../src/modules/billing/billing.ports';
import { resetResidents, residentSociety } from './residents';
import type { Society } from '../../src/models';

/** Module 11.2 fixtures: the module 09 reset, then the placeholder billing ports and the module 11 registrations. */
export async function resetLedger(): Promise<void> {
  await resetResidents();
  setBillingPorts();
  registerBilling();
  setNow('2026-11-01T04:30:00Z');
}

export const ledgerSociety = (o: { flats?: number; role?: string } = {}) =>
  residentSociety({ flats: 3, ...o });

/** A request context of a society for the service functions. */
export const societyCtx = (society: Society, userId?: number) => ({
  requestId: 'test',
  ip: '',
  userAgent: '',
  society: {
    id: society.id!,
    name: society.name,
    status: 'ACTIVE',
    timezone: 'Asia/Kolkata',
    planKey: 'PREMIUM',
  },
  ...(userId
    ? {
        user: { id: userId, name: 'Test', mobile: null, email: null, platformRoleId: null, status: 'ACTIVE' },
      }
    : {}),
  permissions: new Set<string>(),
  platformPermissions: new Set<string>(),
  unitIds: [],
  unitLinks: [],
});

export const key = (): Record<string, string> => ({ 'Idempotency-Key': randomUUID() });
