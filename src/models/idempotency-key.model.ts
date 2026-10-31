import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

/** Module 01 section 7.4. */
export class IdempotencyKey extends Model<
  InferAttributes<IdempotencyKey>,
  InferCreationAttributes<IdempotencyKey>
> {
  declare id: number | undefined;
  declare userId: number;
  declare idemKey: string;
  declare societyId: number | null;
  declare method: string;
  declare path: string;
  declare requestHash: string;
  declare status: 'IN_PROGRESS' | 'COMPLETED';
  declare responseStatus: number | null;
  declare responseBody: unknown;
  declare expiresAt: Date;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    IdempotencyKey.init(
      {
        id: idColumn,
        userId: fkColumn(false),
        idemKey: { type: DataTypes.CHAR(36), allowNull: false },
        societyId: fkColumn(true),
        method: { type: DataTypes.STRING(8), allowNull: false },
        path: { type: DataTypes.STRING(200), allowNull: false },
        requestHash: { type: DataTypes.CHAR(64), allowNull: false },
        status: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'IN_PROGRESS' },
        responseStatus: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true, defaultValue: null },
        responseBody: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        expiresAt: dateColumn(false),
        ...timestampColumns,
      },
      { sequelize, tableName: 'idempotency_keys' },
    );
  }
}
