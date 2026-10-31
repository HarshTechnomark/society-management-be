import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export class UserRecoveryCode extends Model<
  InferAttributes<UserRecoveryCode>,
  InferCreationAttributes<UserRecoveryCode>
> {
  declare id: number | undefined;
  declare userId: number;
  declare batchId: string;
  declare codeHash: string;
  declare usedAt: Date | null;
  declare usedSessionId: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    UserRecoveryCode.init(
      {
        id: idColumn,
        userId: fkColumn(false),
        batchId: { type: DataTypes.CHAR(26), allowNull: false },
        codeHash: { type: DataTypes.CHAR(64), allowNull: false },
        usedAt: dateColumn(),
        usedSessionId: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'user_recovery_codes' },
    );
  }
}
