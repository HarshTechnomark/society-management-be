import { registerProcessor } from '../../lib/queue';
import { COMMUNICATION_QUEUE, JOBS } from './communication.constants';
import { runNoticeFanout } from './communication.notices.fanout';

/**
 * 16.1 jobs: the on-demand fan-out. `ack-remind-notice` and the scheduled sweepers (`notice-scheduler`, `notice-expiry`, `ack-reminders`,
 * `utility-reminders`) are registered once, by 16.4 (`communication.jobs.register.ts`).
 */
export function registerNoticeJobs(): void {
  registerProcessor(COMMUNICATION_QUEUE, JOBS.noticeFanout, data => runNoticeFanout(data));
}
