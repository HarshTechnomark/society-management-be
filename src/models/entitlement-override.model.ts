import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

/** Module 04 section 7.7. `liveTarget` is a generated column and is never written. Rows are never deleted. */
export class EntitlementOverride extends Model<
  InferAttributes<EntitlementOverride>,
  InferCreationAttributes<EntitlementOverride>
> {
  declare id: number | undefined;
  declare societyId: number;
  declare targetType: 'KEY' | 'MODULE';
  declare entitlementKey: string | null;
  declare moduleNo: number | null;
  declare isEnabled: boolean | null;
  declare limitValue: number | null;
  declare isUnlimited: boolean;
  declare source: 'CONTRACT' | 'SUPPORT' | 'PREMIUM_TRIAL' | 'PROMOTION';
  declare reason: string;
  declare startsAt: Date;
  declare expiresAt: Date | null;
  declare revokedAt: Date | null;
  declare revokedBy: number | null;
  declare revokeReason: string | null;
  declare expiryProcessedAt: Date | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    EntitlementOverride.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        targetType: { type: DataTypes.STRING(10), allowNull: false },
        entitlementKey: { type: DataTypes.STRING(80), allowNull: true, defaultValue: null },
        moduleNo: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true, defaultValue: null },
        isEnabled: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: null },
        limitValue: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, defaultValue: null },
        isUnlimited: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        source: { type: DataTypes.STRING(20), allowNull: false },
        reason: { type: DataTypes.STRING(500), allowNull: false },
        startsAt: dateColumn(false),
        expiresAt: dateColumn(),
        revokedAt: dateColumn(),
        revokedBy: fkColumn(true),
        revokeReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        expiryProcessedAt: dateColumn(),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        ...timestampColumns,
      },
      { sequelize, tableName: 'entitlement_overrides' },
    );
  }
}
