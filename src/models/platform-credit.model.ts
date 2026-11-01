import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export const CREDIT_ENTRY_TYPES = [
  'GOODWILL',
  'PAYMENT_EXCESS',
  'CREDIT_NOTE',
  'APPLIED',
  'REFUND',
  'REFUND_REVERSED',
] as const;
export type CreditEntryType = (typeof CREDIT_ENTRY_TYPES)[number];
export const CREDIT_STATUSES = ['PENDING_APPROVAL', 'POSTED', 'REJECTED'] as const;
export type CreditStatus = (typeof CREDIT_STATUSES)[number];

/** Columns that may change while deciding a pending goodwill credit (section 6.4). */
const DECISION_COLUMNS: ReadonlySet<string> = new Set([
  'status',
  'balanceAfterPaise',
  'postedAt',
  'approvedBy',
  'approvedAt',
  'rejectedReason',
  'updatedBy',
  'version',
  'updatedAt',
]);

/** Why an update of a credit row is refused, or null when it is the allowed PENDING_APPROVAL → POSTED/REJECTED decision. */
export function creditUpdateError(c: PlatformCredit): string | null {
  if (c.previous('status') !== 'PENDING_APPROVAL') return 'only a PENDING_APPROVAL credit can change';
  if (c.status !== 'POSTED' && c.status !== 'REJECTED')
    return 'a pending credit can only become POSTED or REJECTED';
  const bad = (c.changed() || []).filter(k => !DECISION_COLUMNS.has(k));
  return bad.length ? `columns cannot change: ${bad.join(', ')}` : null;
}

/** Module 06 section 7.4. Append-only ledger; the society balance is the latest POSTED `balanceAfterPaise` (BR-06-25). */
export class PlatformCredit extends Model<
  InferAttributes<PlatformCredit>,
  InferCreationAttributes<PlatformCredit>
> {
  declare id: number | undefined;
  declare societyId: number;
  declare entryType: CreditEntryType;
  declare status: CreditStatus;
  declare amountPaise: number;
  declare balanceAfterPaise: number | null;
  declare invoiceId: number | null;
  declare paymentId: number | null;
  declare reason: string | null;
  declare postedAt: Date | null;
  declare approvedBy: number | null;
  declare approvedAt: Date | null;
  declare rejectedReason: string | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    PlatformCredit.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        entryType: { type: DataTypes.STRING(20), allowNull: false },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'POSTED' },
        amountPaise: { type: DataTypes.BIGINT, allowNull: false },
        balanceAfterPaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        invoiceId: fkColumn(true),
        paymentId: fkColumn(true),
        reason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        postedAt: dateColumn(),
        approvedBy: fkColumn(true),
        approvedAt: dateColumn(),
        rejectedReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        ...timestampColumns,
      },
      {
        sequelize,
        tableName: 'platform_credits',
        hooks: {
          beforeUpdate: c => {
            const err = creditUpdateError(c);
            if (err) throw new Error(`platform_credits: ${err}`);
          },
          beforeBulkUpdate: options => {
            options.individualHooks = true;
          },
          beforeDestroy: () => {
            throw new Error('platform_credits is append-only');
          },
          beforeBulkDestroy: () => {
            throw new Error('platform_credits is append-only');
          },
        },
      },
    );
  }
}
