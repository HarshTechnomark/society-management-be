import { registerProcessor, registerRepeatable } from '../../lib/queue';
import { COMMUNICATION_QUEUE, JOBS } from './communication.constants';
import { runNotifyFanout } from './communication.core';
import { repairStuck, runDeliverJob } from './communication.deliver';
import { registerNoticeJobs } from './communication.notices.jobs';
import { registerCommunicationPartJobs } from './communication.jobs.register';
import { jobHooks } from './communication.jobs.common';
import { publishScheduledNotice } from './communication.notices.fanout';
import { recordWhatsappResponse } from './communication.emergency.service';

export { COMMUNICATION_QUEUE };

/**
 * Registry of the jobs of queue `communication` (section 9.1). The foundation registers `deliver`, `notify-fanout` and `repair-stuck`; part 16.4 adds
 * `notice-scheduler`, `notice-expiry`, `ack-reminders`, `ack-remind-notice`, `utility-reminders`, `emergency-resolve-reminder`, `survey-close`,
 * `process-webhook`, `purge` and `push-expiry` with ONE line each below (a `register...Jobs()` call from its own file). Payloads carry ids only.
 */
export function registerCommunicationJobs(): void {
  registerProcessor(COMMUNICATION_QUEUE, JOBS.deliver, data => runDeliverJob(data));
  registerProcessor(COMMUNICATION_QUEUE, JOBS.notifyFanout, data => runNotifyFanout(data));
  registerProcessor(COMMUNICATION_QUEUE, JOBS.repairStuck, () => repairStuck({ lateMs: 120_000 }));
  registerRepeatable(COMMUNICATION_QUEUE, JOBS.repairStuck, { everyMs: 5 * 60_000 });
  // parts add their registration here, one line each:
  registerNoticeJobs(); // 16.1: notice-fanout
  registerCommunicationPartJobs(); // 16.4: notice scheduler / expiry, reminders, emergency, survey close, webhooks, purge, push expiry
  // hooks of 16.4's jobs implemented by the other parts
  jobHooks.publishScheduledNotice ??= publishScheduledNotice; // 16.1
  jobHooks.recordEmergencyResponse ??= recordWhatsappResponse; // 16.3
}
