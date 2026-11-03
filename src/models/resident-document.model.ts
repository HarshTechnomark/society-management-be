import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

/** Module 09 section 7.4: KYC and request documents (metadata). Paranoid. */
export class ResidentDocument extends Model<
  InferAttributes<ResidentDocument>,
  InferCreationAttributes<ResidentDocument>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare residentId: number | null;
  declare unitId: number | null;
  declare refType: string | null;
  declare refId: number | null;
  declare docType: string;
  declare fileId: number;
  declare title: string | null;
  declare idLast4: string | null;
  declare expiresOn: string | null;
  declare verificationStatus: 'PENDING' | 'VERIFIED' | 'REJECTED';
  declare verifiedBy: number | null;
  declare verifiedAt: Date | null;
  declare rejectReason: string | null;
  declare uploadedByUserId: number;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;

  static initModel(sequelize: Sequelize): void {
    ResidentDocument.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        residentId: fkColumn(true),
        unitId: fkColumn(true),
        refType: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        refId: fkColumn(true),
        docType: { type: DataTypes.STRING(26), allowNull: false },
        fileId: fkColumn(false),
        title: { type: DataTypes.STRING(120), allowNull: true, defaultValue: null },
        idLast4: { type: DataTypes.CHAR(4), allowNull: true, defaultValue: null },
        expiresOn: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        verificationStatus: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'PENDING' },
        verifiedBy: fkColumn(true),
        verifiedAt: dateColumn(),
        rejectReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        uploadedByUserId: fkColumn(false),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
        deletedAt: dateColumn(),
      },
      { sequelize, tableName: 'resident_documents', paranoid: true },
    );
  }
}
