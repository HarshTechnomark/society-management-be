import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type { ResponseStatus, ResponseChannel } from '../modules/communication/communication.constants';

/** Module 16 section 7.9: `emergency_responses`. */
export class EmergencyResponse extends Model<
  InferAttributes<EmergencyResponse>,
  InferCreationAttributes<EmergencyResponse>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare broadcastId: number;
  declare subjectKey: string;
  declare unitId: number | null;
  declare userId: number | null;
  declare recordedBy: number;
  declare status: ResponseStatus;
  declare peopleCount: CreationOptional<number>;
  declare note: string | null;
  declare channel: ResponseChannel;
  declare isLatest: CreationOptional<boolean>;
  declare attendedBy: number | null;
  declare attendedAt: Date | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    EmergencyResponse.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        broadcastId: fkColumn(false),
        subjectKey: { type: DataTypes.STRING(40), allowNull: false },
        unitId: fkColumn(true),
        userId: fkColumn(true),
        recordedBy: fkColumn(false),
        status: { type: DataTypes.STRING(10), allowNull: false },
        peopleCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 1 },
        note: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        channel: { type: DataTypes.STRING(12), allowNull: false },
        isLatest: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        attendedBy: fkColumn(true),
        attendedAt: dateColumn(),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'emergency_responses' },
    );
  }
}
