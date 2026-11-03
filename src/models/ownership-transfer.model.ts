import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export interface TransferBuyer {
  residentId: number;
  sharePercent: string;
  isPrimary: boolean;
  isResiding: boolean;
}
export interface TransferSeller {
  linkId: number;
  residentId: number;
  relation: string;
  sharePercent: string | null;
}

/** Module 09 section 7.8. Part 1 creates the table (links point at it); ownership transfers are part 3. `openSlot` is generated. */
export class OwnershipTransfer extends Model<
  InferAttributes<OwnershipTransfer>,
  InferCreationAttributes<OwnershipTransfer>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare unitId: number;
  declare transferType: string;
  declare status: string;
  declare effectiveDate: string;
  declare deedRegistrationNo: string | null;
  declare deedDate: string | null;
  declare considerationPaise: number | string;
  declare buyersJson: TransferBuyer[];
  declare sellersJson: TransferSeller[] | null;
  declare transferPremiumPaise: number | string;
  declare shareTransferFeePaise: number | string;
  declare entranceFeePaise: number | string;
  declare newBuyerCount: number;
  declare totalFeesPaise: number | string;
  declare feesRaisedAt: Date | null;
  declare duesPolicy: 'MUST_CLEAR' | 'CARRY_WITH_UNIT';
  declare endTenancy: boolean;
  declare balanceAtSubmitPaise: number | string;
  declare initiatedByResidentId: number | null;
  declare approvalRequestId: number | null;
  declare submittedAt: Date | null;
  declare decidedAt: Date | null;
  declare decisionReason: string | null;
  declare completedAt: Date | null;
  declare completedBy: number | null;
  declare shareCertificateHandoffAt: Date | null;
  declare cancelledAt: Date | null;
  declare cancelReason: string | null;
  declare notes: string | null;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    OwnershipTransfer.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        unitId: fkColumn(false),
        transferType: { type: DataTypes.STRING(18), allowNull: false },
        status: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'DRAFT' },
        effectiveDate: { type: DataTypes.DATEONLY, allowNull: false },
        deedRegistrationNo: { type: DataTypes.STRING(60), allowNull: true, defaultValue: null },
        deedDate: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        considerationPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        buyersJson: { type: DataTypes.JSON, allowNull: false },
        sellersJson: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        transferPremiumPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        shareTransferFeePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        entranceFeePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        newBuyerCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        totalFeesPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        feesRaisedAt: dateColumn(),
        duesPolicy: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'MUST_CLEAR' },
        endTenancy: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        balanceAtSubmitPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        initiatedByResidentId: fkColumn(true),
        approvalRequestId: fkColumn(true),
        submittedAt: dateColumn(),
        decidedAt: dateColumn(),
        decisionReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        completedAt: dateColumn(),
        completedBy: fkColumn(true),
        shareCertificateHandoffAt: dateColumn(),
        cancelledAt: dateColumn(),
        cancelReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        notes: { type: DataTypes.STRING(1000), allowNull: true, defaultValue: null },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'ownership_transfers' },
    );
  }
}
