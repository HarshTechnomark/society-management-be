import { registerProcessor, registerRepeatable } from '../../lib/queue';
import { COMMUNICATION_QUEUE, JOBS } from './communication.constants';
import {
  runAckReminders,
  runAckRemindNotice,
  runNoticeExpiry,
  runNoticeScheduler,
  runUtilityReminders,
} from './communication.jobs.notices';
import { runEmergencyResolveReminder, runSurveyClose } from './communication.jobs.safety';
import { runPurge, runPushExpiry } from './communication.jobs.maintenance';
import { runProcessWebhook } from './communication.webhooks.service';

/** Part 16.4: the jobs of section 9.1 not registered by the foundation. Schedules follow the table of 9.1; every job is idempotent (status and counter checks inside the UPDATE). */
export function registerCommunicationPartJobs(): void {
  const q = COMMUNICATION_QUEUE;
  registerProcessor(q, JOBS.noticeScheduler, () => runNoticeScheduler());
  registerRepeatable(q, JOBS.noticeScheduler, { everyMs: 60_000 });
  registerProcessor(q, JOBS.noticeExpiry, () => runNoticeExpiry());
  registerRepeatable(q, JOBS.noticeExpiry, { everyMs: 15 * 60_000 });
  registerProcessor(q, JOBS.ackReminders, () => runAckReminders());
  registerRepeatable(q, JOBS.ackReminders, { hourlyAtMinute: 0 });
  registerProcessor(q, JOBS.ackRemindNotice, data => runAckRemindNotice(data));
  registerProcessor(q, JOBS.utilityReminders, () => runUtilityReminders());
  registerRepeatable(q, JOBS.utilityReminders, { everyMs: 5 * 60_000 });
  registerProcessor(q, JOBS.emergencyResolveReminder, () => runEmergencyResolveReminder());
  registerRepeatable(q, JOBS.emergencyResolveReminder, { everyMs: 5 * 60_000 });
  registerProcessor(q, JOBS.surveyClose, () => runSurveyClose());
  registerRepeatable(q, JOBS.surveyClose, { everyMs: 5 * 60_000 });
  registerProcessor(q, JOBS.processWebhook, data => runProcessWebhook(data));
  registerProcessor(q, JOBS.purge, () => runPurge());
  registerRepeatable(q, JOBS.purge, { dailyAtIst: '03:30' });
  registerProcessor(q, JOBS.pushExpiry, () => runPushExpiry());
  registerRepeatable(q, JOBS.pushExpiry, { dailyAtIst: '04:00' });
}
