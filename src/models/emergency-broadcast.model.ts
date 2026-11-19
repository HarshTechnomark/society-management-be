import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { EmergencyType, EmergencyStatus } from '../modules/communication/communication.constants';

/** Module 16 section 7.8: `emergency_broadcasts`. */
export class EmergencyBroadcast extends Model<
  InferAttributes<EmergencyBroadcast>,
  InferCreationAttributes<EmergencyBroadcast>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare type: EmergencyType;
  declare isDrill: CreationOptional<boolean>;
  declare title: string;
  declare message: string;
  declare audienceType: CreationOptional<string>;
  declare audienceBuildingIds: number[] | null;
  declare includeStaff: CreationOptional<boolean>;
  declare collectResponses: CreationOptional<boolean>;
  declare status: CreationOptional<EmergencyStatus>;
  declare sosAlertId: number | null;
  declare startedBy: number;
  declare startedAt: Date;
  declare updateCount: CreationOptional<number>;
  declare lastUpdateMessage: string | null;
  declare lastUpdateAt: Date | null;
  declare realertCount: CreationOptional<number>;
  declare lastRealertAt: Date | null;
  declare lastResolveReminderAt: Date | null;
  declare resolvedBy: number | null;
  declare resolvedAt: Date | null;
  declare allClearMessage: string | null;
  declare cancelledBy: number | null;
  declare cancelledAt: Date | null;
  declare cancelReason: string | null;
  declare recipientCount: CreationOptional<number>;
  declare unitCount: CreationOptional<number>;
  declare safeCount: CreationOptional<number>;
  declare helpCount: CreationOptional<number>;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    EmergencyBroadcast.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        type: { type: DataTypes.STRING(20), allowNull: false },
        isDrill: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        title: { type: DataTypes.STRING(120), allowNull: false },
        message: { type: DataTypes.STRING(500), allowNull: false },
        audienceType: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ALL' },
        audienceBuildingIds: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        includeStaff: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        collectResponses: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'ACTIVE' },
        sosAlertId: fkColumn(true),
        startedBy: fkColumn(false),
        startedAt: dateColumn(false),
        updateCount: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastUpdateMessage: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        lastUpdateAt: dateColumn(),
        realertCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastRealertAt: dateColumn(),
        lastResolveReminderAt: dateColumn(),
        resolvedBy: fkColumn(true),
        resolvedAt: dateColumn(),
        allClearMessage: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        cancelledBy: fkColumn(true),
        cancelledAt: dateColumn(),
        cancelReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        recipientCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        unitCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        safeCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        helpCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'emergency_broadcasts' },
    );
  }
}
