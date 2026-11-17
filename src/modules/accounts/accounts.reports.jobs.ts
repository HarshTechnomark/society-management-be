import { registerProcessor } from '../../lib/queue';
import { logger } from '../../lib/logger';
import { ACCOUNTS_QUEUE, JOBS } from './accounts.constants';
import { runExportJob, type ExportJobData } from './accounts.reports.export';
import './accounts.reports.templates';

/** 13.4b start-up registration: the processor of `accounts:report-export` (section 9.1). */
export function registerReportJobs(): void {
  registerProcessor(ACCOUNTS_QUEUE, JOBS.reportExport, async data => {
    const r = await runExportJob(data as ExportJobData);
    logger.info({ exportJobId: data.exportJobId, fileId: r.fileId }, 'accounts:report-export done');
  });
}
