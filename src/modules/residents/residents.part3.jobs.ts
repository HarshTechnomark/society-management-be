import { Society } from '../../models';
import { registerProcessor, registerRepeatable } from '../../lib/queue';
import { isJobAllowed } from '../societies/societies.guard';
import { RESIDENTS_QUEUE } from './residents.constants';
import { PART3_JOBS } from './residents.part3.constants';
import { runRenovationDaily } from './residents.renovations.service';

/** Jobs of queue `residents` added by part 3 (section 9.1): `residents:renovation-daily` at 00:30. Call after `registerResidentsJobs()`. */
export async function renovationDailyAll(): Promise<void> {
  const rows = await Society.findAll({ attributes: ['id', 'status'], order: [['id', 'ASC']] });
  for (const s of rows)
    if (isJobAllowed(s.status, 'normal') && s.status !== 'CLOSED') await runRenovationDaily(s.id!);
}

export function registerPart3Jobs(): void {
  registerProcessor(RESIDENTS_QUEUE, PART3_JOBS.renovationDaily, renovationDailyAll);
  registerRepeatable(RESIDENTS_QUEUE, PART3_JOBS.renovationDaily, { dailyAtIst: '00:30' });
}
