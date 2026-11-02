/**
 * Module 05 integration: the export provider for the module 06 society tables (section 13, BR-05-22) and the retention
 * expiry handler (BR-05-38). Module 06 registers no purge handler: invoices, payments, credits and dunning events are
 * kept 8 years from the end of the financial year, even after the society was purged. `number_sequences` is global
 * platform numbering (society 0 series), so it is not society data and has no provider.
 */
import { QueryTypes } from 'sequelize';
import {
  DunningEvent,
  PlatformCredit,
  PlatformInvoice,
  PlatformInvoiceLine,
  PlatformPayment,
  sequelize,
} from '../../models';
import { registerExportProvider, type ExportProvider } from '../societies/societies.exports';
import { registerRetentionExpiryHandler } from '../societies/societies.purge';

const plain = (r: { get(o: { plain: true }): object }) => r.get({ plain: true }) as Record<string, unknown>;

async function* rowsOf<T extends { get(o: { plain: true }): object }>(
  load: () => Promise<T[]>,
  map: (row: Record<string, unknown>) => Record<string, unknown> = x => x,
) {
  for (const r of await load()) yield map(plain(r));
}

/** Internal columns a society never needs in its own export. */
const withoutInternal = (row: Record<string, unknown>): Record<string, unknown> => {
  const { bankRefKey: _k, ...rest } = row;
  void _k;
  return rest;
};

export const BILLING_EXPORT_PROVIDER: ExportProvider = {
  module: 'platform-billing',
  tables: [
    {
      name: 'platform_invoices',
      file: 'platform_invoices.csv',
      stream: id =>
        rowsOf(() => PlatformInvoice.findAll({ where: { societyId: id }, order: [['id', 'ASC']] })),
    },
    {
      name: 'platform_invoice_lines',
      file: 'platform_invoice_lines.csv',
      stream: id =>
        rowsOf(async () => {
          const ids = (await PlatformInvoice.findAll({ where: { societyId: id }, attributes: ['id'] })).map(
            i => i.id!,
          );
          return ids.length
            ? PlatformInvoiceLine.findAll({ where: { invoiceId: ids }, order: [['id', 'ASC']] })
            : [];
        }),
    },
    {
      name: 'platform_payments',
      file: 'platform_payments.csv',
      stream: id =>
        rowsOf(
          () => PlatformPayment.findAll({ where: { societyId: id }, order: [['id', 'ASC']] }),
          withoutInternal,
        ),
    },
    {
      name: 'platform_credits',
      file: 'platform_credits.csv',
      stream: id =>
        rowsOf(() => PlatformCredit.findAll({ where: { societyId: id }, order: [['id', 'ASC']] })),
    },
    {
      name: 'dunning_events',
      file: 'dunning_events.csv',
      stream: id => rowsOf(() => DunningEvent.findAll({ where: { societyId: id }, order: [['id', 'ASC']] })),
    },
  ],
};

/**
 * End of financial retention (BR-05-38): removes the society's rows with SQL, children first. The models forbid deletes on
 * purpose, so this is the only code path that removes them.
 */
export async function deleteRetainedBilling(societyId: number): Promise<{ deleted: number }> {
  return sequelize.transaction(async t => {
    const run = async (sql: string): Promise<number> => {
      const [, meta] = (await sequelize.query(sql, {
        replacements: { societyId },
        transaction: t,
        type: QueryTypes.RAW,
      })) as unknown as [unknown, { affectedRows?: number } | number];
      return typeof meta === 'number' ? meta : Number(meta?.affectedRows ?? 0);
    };
    let n = 0;
    n += await run('DELETE FROM dunning_events WHERE societyId = :societyId');
    n += await run('DELETE FROM platform_credits WHERE societyId = :societyId');
    n += await run(
      'DELETE FROM platform_payments WHERE societyId = :societyId AND sourcePaymentId IS NOT NULL',
    );
    n += await run('DELETE FROM platform_payments WHERE societyId = :societyId');
    n += await run(
      'DELETE l FROM platform_invoice_lines l JOIN platform_invoices i ON i.id = l.invoiceId WHERE i.societyId = :societyId',
    );
    n += await run(
      "DELETE FROM platform_invoices WHERE societyId = :societyId AND documentType = 'CREDIT_NOTE'",
    );
    n += await run('DELETE FROM platform_invoices WHERE societyId = :societyId');
    return { deleted: n };
  });
}

export function registerBillingRetention(): void {
  registerExportProvider(BILLING_EXPORT_PROVIDER);
  registerRetentionExpiryHandler({
    module: 'platform-billing',
    order: 6,
    deleteRetained: deleteRetainedBilling,
  });
}
