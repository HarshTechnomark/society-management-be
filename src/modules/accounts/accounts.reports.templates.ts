import { registerTemplates, type NotifyChannel, type Template } from '../../lib/notify';

/** Notification template of 13.4b (section 10): the link opens the app, the file is never attached. Module 16 owns it later. */
const t = (channels: NotifyChannel[], render: Template['render']): Template => ({
  channels,
  critical: false,
  render,
});

registerTemplates({
  'accounts.export_ready': t(['EMAIL'], d => ({
    email: {
      subject: `Your ${d.reportTitle ?? 'report'} export is ready`,
      text: `Your ${d.reportTitle ?? 'report'} export (${String(d.format ?? '').toUpperCase()}) is ready. Open the app to download it.`,
    },
    link: String(d.link ?? '/accounts/reports'),
  })),
});
