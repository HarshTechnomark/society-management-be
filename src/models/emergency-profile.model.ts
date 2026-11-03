import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export const BLOOD_GROUPS = [
  'A_POS',
  'A_NEG',
  'B_POS',
  'B_NEG',
  'AB_POS',
  'AB_NEG',
  'O_POS',
  'O_NEG',
  'UNKNOWN',
] as const;
export type BloodGroup = (typeof BLOOD_GROUPS)[number];

/** Module 09 section 7.10: one emergency profile per resident. `medicalNotesEnc` is AES-256-GCM (`iv ‖ tag ‖ ciphertext`). */
export class EmergencyProfile extends Model<
  InferAttributes<EmergencyProfile>,
  InferCreationAttributes<EmergencyProfile>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare residentId: number;
  declare bloodGroup: BloodGroup | null;
  declare medicalNotesEnc: Buffer | null;
  declare isSeniorCitizen: boolean;
  declare isDifferentlyAbled: boolean;
  declare mobilityNote: string | null;
  declare preferredHospital: string | null;
  declare contact1Name: string | null;
  declare contact1Relation: string | null;
  declare contact1Mobile: string | null;
  declare contact2Name: string | null;
  declare contact2Relation: string | null;
  declare contact2Mobile: string | null;
  declare contact3Name: string | null;
  declare contact3Relation: string | null;
  declare contact3Mobile: string | null;
  declare consentGivenAt: Date | null;
  declare consentTextVersion: string | null;
  declare consentByUserId: number | null;
  declare consentWithdrawnAt: Date | null;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    const text = (n: number) => ({ type: DataTypes.STRING(n), allowNull: true, defaultValue: null });
    // a fresh definition per attribute: Sequelize writes the field name into the object it is given
    const mobile = () => ({ type: DataTypes.CHAR(10), allowNull: true, defaultValue: null });
    EmergencyProfile.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        residentId: fkColumn(false),
        bloodGroup: text(8),
        medicalNotesEnc: { type: DataTypes.BLOB, allowNull: true, defaultValue: null },
        isSeniorCitizen: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        isDifferentlyAbled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        mobilityNote: text(200),
        preferredHospital: text(120),
        contact1Name: text(120),
        contact1Relation: text(40),
        contact1Mobile: mobile(),
        contact2Name: text(120),
        contact2Relation: text(40),
        contact2Mobile: mobile(),
        contact3Name: text(120),
        contact3Relation: text(40),
        contact3Mobile: mobile(),
        consentGivenAt: dateColumn(),
        consentTextVersion: text(10),
        consentByUserId: fkColumn(true),
        consentWithdrawnAt: dateColumn(),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'emergency_profiles' },
    );
  }
}
