import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';

export const PET_SPECIES = ['DOG', 'CAT', 'BIRD', 'RABBIT', 'FISH', 'OTHER'] as const;
export type PetSpecies = (typeof PET_SPECIES)[number];

/** Module 09 section 7.9: the pets register. Paranoid. */
export class Pet extends Model<InferAttributes<Pet>, InferCreationAttributes<Pet>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare unitId: number;
  declare ownerResidentId: number;
  declare name: string;
  declare species: PetSpecies;
  declare breed: string | null;
  declare gender: 'MALE' | 'FEMALE' | 'UNKNOWN';
  declare colour: string | null;
  declare dateOfBirth: string | null;
  declare photoFileId: number | null;
  declare licenceNo: string | null;
  declare isNeutered: boolean | null;
  declare temperamentNote: string | null;
  declare lastVaccineName: string | null;
  declare lastVaccinatedOn: string | null;
  declare vaccinationValidUntil: string | null;
  declare vaccinationReminderFor: string | null;
  declare status: 'ACTIVE' | 'INACTIVE';
  declare inactiveReason: string | null;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;

  static initModel(sequelize: Sequelize): void {
    Pet.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        unitId: fkColumn(false),
        ownerResidentId: fkColumn(false),
        name: { type: DataTypes.STRING(60), allowNull: false },
        species: { type: DataTypes.STRING(8), allowNull: false },
        breed: { type: DataTypes.STRING(60), allowNull: true, defaultValue: null },
        gender: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'UNKNOWN' },
        colour: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        dateOfBirth: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        photoFileId: fkColumn(true),
        licenceNo: { type: DataTypes.STRING(40), allowNull: true, defaultValue: null },
        isNeutered: { type: DataTypes.BOOLEAN, allowNull: true, defaultValue: null },
        temperamentNote: { type: DataTypes.STRING(200), allowNull: true, defaultValue: null },
        lastVaccineName: { type: DataTypes.STRING(80), allowNull: true, defaultValue: null },
        lastVaccinatedOn: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        vaccinationValidUntil: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        vaccinationReminderFor: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        status: { type: DataTypes.STRING(8), allowNull: false, defaultValue: 'ACTIVE' },
        inactiveReason: { type: DataTypes.STRING(16), allowNull: true, defaultValue: null },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
        deletedAt: dateColumn(),
      },
      { sequelize, tableName: 'pets', paranoid: true },
    );
  }
}
