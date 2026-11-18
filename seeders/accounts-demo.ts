import {
  BankAccount,
  BankStatementImport,
  Deposit,
  Expense,
  Fund,
  JournalEntry,
  LedgerAccount,
  Society,
  Unit,
  User,
} from '../src/models';
import { istDate, now } from '../src/lib/clock';
import { drainQueues } from '../src/lib/queue';
import { addDaysYmd } from '../src/modules/billing/billing.calc.period';
import { residents } from '../src/modules/residents/residents.public';
import { moneyTx } from '../src/modules/payments/payments.shared';
import { settleInput } from '../src/modules/payments/payments.settle';
import { putPlaceholderFile } from '../src/modules/society-setup/society-setup.ports';
import { createExpense } from '../src/modules/accounts/accounts.expenses.service';
import { decideAsCommittee } from '../src/modules/approvals/approvals.public';
import { createDraft } from '../src/modules/accounts/accounts.journal.service';
import { requestFundTransfer } from '../src/modules/accounts/accounts.funds.transfer';
import {
  createDeposit,
  depositSyncJob,
  getDeposit,
  markRefundPaid,
  requestDepositRefund,
} from '../src/modules/accounts/accounts.deposits.service';
import { importStatement } from '../src/modules/accounts/accounts.statements.service';
import { sampleStatementCsv } from '../src/modules/accounts/accounts.statements.sample';
import { systemCtx, type Ctx } from '../src/types/context';
import type { AccountsSeedReport } from './accounts';

/**
 * Module 13 demo data (not run in production; runs AFTER the payments seeders). Sky Heights CHS gets posted expenses (electricity,
 * security with TDS, lift AMC with GST, a repair paid from the repair fund), one expense left as a DRAFT (to submit in the browser), one DRAFT manual
 * journal, a renovation deposit held for one flat, an access card deposit refunded, a posted fund transfer and a PARSED bank
 * statement whose lines match the demo payments. Green Park CHS gets two posted expenses. Everything goes through the module's services
 * (never written by hand) as the society's chairman. Each piece is idempotent by its own marker, so a second run adds nothing.
 * The statement is the bank's view of the HDFC ledger from 3 days before the earliest bank posting of the demo data (`sampleStatementCsv`), so no book entry
 * predates it: opening = book balance at the start of the period (the opening entry), one line per bank posting with its own reference, signed running balance, closing = opening + credits - debits. Two lines are
 * deliberately not in the books: a bank charge of Rs 23.60 (debit) and an interest credit of Rs 1,042.00. Once every other line is matched the
 * BRS difference is statement minus books = +Rs 1,018.40 (1,042.00 - 23.60); it is 0 after the user creates the two entries.
 * Approvals go through the real module 14: small expenses auto-approve by the default rule (up to Rs 5,000), the others are
 * approved by the society's committee (`decideAsCommittee`: the treasurer, secretary or another eligible member, never the maker).
 */
const TAG = '[demo]';
const ymd = (daysAgo: number) => addDaysYmd(istDate(now()), -daysAgo);

interface World {
  slug: string;
  societyId: number;
  ctx: Ctx;
  userId: number;
  ledger: Record<string, number>;
  bankLedgerId: number;
  fundIds: Record<string, number>;
}

async function world(slug: string, report: AccountsSeedReport): Promise<World | null> {
  const society = await Society.findOne({ where: { slug } });
  const bank = society
    ? await BankAccount.findOne({ where: { societyId: Number(society.id), isCollectionAccount: true } })
    : null;
  const user = await User.findOne({
    where: { email: slug === 'sky-heights' ? 'chairman@skyheights.in' : 'suresh@greenpark.in' },
  });
  if (!society || !bank || !user) {
    report.skipped.push(`${slug} (no demo society, collection bank account or chairman)`);
    return null;
  }
  const societyId = Number(society.id);
  const ledgers = await LedgerAccount.findAll({ where: { societyId }, attributes: ['id', 'code'] });
  const funds = await Fund.findAll({ where: { societyId }, attributes: ['id', 'fundType'] });
  return {
    slug,
    societyId,
    userId: Number(user.id),
    ledger: Object.fromEntries(ledgers.map(l => [l.code, Number(l.id)])),
    bankLedgerId: Number(bank.ledgerAccountId),
    fundIds: Object.fromEntries(funds.map(f => [f.fundType, Number(f.id)])),
    ctx: {
      ...systemCtx('seed'),
      user: {
        id: Number(user.id),
        name: user.name,
        mobile: null,
        email: user.email,
        platformRoleId: null,
        status: 'ACTIVE',
      },
      society: { id: societyId, name: society.name, status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
    },
  };
}

interface ExpenseSpec {
  tag: string;
  daysAgo: number;
  payee: string;
  head: string;
  gross: number;
  gst?: number;
  tds?: number;
  tdsSection?: string;
  mode: 'NEFT' | 'UPI' | 'CASH';
  fund?: 'REPAIR';
  ref?: string;
  description: string;
  pending?: boolean;
}

async function expense(w: World, s: ExpenseSpec, report: AccountsSeedReport): Promise<void> {
  const description = `${TAG} ${s.description}`;
  if (await Expense.count({ where: { societyId: w.societyId, description } })) {
    report.skipped.push(`${w.slug} expense ${s.tag}`);
    return;
  }
  const file = putPlaceholderFile({
    societyId: w.societyId,
    ownerUserId: w.userId,
    name: `${s.tag}.jpg`,
    purpose: 'EXPENSE_BILL',
    content: Buffer.from('demo bill'),
  });
  const dto = await createExpense(w.ctx, {
    expenseType: 'DIRECT',
    expenseDate: ymd(s.daysAgo),
    payee: s.payee,
    ledgerAccountId: w.ledger[s.head]!,
    description,
    grossAmountPaise: s.gross,
    gstPaise: s.gst ?? 0,
    tdsPaise: s.tds ?? 0,
    tdsSection: s.tdsSection ?? null,
    challanNo: null,
    paidFromLedgerAccountId: s.mode === 'CASH' ? w.ledger['1120']! : w.bankLedgerId,
    paymentMode: s.mode,
    paymentReference: s.ref ?? null,
    fundId: s.fund ? (w.fundIds[s.fund] ?? null) : null,
    collectionId: null,
    vendorId: null,
    vendorBillId: null,
    fileIds: [file],
    // the demo 'pending' expense stays a DRAFT, to submit in the browser (module 14 then routes it to the inbox)
    submit: !s.pending,
  } as never);
  if (!s.pending) {
    const e = await Expense.findByPk(dto.id);
    if (e && e.status === 'PENDING_APPROVAL' && e.approvalRequestId)
      await decideAsCommittee(Number(e.approvalRequestId));
  }
  report.created.push(
    `${w.slug} expense ${s.tag}${s.pending ? ' (draft, submit it in the browser)' : ' (posted)'}`,
  );
}

async function draftJournal(w: World, report: AccountsSeedReport): Promise<void> {
  const narration = `${TAG} Reclassify lobby repainting from repairs to miscellaneous`;
  if (await JournalEntry.count({ where: { societyId: w.societyId, narration } })) {
    report.skipped.push(`${w.slug} draft journal`);
    return;
  }
  await createDraft(w.ctx, {
    date: ymd(2),
    voucherType: 'JOURNAL',
    narration,
    lines: [
      { ledgerAccountCode: '5990', debitPaise: 750_000, creditPaise: 0, lineNarration: 'Lobby repainting' },
      {
        ledgerAccountCode: '5300',
        debitPaise: 0,
        creditPaise: 750_000,
        lineNarration: 'Moved from civil repairs',
      },
    ],
  } as never);
  report.created.push(`${w.slug} draft journal`);
}

async function deposit(
  w: World,
  unit: Unit,
  kind: 'RENOVATION' | 'ACCESS_CARD',
  title: string,
  amount: number,
  refund: boolean,
  report: AccountsSeedReport,
): Promise<void> {
  const refId = Number(unit.id);
  if (await Deposit.count({ where: { societyId: w.societyId, refType: 'demo', refId, kind } })) {
    report.skipped.push(`${w.slug} ${kind} deposit ${unit.label}`);
    return;
  }
  const d = await createDeposit(w.ctx, {
    unitId: refId,
    kind,
    title,
    amountPaise: amount,
    dueDate: ymd(-7),
    refType: 'demo',
    refId,
  });
  const base = await Deposit.findByPk(d.id);
  await moneyTx(t =>
    settleInput(
      w.ctx,
      {
        societyId: w.societyId,
        unitId: refId,
        source: 'OFFLINE',
        method: 'CASH',
        status: 'CONFIRMED',
        payerUserId: null,
        payerName: 'Flat owner',
        amountPaise: amount,
        paymentDate: ymd(refund ? 25 : 10),
        referenceNo: null,
        referenceKey: `DEMO:DEP:${kind}:${unit.label}`,
        mode: 'SELECTED',
        selected: [{ targetType: 'INVOICE', id: Number(base!.invoiceId), amountPaise: amount }],
        notes: 'Demo deposit payment',
      },
      t,
    ),
  );
  await depositSyncJob({ societyId: w.societyId });
  if (refund) {
    let cur = await getDeposit(w.societyId, Number(d.id));
    cur = await requestDepositRefund(w.ctx, Number(d.id), { reason: 'Card returned', version: cur.version });
    await decideAsCommittee(Number(cur.refundApprovalRequestId));
    cur = await getDeposit(w.societyId, Number(d.id));
    await markRefundPaid(w.ctx, Number(d.id), {
      paidFromLedgerAccountId: w.ledger['1120']!,
      refundMode: 'CASH',
      date: ymd(3),
      version: cur.version,
    });
  }
  report.created.push(`${w.slug} ${kind} deposit ${unit.label} (${refund ? 'refunded' : 'held'})`);
}

async function transfer(w: World, report: AccountsSeedReport): Promise<void> {
  if (await JournalEntry.count({ where: { societyId: w.societyId, refType: 'fund_transfer' } })) {
    report.skipped.push(`${w.slug} fund transfer`);
    return;
  }
  const r = await requestFundTransfer(w.ctx, {
    fromFundId: w.fundIds['SINKING']!,
    toFundId: w.fundIds['REPAIR']!,
    amountPaise: 10_000_000,
    date: ymd(4),
    reason: `${TAG} Top up repair fund for the lift modernisation`,
  });
  if (r.status === 'PENDING') await decideAsCommittee(r.approvalRequestId);
  report.created.push(`${w.slug} fund transfer sinking to repair (Rs 1,00,000)`);
}

async function statement(w: World, report: AccountsSeedReport): Promise<void> {
  const bank = await BankAccount.findOne({ where: { societyId: w.societyId, isCollectionAccount: true } });
  if (await BankStatementImport.count({ where: { bankAccountId: Number(bank!.id) } })) {
    report.skipped.push(`${w.slug} bank statement`);
    return;
  }
  const { csv, lines } = await sampleStatementCsv(Number(bank!.id));
  const fileId = putPlaceholderFile({
    societyId: w.societyId,
    ownerUserId: w.userId,
    name: 'hdfc-statement-demo.csv',
    content: csv,
  });
  await importStatement(w.ctx, { bankAccountId: Number(bank!.id), fileId });
  await drainQueues();
  report.created.push(`${w.slug} bank statement (${lines} lines)`);
}

export async function seedAccountsDemo(): Promise<AccountsSeedReport> {
  if (process.env.NODE_ENV === 'production') throw new Error('accounts demo seed must not run in production');
  const report: AccountsSeedReport = { created: [], skipped: [] };
  const sky = await world('sky-heights', report);
  if (sky) {
    await expense(
      sky,
      {
        tag: 'electricity',
        daysAgo: 38,
        payee: 'MSEDCL',
        head: '5200',
        gross: 3_845_000,
        mode: 'NEFT',
        ref: 'UTR202610031122',
        description: 'Common area electricity bill',
      },
      report,
    );
    await expense(
      sky,
      {
        tag: 'security',
        daysAgo: 30,
        payee: 'Falcon Security Services',
        head: '5110',
        gross: 8_500_000,
        tds: 85_000,
        tdsSection: '194C',
        mode: 'NEFT',
        ref: 'UTR202610110457',
        description: 'Security guards monthly charges',
      },
      report,
    );
    await expense(
      sky,
      {
        tag: 'lift-amc',
        daysAgo: 22,
        payee: 'Otis Elevator Co',
        head: '5330',
        gross: 11_800_000,
        gst: 1_800_000,
        mode: 'NEFT',
        ref: 'UTR202610190733',
        description: 'Lift AMC quarterly with 18% GST',
      },
      report,
    );
    await expense(
      sky,
      {
        tag: 'repair',
        daysAgo: 15,
        payee: 'Shree Waterproofing Works',
        head: '5300',
        gross: 4_500_000,
        mode: 'NEFT',
        fund: 'REPAIR',
        ref: 'UTR202610260219',
        description: 'Terrace waterproofing, paid from the repair fund',
      },
      report,
    );
    await expense(
      sky,
      {
        tag: 'housekeeping',
        daysAgo: 1,
        payee: 'CleanPro Supplies',
        head: '5100',
        gross: 1_860_000,
        mode: 'UPI',
        ref: 'UPI202611160081',
        description: 'Housekeeping consumables for the quarter',
        pending: true,
      },
      report,
    );
    await transfer(sky, report);
    await draftJournal(sky, report);
    const all = await Unit.findAll({
      where: { societyId: sky.societyId, status: 'ACTIVE' },
      attributes: ['id', 'label'],
      order: [['label', 'ASC']],
      limit: 40,
    });
    const flats: Unit[] = [];
    for (const f of all) {
      if (flats.length === 2) break;
      if (await residents.billToFor(Number(f.id), istDate(now()))) flats.push(f);
    }
    if (flats[0])
      await deposit(
        sky,
        flats[0],
        'RENOVATION',
        'Renovation deposit, kitchen and bathroom',
        2_500_000,
        false,
        report,
      );
    if (flats[1]) await deposit(sky, flats[1], 'ACCESS_CARD', 'Access card deposit', 100_000, true, report);
    await statement(sky, report);
  }
  const green = await world('green-park', report);
  if (green) {
    await expense(
      green,
      {
        tag: 'electricity',
        daysAgo: 36,
        payee: 'MSEDCL',
        head: '5200',
        gross: 2_130_000,
        mode: 'NEFT',
        ref: 'UTR202610050911',
        description: 'Common area electricity bill',
      },
      report,
    );
    await expense(
      green,
      {
        tag: 'garden',
        daysAgo: 12,
        payee: 'Green Thumb Gardeners',
        head: '5350',
        gross: 650_000,
        mode: 'UPI',
        ref: 'UPI202611050042',
        description: 'Garden maintenance',
      },
      report,
    );
  }
  return report;
}
