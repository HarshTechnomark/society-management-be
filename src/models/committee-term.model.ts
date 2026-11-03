import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { AppError } from '../utils/errors';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import {
  parseHandover,
  parseSeats,
  type HandoverItemJson,
  type SeatJson,
} from '../modules/committee/committee.schemas';

/**
 * Module 10 section 7.1: one row per committee term. Seats (`members`) and the hand-over checklist are validated JSON arrays,
 * parsed with the Zod schemas of section 7.2 on every read and write. `currentSlot`, `draftSlot` and `electionSlot` are
 * generated columns and never written. Paranoid; only DRAFT rows are ever deleted (hook `beforeDestroy`).
 */
export class CommitteeTerm extends Model<
  InferAttributes<CommitteeTerm>,
  InferCreationAttributes<CommitteeTerm>
> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare name: string;
  declare kind: 'ELECTED' | 'PROVISIONAL' | 'AD_HOC';
  declare source: 'MANUAL' | 'ELECTION' | 'HISTORICAL';
  declare status: 'DRAFT' | 'ACTIVE' | 'EXPIRED' | 'ENDED';
  declare startDate: string;
  declare endDate: string;
  declare actualEndDate: string | null;
  declare strength: number;
  declare electionId: number | null;
  declare resultsDeclaredAt: Date | null;
  declare predecessorTermId: number | null;
  declare members: SeatJson[];
  declare handoverChecklist: HandoverItemJson[];
  declare handoverCompletedAt: Date | null;
  declare tookChargeOn: string | null;
  declare resolutionRef: string | null;
  declare notes: string | null;
  declare lastReminderDays: number | null;
  declare lastHandoverReminderDay: number | null;
  declare activatedAt: Date | null;
  declare activatedBy: number | null;
  declare expiredAt: Date | null;
  declare endedAt: Date | null;
  declare endedBy: number | null;
  declare endReason: string | null;
  declare version: number;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare deletedAt: Date | null;

  static initModel(sequelize: Sequelize): void {
    CommitteeTerm.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        name: { type: DataTypes.STRING(120), allowNull: false },
        kind: { type: DataTypes.STRING(12), allowNull: false, defaultValue: 'ELECTED' },
        source: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'MANUAL' },
        status: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'DRAFT' },
        startDate: { type: DataTypes.DATEONLY, allowNull: false },
        endDate: { type: DataTypes.DATEONLY, allowNull: false },
        actualEndDate: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        strength: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false },
        electionId: fkColumn(true),
        resultsDeclaredAt: dateColumn(),
        predecessorTermId: fkColumn(true),
        members: {
          type: DataTypes.JSON,
          allowNull: false,
          defaultValue: [],
          get(this: CommitteeTerm): SeatJson[] {
            return parseSeats(this.getDataValue('members'));
          },
          set(this: CommitteeTerm, v: SeatJson[]) {
            this.setDataValue('members', parseSeats(v));
          },
        },
        handoverChecklist: {
          type: DataTypes.JSON,
          allowNull: false,
          defaultValue: [],
          get(this: CommitteeTerm): HandoverItemJson[] {
            return parseHandover(this.getDataValue('handoverChecklist'));
          },
          set(this: CommitteeTerm, v: HandoverItemJson[]) {
            this.setDataValue('handoverChecklist', parseHandover(v));
          },
        },
        handoverCompletedAt: dateColumn(),
        tookChargeOn: { type: DataTypes.DATEONLY, allowNull: true, defaultValue: null },
        resolutionRef: { type: DataTypes.STRING(100), allowNull: true, defaultValue: null },
        notes: { type: DataTypes.STRING(1000), allowNull: true, defaultValue: null },
        lastReminderDays: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true, defaultValue: null },
        lastHandoverReminderDay: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true, defaultValue: null },
        activatedAt: dateColumn(),
        activatedBy: fkColumn(true),
        expiredAt: dateColumn(),
        endedAt: dateColumn(),
        endedBy: fkColumn(true),
        endReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
        deletedAt: dateColumn(),
      },
      {
        sequelize,
        tableName: 'committee_terms',
        paranoid: true,
        hooks: {
          beforeDestroy: term => {
            if (term.status !== 'DRAFT')
              throw new AppError(409, 'INVALID_STATE', 'Only a draft committee term can be deleted');
          },
        },
      },
    );
  }
}
