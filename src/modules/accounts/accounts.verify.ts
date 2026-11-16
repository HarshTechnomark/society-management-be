import { QueryTypes } from 'sequelize';
import { logger } from '../../lib/logger';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { sequelize } from '../../models';
import { systemCtx } from '../../types/context';
import { AUDIT, NOTIFY } from './accounts.constants';
import { lockBooks } from './accounts.chart';
import { accountsPorts } from './accounts.ports';
import { n } from './accounts.shared';

export interface DriftReport {
  societyId: number;
  corrected: boolean;
  ledgerDrift: { ledgerAccountId: number; code: string; stored: number; rebuilt: number }[];
  figuresBefore: Record<string, number>;
  figuresAfter: Record<string, number>;
}

const FIGURES = [
  'inBankPaise',
  'clearingPaise',
  'cashPaise',
  'chequesPaise',
  'totalPaise',
  'investmentsPaise',
  'earmarkedFundsPaise',
] as const;

/**
 * F23, job `accounts:balance-verify`: rebuilds every ledger balance from POSTED lines and the society balance figures from them, compares
 * with the stored values and, on drift, corrects the stored rows in one transaction, audits `accounts.balance.drift_corrected` with
 * before and after, logs at `error` and tells the Treasurer and Chairman. Returns null when nothing drifted.
 */
export async function verifyBalances(societyId: number): Promise<DriftReport | null> {
  const report = await sequelize.transaction(async t => {
    const books = await lockBooks(t, societyId);
    const rebuilt = await sequelize.query<{
      id: number;
      code: string;
      subtype: string;
      stored: string;
      real: string;
    }>(
      `SELECT a.id, a.code, a.subtype, a.balancePaise AS storedPaise,
              COALESCE(SUM(CASE WHEN e.status = 'POSTED' THEN l.debitPaise - l.creditPaise END), 0) AS rebuiltPaise
         FROM ledger_accounts a
         LEFT JOIN journal_lines l ON l.ledgerAccountId = a.id
         LEFT JOIN journal_entries e ON e.id = l.journalEntryId
        WHERE a.societyId = :societyId GROUP BY a.id, a.code, a.subtype, a.balancePaise`,
      { replacements: { societyId }, type: QueryTypes.SELECT, transaction: t },
    );
    const fig = { inBank: 0, clearing: 0, cash: 0, cheques: 0, investments: 0, earmarked: 0 };
    const drift: DriftReport['ledgerDrift'] = [];
    for (const r of rebuilt) {
      const real = n(r.rebuiltPaise);
      if (real !== n(r.storedPaise))
        drift.push({ ledgerAccountId: n(r.id), code: r.code, stored: n(r.storedPaise), rebuilt: real });
      switch (r.subtype) {
        case 'BANK':
          fig.inBank += real;
          break;
        case 'CLEARING':
          fig.clearing += real;
          break;
        case 'CASH':
        case 'PETTY_CASH':
          fig.cash += real;
          break;
        case 'CHEQUES':
          fig.cheques += real;
          break;
        case 'INVESTMENT':
          fig.investments += real;
          break;
        case 'FUND':
          fig.earmarked -= real;
          break;
        default:
      }
    }
    const after = {
      inBankPaise: fig.inBank,
      clearingPaise: fig.clearing,
      cashPaise: fig.cash,
      chequesPaise: fig.cheques,
      totalPaise: fig.inBank + fig.clearing + fig.cash + fig.cheques,
      investmentsPaise: fig.investments,
      earmarkedFundsPaise: fig.earmarked,
    };
    const before = Object.fromEntries(FIGURES.map(f => [f, n(books[f])])) as Record<string, number>;
    const figuresDrift = FIGURES.some(f => before[f] !== after[f]);
    books.lastVerifiedAt = now();
    if (!drift.length && !figuresDrift) {
      await books.save({ transaction: t });
      return null;
    }
    for (const d of drift)
      await sequelize.query('UPDATE ledger_accounts SET balancePaise = :v WHERE id = :id', {
        replacements: { v: d.rebuilt, id: d.ledgerAccountId },
        transaction: t,
      });
    // `totalPaise` has a CHECK on the four figures: write all of them in one statement
    Object.assign(books, after);
    await books.save({ transaction: t });
    await audit(
      systemCtx('accounts:balance-verify'),
      {
        action: AUDIT.balanceDriftCorrected,
        entityType: 'society_balance',
        entityId: n(books.id),
        societyId,
        before: { figures: before, ledgers: drift.map(d => ({ code: d.code, balancePaise: d.stored })) },
        after: { figures: after, ledgers: drift.map(d => ({ code: d.code, balancePaise: d.rebuilt })) },
      },
      t,
    );
    return {
      societyId,
      corrected: true,
      ledgerDrift: drift,
      figuresBefore: before,
      figuresAfter: after,
    } as DriftReport;
  });
  if (report) {
    logger.error({ societyId, ledgers: report.ledgerDrift.length }, 'accounts balance drift corrected');
    const users = await sequelize.query<{ userId: number }>(
      `SELECT DISTINCT m.userId FROM society_members m JOIN roles r ON r.id = m.roleId
        WHERE m.societyId = :societyId AND m.status = 'ACTIVE' AND r.\`key\` IN ('treasurer', 'chairman')`,
      { replacements: { societyId }, type: QueryTypes.SELECT },
    );
    await accountsPorts().notifications.send(
      NOTIFY.balanceDrift,
      users.map(u => n(u.userId)),
      { societyId, ledgers: report.ledgerDrift.length },
    );
  }
  return report;
}

/** Job body: one society when `societyId` is given, else every society that has books (the daily dispatcher). */
export async function verifyJob(data: Record<string, unknown>): Promise<number> {
  const ids = data.societyId
    ? [Number(data.societyId)]
    : (
        await sequelize.query<{ societyId: number }>(
          'SELECT societyId FROM society_balances WHERE chartSeededAt IS NOT NULL ORDER BY societyId',
          { type: QueryTypes.SELECT },
        )
      ).map(r => n(r.societyId));
  let drifted = 0;
  for (const id of ids) if (await verifyBalances(id)) drifted += 1;
  return drifted;
}
