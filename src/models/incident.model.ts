import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export const INCIDENT_SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'] as const;
export const INCIDENT_STATUSES = ['INVESTIGATING', 'IDENTIFIED', 'MONITORING', 'RESOLVED'] as const;
export const INCIDENT_SOURCES = ['MANUAL', 'PROVIDER_AUTO', 'PROVIDER_MANUAL'] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export interface IncidentUpdate {
  at: string;
  status: IncidentStatus;
  message: string;
  isPublic: boolean;
  byUserId: number | null;
  byName: string;
}

/** Module 07 section 7.5. Not paranoid. `updates` is an append-only display timeline. */
export class Incident extends Model<InferAttributes<Incident>, InferCreationAttributes<Incident>> {
  declare id: number | undefined;
  declare title: string;
  declare severity: IncidentSeverity;
  declare status: IncidentStatus;
  declare components: string[];
  declare serviceProviderId: number | null;
  declare source: (typeof INCIDENT_SOURCES)[number];
  declare isPublic: boolean;
  declare updates: IncidentUpdate[];
  declare startedAt: Date;
  declare identifiedAt: Date | null;
  declare monitoringAt: Date | null;
  declare resolvedAt: Date | null;
  declare durationMinutes: number | null;
  declare rootCause: string | null;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;

  static initModel(sequelize: Sequelize): void {
    Incident.init(
      {
        id: idColumn,
        title: { type: DataTypes.STRING(150), allowNull: false },
        severity: { type: DataTypes.STRING(5), allowNull: false },
        status: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'INVESTIGATING' },
        components: { type: DataTypes.JSON, allowNull: false },
        serviceProviderId: fkColumn(true),
        source: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'MANUAL' },
        isPublic: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        updates: { type: DataTypes.JSON, allowNull: false, defaultValue: [] },
        startedAt: dateColumn(false),
        identifiedAt: dateColumn(),
        monitoringAt: dateColumn(),
        resolvedAt: dateColumn(),
        durationMinutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, defaultValue: null },
        rootCause: { type: DataTypes.STRING(2000), allowNull: true, defaultValue: null },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'incidents' },
    );
  }
}
