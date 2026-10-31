import { DataTypes } from 'sequelize';
import { now } from '../lib/clock';

/** `createdAt` / `updatedAt` take their value from the clock helper so tests can freeze time (BR-01-18). */
export const timestampColumns = {
  createdAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: () => now() },
  updatedAt: { type: DataTypes.DATE(3), allowNull: false, defaultValue: () => now() },
};

export const idColumn = { type: DataTypes.BIGINT.UNSIGNED, autoIncrement: true, primaryKey: true } as const;
export const fkColumn = (allowNull: boolean) => ({
  type: DataTypes.BIGINT.UNSIGNED,
  allowNull,
  defaultValue: null,
});
export const dateColumn = (allowNull = true) => ({
  type: DataTypes.DATE(3),
  allowNull,
  ...(allowNull ? { defaultValue: null } : {}),
});
