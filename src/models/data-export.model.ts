import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export type ExportKind = 'FULL' | 'CLOSURE';
export type ExportVia = 'SOCIETY' | 'PLATFORM' | 'SYSTEM';
export const EXPORT_STATUSES = ['QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/** Module 05 section 7.5. `runningLockSocietyId` is a generated column and is never written. Not paranoid. */
export class DataExport extends Model<InferAttributes<DataExport>, InferCreationAttributes<DataExport>> {
  declare id: number | undefined;
  declare societyId: number;
  declare kind: ExportKind;
  declare requestedVia: ExportVia;
  declare requestedByUserId: number | null;
  declare reason: string | null;
  declare includeDocuments: boolean;
  declare status: ExportStatus;
  declare progressPercent: number;
  declare fileIds: number[] | null;
  declare partCount: number;
  declare totalSizeBytes: number;
  declare manifestSummary: { tables: number; rows: number; documents: number } | null;
  declare attempts: number;
  declare errorCode: string | null;
  declare startedAt: Date | null;
  declare completedAt: Date | null;
  declare expiresAt: Date | null;
  declare downloadCount: number;
  declare lastDownloadedAt: Date | null;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    DataExport.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        kind: { type: DataTypes.STRING(20), allowNull: false },
        requestedVia: { type: DataTypes.STRING(20), allowNull: false },
        requestedByUserId: fkColumn(true),
        reason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        includeDocuments: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'QUEUED' },
        progressPercent: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        fileIds: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        partCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        totalSizeBytes: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        manifestSummary: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        attempts: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        errorCode: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        startedAt: dateColumn(),
        completedAt: dateColumn(),
        expiresAt: dateColumn(),
        downloadCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastDownloadedAt: dateColumn(),
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'data_exports' },
    );
  }
}
