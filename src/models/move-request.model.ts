import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

/** Module 09 section 7.6. Part 1 creates the table; move requests are part 2. `openSlot` and `passSlot` are generated. */
export class MoveRequest extends Model<InferAttributes<MoveRequest>, InferCreationAttributes<MoveRequest>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare unitId: number;
  declare buildingId: number;
  declare type: 'MOVE_IN' | 'MOVE_OUT';
  declare householdOf: 'OWNER' | 'TENANT';
  declare tenancyId: number | null;
  declare requestedByResidentId: number | null;
  declare moveDate: string;
  declare slotStart: string;
  declare slotEnd: string;
  declare liftLabel: string | null;
  declare vehicleNumber: string | null;
  declare moverCompany: string | null;
  declare moverMobile: string | null;
  declare helperCount: number | null;
  declare itemsNote: string | null;
  declare status: string;
  declare ownerConfirmedBy: number | null;
  declare ownerConfirmedAt: Date | null;
  declare duesCheckedAt: Date | null;
  declare duesBalancePaise: number | string;
  declare duesOverrideBy: number | null;
  declare duesOverrideReason: string | null;
  declare depositPaise: number | string;
  declare depositId: number | null;
  declare depositPaidAt: Date | null;
  declare approvalRequestId: number | null;
  declare decidedAt: Date | null;
  declare decisionReason: string | null;
  declare gatePassCode: string | null;
  declare startedAt: Date | null;
  declare startedBy: number | null;
  declare completedAt: Date | null;
  declare completedBy: number | null;
  declare completionNote: string | null;
  declare inspectionStatus: string;
  declare damageDeductionPaise: number | string;
  declare inspectionNote: string | null;
  declare depositRefundDueOn: string | null;
  declare depositRefundRequestedAt: Date | null;
  declare cancelledAt: Date | null;
  declare cancelReason: string | null;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    MoveRequest.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        unitId: fkColumn(false),
        buildingId: fkColumn(false),
        type: { type: DataTypes.STRING(8), allowNull: false },
        householdOf: { type: DataTypes.STRING(6), allowNull: false },
        tenancyId: fkColumn(true),
        requestedByResidentId: fkColumn(true),
        moveDate: { type: DataTypes.DATEONLY, allowNull: false },
        slotStart: { type: DataTypes.TIME, allowNull: false },
        slotEnd: { type: DataTypes.TIME, allowNull: false },
        liftLabel: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        vehicleNumber: { type: DataTypes.STRING(12), allowNull: true, defaultValue: null },
        moverCompany: { type: DataTypes.STRING(150), allowNull: true, defaultValue: null },
        moverMobile: { type: DataTypes.CHAR(10), allowNull: true, defaultValue: null },
        helperCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true, defaultValue: null },
        itemsNote: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        status: { type: DataTypes.STRING(16), allowNull: false },
        ownerConfirmedBy: fkColumn(true),
        ownerConfirmedAt: dateColumn(),
        duesCheckedAt: dateColumn(),
        duesBalancePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        duesOverrideBy: fkColumn(true),
        duesOverrideReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        depositPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        depositId: fkColumn(true),
        depositPaidAt: dateColumn(),
        approvalRequestId: fkColumn(true),
        decidedAt: dateColumn(),
        decisionReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        gatePassCode: { type: DataTypes.CHAR(8), allowNull: true, defaultValue: null },
        startedAt: dateColumn(),
        startedBy: fkColumn(true),
        completedAt: dateColumn(),
        completedBy: fkColumn(true),
        completionNote: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        inspectionStatus: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'NOT_REQUIRED' },
        damageDeductionPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        inspectionNote: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        depositRefundDueOn: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        depositRefundRequestedAt: dateColumn(),
        cancelledAt: dateColumn(),
        cancelReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'move_requests' },
    );
  }
}
