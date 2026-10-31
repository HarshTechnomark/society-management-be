import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { fkColumn, idColumn, timestampColumns } from './_columns';

export class AuditLog extends Model<InferAttributes<AuditLog>, InferCreationAttributes<AuditLog>> {
  declare id: number | undefined;
  declare societyId: number | null;
  declare actorUserId: number | null;
  declare actorName: string;
  declare actorRole: string;
  declare supportGrantId: number | null;
  declare action: string;
  declare entityType: string;
  declare entityId: string;
  declare entityLabel: string | null;
  declare before: unknown;
  declare after: unknown;
  declare reason: string | null;
  declare ip: string | null;
  declare userAgent: string | null;
  declare requestId: string | null;
  declare createdAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    AuditLog.init(
      {
        id: idColumn,
        societyId: fkColumn(true),
        actorUserId: fkColumn(true),
        actorName: { type: DataTypes.STRING(120), allowNull: false },
        actorRole: { type: DataTypes.STRING(40), allowNull: false },
        supportGrantId: fkColumn(true),
        action: { type: DataTypes.STRING(80), allowNull: false },
        entityType: { type: DataTypes.STRING(40), allowNull: false },
        entityId: { type: DataTypes.STRING(60), allowNull: false },
        entityLabel: { type: DataTypes.STRING(200), allowNull: true, defaultValue: null },
        before: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        after: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        reason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        ip: { type: DataTypes.STRING(45), allowNull: true, defaultValue: null },
        userAgent: { type: DataTypes.STRING(255), allowNull: true, defaultValue: null },
        requestId: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        createdAt: timestampColumns.createdAt,
      },
      { sequelize, tableName: 'audit_logs', timestamps: true, updatedAt: false },
    );
    // Audit rows are append-only (BR-01-8).
    AuditLog.beforeUpdate(() => {
      throw new Error('audit_logs rows cannot be updated');
    });
    AuditLog.beforeDestroy(() => {
      throw new Error('audit_logs rows cannot be deleted');
    });
    AuditLog.beforeBulkUpdate(() => {
      throw new Error('audit_logs rows cannot be updated');
    });
    AuditLog.beforeBulkDestroy(() => {
      throw new Error('audit_logs rows cannot be deleted');
    });
  }
}
