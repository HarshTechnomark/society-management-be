import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export class UserPasskey extends Model<InferAttributes<UserPasskey>, InferCreationAttributes<UserPasskey>> {
  declare id: number | undefined;
  declare userId: number;
  declare credentialId: string;
  declare publicKey: Buffer;
  declare signCount: number;
  declare transports: string[] | null;
  declare aaguid: string | null;
  declare deviceType: 'SINGLE_DEVICE' | 'MULTI_DEVICE';
  declare isBackedUp: boolean;
  declare name: string;
  declare lastUsedAt: Date | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    UserPasskey.init(
      {
        id: idColumn,
        userId: fkColumn(false),
        credentialId: { type: DataTypes.STRING(512), allowNull: false },
        publicKey: { type: DataTypes.BLOB, allowNull: false },
        signCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        transports: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        aaguid: { type: DataTypes.CHAR(36), allowNull: true, defaultValue: null },
        deviceType: { type: DataTypes.STRING(14), allowNull: false },
        isBackedUp: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        name: { type: DataTypes.STRING(60), allowNull: false },
        lastUsedAt: dateColumn(),
        ...timestampColumns,
      },
      { sequelize, tableName: 'user_passkeys' },
    );
  }
}
