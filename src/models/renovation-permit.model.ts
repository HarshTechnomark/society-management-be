import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

/** Module 09 section 7.7. Part 1 creates the table; renovation permits are part 3. `openSlot` is generated. */
export class RenovationPermit extends Model<
  InferAttributes<RenovationPermit>,
  InferCreationAttributes<RenovationPermit>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare unitId: number;
  declare requestedByResidentId: number | null;
  declare workCategory: string;
  declare workDescription: string;
  declare involvesStructuralChange: boolean;
  declare contractorName: string;
  declare contractorCompany: string | null;
  declare contractorMobile: string;
  declare workerCount: number;
  declare startDate: string;
  declare endDate: string;
  declare originalEndDate: string;
  declare dailyStartTime: string;
  declare dailyEndTime: string;
  declare conditions: string | null;
  declare status: string;
  declare depositPaise: number | string;
  declare depositId: number | null;
  declare depositPaidAt: Date | null;
  declare feePaise: number | string;
  declare feeInvoiceId: number | null;
  declare approvalRequestId: number | null;
  declare decidedAt: Date | null;
  declare decisionReason: string | null;
  declare startedAt: Date | null;
  declare workDoneAt: Date | null;
  declare inspectedAt: Date | null;
  declare inspectedBy: number | null;
  declare inspectionResult: 'PASSED' | 'FAILED' | null;
  declare inspectionNote: string | null;
  declare damageDeductionPaise: number | string;
  declare violationCount: number;
  declare lastViolationAt: Date | null;
  declare lastViolationCategory: string | null;
  declare lastViolationNote: string | null;
  declare suspendedAt: Date | null;
  declare suspendReason: string | null;
  declare extensionCount: number;
  declare completedAt: Date | null;
  declare depositRefundRequestedAt: Date | null;
  declare cancelledAt: Date | null;
  declare cancelReason: string | null;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    RenovationPermit.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        unitId: fkColumn(false),
        requestedByResidentId: fkColumn(true),
        workCategory: { type: DataTypes.STRING(16), allowNull: false },
        workDescription: { type: DataTypes.STRING(1000), allowNull: false },
        involvesStructuralChange: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        contractorName: { type: DataTypes.STRING(120), allowNull: false },
        contractorCompany: { type: DataTypes.STRING(150), allowNull: true, defaultValue: null },
        contractorMobile: { type: DataTypes.CHAR(10), allowNull: false },
        workerCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
        startDate: { type: DataTypes.DATEONLY, allowNull: false },
        endDate: { type: DataTypes.DATEONLY, allowNull: false },
        originalEndDate: { type: DataTypes.DATEONLY, allowNull: false },
        dailyStartTime: { type: DataTypes.TIME, allowNull: false },
        dailyEndTime: { type: DataTypes.TIME, allowNull: false },
        conditions: { type: DataTypes.STRING(1000), allowNull: true, defaultValue: null },
        status: { type: DataTypes.STRING(18), allowNull: false },
        depositPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        depositId: fkColumn(true),
        depositPaidAt: dateColumn(),
        feePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        feeInvoiceId: fkColumn(true),
        approvalRequestId: fkColumn(true),
        decidedAt: dateColumn(),
        decisionReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        startedAt: dateColumn(),
        workDoneAt: dateColumn(),
        inspectedAt: dateColumn(),
        inspectedBy: fkColumn(true),
        inspectionResult: { type: DataTypes.STRING(6), allowNull: true, defaultValue: null },
        inspectionNote: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        damageDeductionPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        violationCount: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastViolationAt: dateColumn(),
        lastViolationCategory: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        lastViolationNote: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        suspendedAt: dateColumn(),
        suspendReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        extensionCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        completedAt: dateColumn(),
        depositRefundRequestedAt: dateColumn(),
        cancelledAt: dateColumn(),
        cancelReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'renovation_permits' },
    );
  }
}
