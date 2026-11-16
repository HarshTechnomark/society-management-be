import { registerProcessor, registerRepeatable } from '../../lib/queue';
import { JOBS, PAYMENTS_QUEUE } from './payments.constants';
import { pollGatewayRefunds, registerRefundApprovalType } from './payments.refunds.service';

/** `PAYMENT_REFUND` approval type and `payments:refund-status` (hourly, section 9.1): PROCESSING gateway refunds older than 2 hours are polled. */
export function registerRefundJobs(): void {
  registerRefundApprovalType();
  registerProcessor(PAYMENTS_QUEUE, JOBS.refundStatus, async () => ({ changed: await pollGatewayRefunds() }));
  registerRepeatable(PAYMENTS_QUEUE, JOBS.refundStatus, { hourlyAtMinute: 5 });
}
