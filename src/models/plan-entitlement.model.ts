import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';

/** Module 04 section 7.3. One row per catalogue key per plan version. */
export class PlanEntitlement extends Model<
  InferAttributes<PlanEntitlement>,
  InferCreationAttributes<PlanEntitlement>
> {
  declare id: number | undefined;
  declare planVersionId: number;
  declare entitlementKey: string;
  declare kind: 'FEATURE' | 'LIMIT';
  declare isEnabled: boolean | null;
  declare limitValue: number | null;
  declare limitPerFlats: number | null;
  declare overageUnitSize: number | null;
  declare overagePricePaise: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    PlanEntitlement.init(
      {
        id: idColumn,
        planVersionId: fkColumn(false),
        entitlementKey: { type: DataTypes.STRING(80), allowNull: false },
        kind: { type: DataTypes.STRING(10), allowNull: false },
        isEnabled: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: null },
        limitValue: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true, defaultValue: null },
        limitPerFlats: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, defaultValue: null },
        overageUnitSize: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, defaultValue: null },
        overagePricePaise: { type: DataTypes.BIGINT, allowNull: true, defaultValue: null },
        ...timestampColumns,
      },
      { sequelize, tableName: 'plan_entitlements' },
    );
  }
}
