import { randomUUID } from 'node:crypto';
import { sequelize } from '../../src/models';
import type { Society, Subscription } from '../../src/models';
import { setPaymentGateway } from '../../src/adapters';
import { FakePaymentGateway } from '../../src/adapters/payments/payment-gateway';
import { setNow } from '../../src/lib/clock';
import { drainQueues } from '../../src/lib/queue';
import {
  setBillingPorts,
  placeholderBillingFiles,
} from '../../src/modules/platform-billing/platform-billing.ports';
import { registerPlatformBilling } from '../../src/modules/platform-billing/platform-billing.public';
import { issuePeriodInvoice } from '../../src/modules/platform-billing/platform-billing.service';
import type { PlatformInvoiceDto } from '../../src/modules/platform-billing/platform-billing.types';
import { systemCtx } from '../../src/types/context';
import { as, login, memberUser, resetLogins } from './access';
import { platformAs, resetSocieties } from './societies';
import { subSociety, type SubSocietyOpts } from './subscriptions';
import { resetRateLimits } from '../../src/middlewares/rateLimit.middleware';

export const idemKey = (): Record<string, string> => ({ 'Idempotency-Key': randomUUID() });

/** Fresh data, frozen clock (1 Nov 2026, 11:30 IST), real module 06 ports and a new fake gateway. */
export async function resetBilling(): Promise<FakePaymentGateway> {
  await drainQueues(); // render-pdf jobs of the previous test must not run while the tables are reset
  await resetSocieties();
  setNow('2026-11-01T06:00:00Z');
  resetLogins();
  await resetRateLimits();
  registerPlatformBilling();
  setBillingPorts();
  placeholderBillingFiles.clear();
  const gw = new FakePaymentGateway();
  setPaymentGateway(gw);
  return gw;
}

/** A society with a Treasurer (can pay), a Secretary (view only), a subscription and one issued PERIOD invoice. */
export async function billedSociety(o: SubSocietyOpts & { name?: string } = {}) {
  const { society, sub } = await subSociety({ plan: 'PREMIUM', flats: 420, ...o });
  const treasurer = await memberUser(society, 'treasurer', { name: 'Treasurer' });
  const secretary = await memberUser(society, 'secretary', { name: 'Secretary' });
  const invoice = (await sequelize.transaction(t =>
    issuePeriodInvoice(systemCtx('test'), { subscriptionId: sub.id!, periodStart: '2026-11-01' }, t),
  ))!;
  return {
    society,
    sub,
    invoice,
    treasurer,
    secretary,
    pay: as(await login(treasurer)),
    view: as(await login(secretary)),
  };
}

export async function issueFor(sub: Subscription, periodStart: string): Promise<PlatformInvoiceDto> {
  return (await sequelize.transaction(t =>
    issuePeriodInvoice(systemCtx('test'), { subscriptionId: sub.id!, periodStart }, t),
  ))!;
}

/** Two super admins (maker, checker) and a support user. */
export async function platformTeam() {
  const maker = await platformAs('super_admin', 'Maker Admin');
  const checker = await platformAs('super_admin', 'Checker Admin');
  const support = await platformAs('platform_support', 'Support User');
  return { maker, checker, support };
}

export const rawBodyOf = (o: unknown): Buffer => Buffer.from(JSON.stringify(o));
export type { Society };
