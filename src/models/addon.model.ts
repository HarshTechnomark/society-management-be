import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';

export type AddonGrantRow =
  | { type: 'FEATURE'; key: string }
  | { type: 'LIMIT_INCREMENT'; key: string; amount: number }
  | { type: 'FEATURE_CHOICE' };

/** Module 04 section 7.4. Add-ons are never deleted; they are taken off sale. */
export class Addon extends Model<InferAttributes<Addon>, InferCreationAttributes<Addon>> {
  declare id: number | undefined;
  declare code: string;
  declare name: string;
  declare description: string | null;
  declare billingType: 'ONE_TIME' | 'RECURRING';
  declare grants: AddonGrantRow[];
  declare pricePaise: number;
  declare minTierRank: number;
  declare maxTierRank: number;
  declare maxQuantity: number;
  declare isOnSale: boolean;
  declare sortOrder: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare version: number;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    Addon.init(
      {
        id: idColumn,
        code: { type: DataTypes.STRING(40), allowNull: false },
        name: { type: DataTypes.STRING(80), allowNull: false },
        description: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        billingType: { type: DataTypes.STRING(10), allowNull: false },
        grants: { type: DataTypes.JSON, allowNull: false },
        pricePaise: { type: DataTypes.BIGINT, allowNull: false },
        minTierRank: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 1 },
        maxTierRank: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 4 },
        maxQuantity: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 1 },
        isOnSale: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        sortOrder: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        ...timestampColumns,
      },
      { sequelize, tableName: 'addons' },
    );
  }
}
