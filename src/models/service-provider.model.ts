import {
  DataTypes,
  Model,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export const PROVIDER_CHANNELS = [
  'SMS',
  'WHATSAPP',
  'EMAIL',
  'PUSH',
  'PAYMENT_GATEWAY',
  'STORAGE',
  'IVR',
] as const;
export const PROVIDER_VENDORS = [
  'MSG91',
  'GUPSHUP',
  'KALEYRA',
  'META_CLOUD',
  'AWS_SES',
  'SENDGRID',
  'WEB_PUSH_VAPID',
  'RAZORPAY',
  'CASHFREE',
  'S3_COMPATIBLE',
  'EXOTEL',
  'FAKE',
] as const;
export const PROVIDER_HEALTH = ['OPERATIONAL', 'DEGRADED', 'OUTAGE', 'UNKNOWN'] as const;
export type ProviderChannel = (typeof PROVIDER_CHANNELS)[number];
export type ProviderVendor = (typeof PROVIDER_VENDORS)[number];
export type ProviderHealth = (typeof PROVIDER_HEALTH)[number];

const SECRET_COLUMNS = ['credentialsEnc', 'credentialsIv', 'credentialsTag'] as const;

/**
 * Module 07 section 7.4. The default scope leaves out the three ciphertext columns; only the provider credentials
 * service uses `ServiceProvider.scope('withSecrets')`.
 */
export class ServiceProvider extends Model<
  InferAttributes<ServiceProvider>,
  InferCreationAttributes<ServiceProvider>
> {
  declare id: number | undefined;
  declare providerKey: string;
  declare channel: ProviderChannel;
  declare vendor: ProviderVendor;
  declare displayName: string;
  declare description: string | null;
  declare isEnabled: boolean;
  declare priority: number | null;
  declare credentialsSource: 'DATABASE' | 'ENV';
  declare configJson: Record<string, unknown>;
  declare credentialsEnc: Buffer | null | undefined;
  declare credentialsIv: Buffer | null | undefined;
  declare credentialsTag: Buffer | null | undefined;
  declare credentialsKeyVersion: number | null;
  declare credentialsMasked: Record<string, string> | null;
  declare credentialsUpdatedAt: Date | null;
  declare credentialsUpdatedBy: number | null;
  declare healthStatus: ProviderHealth;
  declare statusMode: 'AUTOMATIC' | 'MANUAL';
  declare statusReason: string | null;
  declare statusChangedAt: Date | null;
  declare consecutiveFailures: number;
  declare degradedLatencyMs: number;
  declare lastCheckAt: Date | null;
  declare lastCheckOk: boolean | null;
  declare lastCheckLatencyMs: number | null;
  declare lastCheckError: string | null;
  declare uptime30dPct: string | null;
  declare lastTestAt: Date | null;
  declare lastTestOk: boolean | null;
  declare lastTestBy: number | null;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: Date | undefined;
  declare updatedAt: Date | undefined;
  declare deletedAt: Date | null | undefined;

  static initModel(sequelize: Sequelize): void {
    ServiceProvider.init(
      {
        id: idColumn,
        providerKey: { type: DataTypes.STRING(40), allowNull: false },
        channel: { type: DataTypes.STRING(20), allowNull: false },
        vendor: { type: DataTypes.STRING(20), allowNull: false },
        displayName: { type: DataTypes.STRING(80), allowNull: false },
        description: { type: DataTypes.STRING(200), allowNull: true, defaultValue: null },
        isEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        priority: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true, defaultValue: null },
        credentialsSource: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'DATABASE' },
        configJson: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
        credentialsEnc: { type: DataTypes.BLOB, allowNull: true, defaultValue: null },
        credentialsIv: { type: DataTypes.BLOB, allowNull: true, defaultValue: null },
        credentialsTag: { type: DataTypes.BLOB, allowNull: true, defaultValue: null },
        credentialsKeyVersion: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true, defaultValue: null },
        credentialsMasked: { type: DataTypes.JSON, allowNull: true, defaultValue: null },
        credentialsUpdatedAt: dateColumn(),
        credentialsUpdatedBy: fkColumn(true),
        healthStatus: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'UNKNOWN' },
        statusMode: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'AUTOMATIC' },
        statusReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        statusChangedAt: dateColumn(),
        consecutiveFailures: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        degradedLatencyMs: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 3000 },
        lastCheckAt: dateColumn(),
        lastCheckOk: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: null },
        lastCheckLatencyMs: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, defaultValue: null },
        lastCheckError: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        uptime30dPct: { type: DataTypes.DECIMAL(6, 3), allowNull: true, defaultValue: null },
        lastTestAt: dateColumn(),
        lastTestOk: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: null },
        lastTestBy: fkColumn(true),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
        deletedAt: dateColumn(),
      },
      {
        sequelize,
        tableName: 'service_providers',
        paranoid: true,
        defaultScope: { attributes: { exclude: [...SECRET_COLUMNS] } },
        scopes: { withSecrets: { attributes: { include: [...SECRET_COLUMNS] } } },
      },
    );
  }
}
