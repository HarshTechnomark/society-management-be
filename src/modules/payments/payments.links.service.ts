import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { UniqueConstraintError } from 'sequelize';
import { addDays, now } from '../../lib/clock';
import { env } from '../../lib/env';
import { logger } from '../../lib/logger';
import { PaymentOrder, Society, Unit, User } from '../../models';
import { AppError, GoneError, NotFoundError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { systemCtx } from '../../types/context';
import { audit } from '../../utils/audit';
import { assertFeature } from '../subscriptions/entitlements.service';
import { invoices } from '../billing/billing.public';
import { primaryOwnerUserIds } from '../residents/residents.part3.shared';
import { AUDIT, ENT, ERR, NOTIFY } from './payments.constants';
import { activeAccount, accountOf, checkoutOf, ensureGatewayOrder } from './payments.orders.gateway';
import { insertOrder, MAX_BASE_PAISE, MIN_ITEM_PAISE } from './payments.orders.create';
import { LIVE, statusBody, verifyOrder } from './payments.orders.service';
import { paymentsPorts } from './payments.ports';
import { lockUnit, moneyTx, n, setting } from './payments.shared';

/**
 * Payment links (8.18) and the public pay routes (8.24). The token is 16 random bytes (base64url); only its SHA-256 is stored and
 * compared in constant time. A link is a `PAYMENT_LINK` order without a gateway order until the payer opens the checkout.
 */
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const shortCode = (): string => [...randomBytes(10)].map(b => ALNUM[b % ALNUM.length]).join('');

export interface LinkInput {
  unitId: number;
  amountMode: 'OUTSTANDING' | 'FIXED';
  amountPaise?: number;
  expiresInDays?: number;
  channels?: ('SMS' | 'WHATSAPP' | 'EMAIL')[];
}

/** The resident app origin used in links: `https://my.…` when configured, else the first app origin. */
const linkOrigin = (): string => env().appOrigins.find(o => /\/\/my\./.test(o)) ?? env().appOrigins[0]!;

export async function createPaymentLink(ctx: Ctx, input: LinkInput) {
  const societyId = ctx.society!.id;
  if (input.channels?.includes('WHATSAPP')) await assertFeature(ctx, ENT.whatsappLink);
  const unit = await Unit.findOne({ where: { id: input.unitId, societyId } });
  if (!unit || (unit as Unit & { status?: string }).status === 'ARCHIVED')
    throw new NotFoundError(ERR.unitNotFound, 'Unit not found');
  const account = await activeAccount(societyId);
  const days =
    input.expiresInDays ?? (Number(await setting(societyId, 'payments.paymentLinkExpiryDays')) || 7);
  const token = randomBytes(16).toString('base64url');
  let attempt = 0;
  for (;;) {
    const code = shortCode();
    try {
      const order = await moneyTx(async t => {
        await lockUnit(societyId, input.unitId, t);
        let base = input.amountPaise ?? 0;
        if (input.amountMode === 'OUTSTANDING')
          base = (await invoices.listOpen(societyId, input.unitId))
            .filter(i => !i.isDisputed)
            .reduce((a, i) => a + i.outstandingPaise, 0);
        if (base <= 0) throw new UnprocessableError(ERR.nothingToPay, 'There is nothing to pay');
        if (base < MIN_ITEM_PAISE)
          throw new UnprocessableError(ERR.amountBelowMinimum, 'The amount is below the minimum');
        if (base > MAX_BASE_PAISE)
          throw new UnprocessableError(ERR.amountTooLarge, 'The amount is too large for one payment');
        const o = await insertOrder(
          ctx,
          {
            societyId,
            unitId: input.unitId,
            payerUserId: null,
            createdBy: ctx.user?.id ?? null,
            sourceType: 'PAYMENT_LINK',
            allocationMode: 'OLDEST_FIRST',
            items: [
              { itemType: 'OLDEST_FIRST_DUES', itemId: null, label: 'Dues, oldest first', amountPaise: base },
            ],
            base,
            // no method is known on a link, so a passed-through fee is not applied (8.18)
            fee: { basePaise: base, feePaise: 0, feeGstPaise: 0, grossPaise: base, rateBp: 0 },
            feeMode: 'SOCIETY_ABSORBS',
            methodHint: null,
            account,
            expiresAt: addDays(now(), days),
            link: { tokenHash: sha256(token), shortCode: code },
          },
          t,
        );
        await audit(
          ctx,
          {
            action: AUDIT.linkCreated,
            entityType: 'payment_order',
            entityId: n(o.id),
            entityLabel: `PO-${o.id}`,
            societyId,
            before: null,
            after: { id: n(o.id), unitId: input.unitId, amountPaise: base, channels: input.channels ?? [] },
            reason: null,
          },
          t,
        );
        return o;
      });
      const url = `${linkOrigin()}/pay/${code}#${token}`;
      const owners = await primaryOwnerUserIds(societyId, input.unitId);
      if (owners.length)
        await paymentsPorts()
          .notifications.send(NOTIFY.paymentLink, owners, {
            societyId,
            unitLabel: unit.label,
            url,
            amountPaise: n(order.basePaise),
            channels: input.channels ?? ['SMS'],
          })
          .catch(err => logger.error({ err }, 'payment_link notification failed'));
      return { orderId: n(order.id), url, expiresAt: order.expiresAt, amountPaise: n(order.basePaise) };
    } catch (err) {
      if (err instanceof UniqueConstraintError && ++attempt < 5) continue; // short code clash
      throw err;
    }
  }
}

// ---------------------------------------------------------------- public routes (8.24)
const maskName = (name: string | null): string =>
  (name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0] + '*'.repeat(Math.max(2, w.length - 1)))
    .join(' ') || '***';

/** Finds the link by code and compares the token hash in constant time; anything wrong is the same `404`. */
async function linkOrder(code: string, token: string | undefined): Promise<PaymentOrder> {
  const notFound = () => new NotFoundError(ERR.linkNotFound, 'Payment link not found');
  if (!/^[A-Za-z0-9]{10}$/.test(code) || !token) throw notFound();
  const o = await PaymentOrder.findOne({ where: { linkShortCode: code, sourceType: 'PAYMENT_LINK' } });
  const want = Buffer.from(o?.linkTokenHash ?? '0'.repeat(64));
  const got = Buffer.from(sha256(token));
  const same = want.length === got.length && timingSafeEqual(want, got);
  if (!o || !same) throw notFound();
  return o;
}

/** BR-12-50: a closed society takes no new orders (suspended is allowed). */
async function assertSocietyOpen(societyId: number): Promise<Society> {
  const s = await Society.findByPk(societyId);
  if (!s) throw new NotFoundError(ERR.linkNotFound, 'Payment link not found');
  if (s.status === 'CLOSED') throw new AppError(423, 'SOCIETY_CLOSED', 'This society is closed');
  return s;
}

const expired = (o: PaymentOrder) =>
  o.status === 'EXPIRED' || (o.status !== 'PAID' && o.expiresAt.getTime() <= now().getTime());

export async function publicLinkInfo(code: string, token: string | undefined) {
  const o = await linkOrder(code, token);
  const society = await assertSocietyOpen(n(o.societyId));
  if (o.status !== 'PAID' && o.status !== 'CANCELLED' && expired(o))
    throw new GoneError(ERR.linkExpired, 'This payment link has expired');
  await PaymentOrder.increment('linkOpenedCount', { where: { id: o.id } });
  const unit = await Unit.findByPk(o.unitId, { attributes: ['label'] });
  const owner = (await primaryOwnerUserIds(n(o.societyId), n(o.unitId)))[0];
  const name = owner ? ((await User.findByPk(owner, { attributes: ['name'] }))?.name ?? null) : null;
  return {
    societyName: society.name,
    unitLabel: unit?.label ?? '',
    payerNameMasked: maskName(name),
    amountPaise: n(o.basePaise),
    status: o.status === 'PAID' ? 'PAID' : o.status === 'CANCELLED' ? 'CANCELLED' : 'PAYABLE',
    expiresAt: o.expiresAt,
  };
}

export async function publicLinkCheckout(code: string, token: string | undefined) {
  const o = await linkOrder(code, token);
  await assertSocietyOpen(n(o.societyId));
  if (o.status === 'PAID' || o.status === 'CANCELLED')
    throw new AppError(409, ERR.invalidState, `This payment link is already ${o.status.toLowerCase()}`);
  if (expired(o)) throw new GoneError(ERR.linkExpired, 'This payment link has expired');
  if (!(LIVE as readonly string[]).includes(o.status))
    throw new AppError(409, ERR.invalidState, 'This payment link cannot be used');
  const account = await activeAccount(n(o.societyId));
  const full = await ensureGatewayOrder(o, account, { failOrder: false });
  return {
    orderId: n(full.id),
    status: full.status,
    grossAmountPaise: n(full.grossAmountPaise),
    expiresAt: full.expiresAt,
    checkout: await checkoutOf(full, account),
  };
}

export async function publicLinkVerify(code: string, token: string | undefined, gatewayPaymentId: string) {
  const o = await linkOrder(code, token);
  await assertSocietyOpen(n(o.societyId));
  await accountOf(n(o.gatewayAccountId));
  return verifyOrder(systemCtx('public-pay'), o, gatewayPaymentId);
}

export { statusBody };
