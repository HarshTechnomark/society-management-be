import { registerTemplates, type Template } from '../../lib/notify';
import { NOTIFY } from './accounts.constants';

/** Templates of 13.1b (section 10) for the temporary `lib/notify.ts`; module 16 owns them later. */
const templates: Record<string, Template> = {
  [NOTIFY.journalRejected]: {
    channels: ['PUSH', 'EMAIL'],
    critical: false,
    render: d => ({
      sms: `Your manual journal "${d.narration}" was rejected: ${d.reason}`,
      email: {
        subject: 'Your manual journal was rejected',
        text: `Your manual journal "${d.narration}" (${d.date}) was rejected: ${d.reason}. Open Accounts, Journals to create a corrected one.`,
      },
    }),
  },
};
registerTemplates(templates);
