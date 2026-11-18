import { Op } from 'sequelize';
import { EmergencyBroadcast, EmergencyResponse, User } from '../../models';
import { emitToRoom, emitToUser } from '../../lib/realtime';
import { logger } from '../../lib/logger';
import { NotFoundError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { appUrl } from '../auth/auth.apps';
import { members } from '../access-control/access-control.public';
import { residents } from '../residents/residents.public';
import { units } from '../society-setup/society-setup.public';
import type { UnitDto } from '../society-setup/society-setup.types';
import {
  ERR,
  NOTIFY,
  RT,
  roomAdmin,
  roomGate,
  roomUser,
  type Channel,
  type EmergencyType,
} from './communication.constants';
import { resolveAudience } from './communication.audience';
import { notify } from './communication.core';
import type { NoticeAudience, Recipient } from './communication.types';

/** Helpers shared by the emergency services (16.3): audience units, recipients, notify and realtime fan-out (8.25 to 8.30, BR-16-39). */

export const eNotFound = () => new NotFoundError(ERR.emergencyNotFound, 'Emergency broadcast not found');

export const societyIdOf = (ctx: Ctx): number => {
  const id = ctx.society?.id;
  if (!id) throw new Error('communication: the context carries no society');
  return id;
};

export const DEFAULT_TITLES: Record<EmergencyType, string> = {
  FIRE: 'Fire',
  GAS_LEAK: 'Gas leak',
  WATER: 'Water emergency',
  LIFT_STUCK: 'Lift stuck',
  SECURITY_THREAT: 'Security threat',
  MEDICAL: 'Medical emergency',
  POWER: 'Power failure',
  NATURAL_DISASTER: 'Natural disaster',
  OTHER: 'Emergency',
};

export const audienceOf = (
  b: Pick<EmergencyBroadcast, 'audienceType' | 'audienceBuildingIds'>,
): NoticeAudience =>
  b.audienceType === 'BUILDINGS' ? { type: 'BUILDINGS', ids: b.audienceBuildingIds ?? [] } : { type: 'ALL' };

/** Active units of the audience (BR-16-39), then only the occupied ones (module 09 `occupancyOf`, 8.27). */
export async function occupiedAudienceUnits(societyId: number, a: NoticeAudience): Promise<UnitDto[]> {
  let list: UnitDto[];
  if (a.type === 'BUILDINGS') {
    list = (
      await Promise.all((a.ids ?? []).map(buildingId => units.listActive(societyId, { buildingId })))
    ).flat();
  } else list = await units.listActive(societyId, {});
  const occ = await residents.occupancyOf(
    societyId,
    list.map(u => u.id),
  );
  return list.filter(u => (occ.get(u.id) ?? 'VACANT') !== 'VACANT');
}

/** Active members of staff and committee roles (scope `society`) and guards (scope `gate`). */
export async function staffAndGuardUserIds(societyId: number): Promise<number[]> {
  const out = new Set<number>();
  for (const roleScope of ['society', 'gate'])
    for (const m of await members.listForSociety(societyId, { roleScope, statuses: ['ACTIVE'] }))
      out.add(m.userId);
  return [...out];
}

export interface EmergencyRecipients {
  /** Residents with a login in the audience. */
  residentUserIds: number[];
  staffUserIds: number[];
  /** Residents with a mobile but no login. */
  mobiles: string[];
  /** Distinct users (residents + staff). */
  userIds: number[];
  /** `recipientCount` of 7.8: users plus mobile-only residents. */
  count: number;
}

export async function recipientsOf(
  societyId: number,
  b: Pick<EmergencyBroadcast, 'audienceType' | 'audienceBuildingIds' | 'includeStaff'>,
): Promise<EmergencyRecipients> {
  const r = await resolveAudience(societyId, audienceOf(b));
  const staffUserIds = b.includeStaff ? await staffAndGuardUserIds(societyId) : [];
  const mobiles = [
    ...new Set(
      r.people.filter(p => !p.userId && p.mobile && /^[6-9]\d{9}$/.test(p.mobile)).map(p => p.mobile!),
    ),
  ];
  const userIds = [...new Set([...r.userIds, ...staffUserIds])];
  return {
    residentUserIds: r.userIds,
    staffUserIds,
    mobiles,
    userIds,
    count: userIds.length + mobiles.length,
  };
}

export const startedByNames = async (ids: (number | null | undefined)[]): Promise<Map<number, string>> => {
  const want = [...new Set(ids.filter((x): x is number => !!x))];
  if (!want.length) return new Map();
  const rows = await User.findAll({
    where: { id: { [Op.in]: want } },
    attributes: ['id', 'name'],
    paranoid: false,
  });
  return new Map(rows.map(u => [u.id!, u.name ?? 'User']));
};

export const emergencyLink = (id: number): string => appUrl('RESIDENT', `/emergency/${id}`);

const ALERT_CHANNELS: Channel[] = ['IN_APP', 'PUSH', 'SMS', 'WHATSAPP'];
const DRILL_CHANNELS: Channel[] = ['IN_APP', 'PUSH'];

/**
 * Sends one emergency template to the recipients of a broadcast after commit (SAFETY class, drills in-app and push only, "DRILL: " prefix).
 * A failing send is logged and never fails the request: the alert row is already committed.
 */
export async function sendEmergency(
  key: string,
  b: EmergencyBroadcast,
  recipients: Recipient[],
  o: { channels?: Channel[]; dedupeKey: string; message?: string },
): Promise<void> {
  if (!recipients.length) return;
  const channels = b.isDrill
    ? (o.channels ?? DRILL_CHANNELS).filter(c => DRILL_CHANNELS.includes(c))
    : (o.channels ?? ALERT_CHANNELS);
  try {
    await notify(
      key,
      recipients,
      {
        broadcastId: b.id,
        title: b.title,
        message: o.message ?? b.message,
        prefix: b.isDrill ? 'DRILL: ' : '',
        link: emergencyLink(b.id),
      },
      {
        societyId: b.societyId,
        channels,
        dedupeKey: o.dedupeKey,
        sourceType: 'emergency_broadcast',
        sourceId: b.id,
      },
    );
  } catch (err) {
    logger.error({ err, broadcastId: b.id, key }, 'emergency notify failed');
  }
}

/** The `{ audience }` recipient plus staff and guards (start, update). */
export const fullRecipients = (b: EmergencyBroadcast, r: EmergencyRecipients): Recipient[] => [
  { audience: audienceOf(b) as { type: 'ALL' | 'BUILDINGS'; ids?: number[] } },
  ...r.staffUserIds,
];

/** Realtime: the admin and gate rooms and each recipient's user room. */
export function emitEmergency(
  b: EmergencyBroadcast,
  event: string,
  userIds: number[] = [],
  userEvent?: string,
): void {
  const payload = { id: b.id, type: b.type, status: b.status, isDrill: b.isDrill, version: b.version };
  emitToRoom(roomAdmin(b.societyId), event, payload);
  emitToRoom(roomGate(b.societyId), event, payload);
  if (userEvent) for (const u of userIds) emitToUser(u, userEvent, { ...payload, title: b.title });
}
export { roomUser, NOTIFY, RT };

export const latestResponses = (broadcastId: number, t?: import('sequelize').Transaction) =>
  EmergencyResponse.findAll({ where: { broadcastId, isLatest: true }, transaction: t });
