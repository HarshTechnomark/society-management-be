import { Op } from 'sequelize';
import { EmergencyResponse, InboxItem, Notification, PushSubscription } from '../../models';
import { addDays, addHours, now } from '../../lib/clock';
import { LIMITS } from './communication.constants';

/** Section 9.1 housekeeping: `communication:purge` (daily 03:30 IST) and `communication:push-expiry` (daily 04:00 IST). */
const BATCH = 5000;
const FINAL = ['SENT', 'DELIVERED', 'READ', 'FAILED', 'CANCELLED', 'SKIPPED'];

async function deleteBatches(run: () => Promise<number>): Promise<number> {
  let total = 0;
  for (;;) {
    const n = await run();
    total += n;
    if (n < BATCH) return total;
  }
}

export interface PurgeResult {
  inbox: number;
  deliveries: number;
  payloadsCleared: number;
  pushDeleted: number;
  emergencyResponsesScrubbed: number;
}

export async function runPurge(at: Date = now()): Promise<PurgeResult> {
  const inboxBefore = addDays(at, -LIMITS.inboxRetentionDays);
  const inbox = await deleteBatches(async () => {
    const rows = await InboxItem.findAll({
      where: { createdAt: { [Op.lt]: inboxBefore } },
      attributes: ['id'],
      limit: BATCH,
    });
    if (!rows.length) return 0;
    return InboxItem.destroy({ where: { id: { [Op.in]: rows.map(r => r.id) } } });
  });
  const deliveryBefore = addDays(at, -LIMITS.deliveryRetentionDays);
  const deliveries = await deleteBatches(async () => {
    const rows = await Notification.findAll({
      where: { createdAt: { [Op.lt]: deliveryBefore } },
      attributes: ['id'],
      limit: BATCH,
    });
    if (!rows.length) return 0;
    return Notification.destroy({ where: { id: { [Op.in]: rows.map(r => r.id) } } });
  });
  // BR-16-31: encrypted payloads and destinations leave final rows after 24 hours
  const clearBefore = addHours(at, -LIMITS.encClearHours);
  const payloadsCleared = await deleteBatches(async () => {
    const rows = await Notification.findAll({
      where: {
        status: { [Op.in]: FINAL },
        updatedAt: { [Op.lt]: clearBefore },
        [Op.or]: [{ dataEnc: { [Op.ne]: null } }, { destinationEnc: { [Op.ne]: null } }],
      },
      attributes: ['id'],
      limit: BATCH,
    });
    if (!rows.length) return 0;
    const [n] = await Notification.update(
      { dataEnc: null, destinationEnc: null },
      { where: { id: { [Op.in]: rows.map(r => r.id) } }, silent: true },
    );
    return n;
  });
  const pushBefore = addDays(at, -LIMITS.revokedPushRetentionDays);
  const pushDeleted = await deleteBatches(async () => {
    const rows = await PushSubscription.findAll({
      where: { status: 'REVOKED', revokedAt: { [Op.lt]: pushBefore } },
      attributes: ['id'],
      limit: BATCH,
    });
    if (!rows.length) return 0;
    return PushSubscription.destroy({ where: { id: { [Op.in]: rows.map(r => r.id) } } });
  });
  // BR-16-44: notes and user ids of emergency responses older than a year are cleared, counts stay on the broadcast
  const emBefore = addDays(at, -LIMITS.emergencyRetentionDays);
  const emergencyResponsesScrubbed = await deleteBatches(async () => {
    const rows = await EmergencyResponse.findAll({
      where: {
        createdAt: { [Op.lt]: emBefore },
        [Op.or]: [{ note: { [Op.ne]: null } }, { userId: { [Op.ne]: null } }],
      },
      attributes: ['id'],
      limit: BATCH,
    });
    if (!rows.length) return 0;
    const [n] = await EmergencyResponse.update(
      { note: null, userId: null },
      { where: { id: { [Op.in]: rows.map(r => r.id) } }, silent: true },
    );
    return n;
  });
  return { inbox, deliveries, payloadsCleared, pushDeleted, emergencyResponsesScrubbed };
}

/** `communication:push-expiry`: `expirationTime` passed -> REVOKED (`EXPIRED`). */
export async function runPushExpiry(at: Date = now()): Promise<{ revoked: number }> {
  const [revoked] = await PushSubscription.update(
    { status: 'REVOKED', revokedReason: 'EXPIRED', revokedAt: at },
    { where: { status: 'ACTIVE', expirationTime: { [Op.lt]: at } } },
  );
  return { revoked };
}
