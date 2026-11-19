import { Op } from 'sequelize';
import { Society } from '../../models';
import { systemCtx, type Ctx } from '../../types/context';
import { isJobAllowed } from '../societies/societies.guard';
import type { JobTag } from '../societies/societies.types';

/** Shared helpers of the module 16 jobs (9.1): the system context of one society, the society state filter (BR-05-14) and the system audit actor. */
export const jobCtx = (societyId: number, requestId = 'communication-job'): Ctx => ({
  ...systemCtx(requestId),
  society: { id: societyId, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
});

export const SYSTEM_ACTOR = { userId: null, name: 'System', role: 'system' } as const;

export async function societyStatuses(ids?: number[]): Promise<Map<number, { status: string; tz: string }>> {
  const rows = await Society.findAll({
    attributes: ['id', 'status', 'timezone'],
    ...(ids ? { where: { id: { [Op.in]: ids } } } : {}),
  });
  return new Map(
    rows.map(r => [r.id!, { status: String(r.status), tz: String(r.timezone ?? 'Asia/Kolkata') }]),
  );
}

/** `normal` jobs skip suspended and closed societies; `safety` and `payments` jobs still run (BR-05-14). */
export async function societyAllowed(societyId: number, tag: JobTag): Promise<boolean> {
  const s = (await societyStatuses([societyId])).get(societyId);
  return s !== undefined && isJobAllowed(s.status, tag);
}

/** Hour of day (0-23) in a time zone. */
export function localHour(at: Date, tz: string): number {
  try {
    return (
      Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }).format(at)) %
      24
    );
  } catch {
    return (at.getUTCHours() + 5) % 24;
  }
}

/** Jobs of other parts (16.1 notices, 16.3 surveys / emergency) may replace the default step by registering a hook; the default behaviour works without them. */
export interface JobHooks {
  /** 16.1: publish a SCHEDULED notice now (default: status PUBLISHED + audit + `communication:notice-fanout`). */
  publishScheduledNotice?: (societyId: number, noticeId: number, at: Date) => Promise<boolean>;
  /** 16.3: record a response of a WhatsApp button reply (8.37; called only when exactly one audience flat of the user matches). */
  recordEmergencyResponse?: (input: {
    societyId: number;
    broadcastId: number;
    userId: number;
    unitId: number;
    status: 'SAFE' | 'NEED_HELP';
    channel: 'WHATSAPP';
  }) => Promise<void>;
}
export const jobHooks: JobHooks = {};
export const setJobHooks = (h: JobHooks | null): void => {
  for (const k of Object.keys(jobHooks)) delete (jobHooks as Record<string, unknown>)[k];
  if (h) Object.assign(jobHooks, h);
};
