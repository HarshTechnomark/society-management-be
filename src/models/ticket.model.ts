import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import { dateColumn, fkColumn, idColumn, timestampColumns } from './_columns';
import type {
  AffectedLevel,
  Channel,
  ChargeStatus,
  CloseSource,
  PrioritySource,
  Priority,
  ReporterRole,
  SlaCalendar,
  TicketKind,
  TicketStatus,
  WaitingReason,
} from '../modules/helpdesk/helpdesk.constants';

/** Module 15 section 7.3: a ticket (personal complaint or building issue). Never deleted (cancelled instead). The generated column `openDisputeKey` is not mapped. */
export class Ticket extends Model<InferAttributes<Ticket>, InferCreationAttributes<Ticket>> {
  declare id: CreationOptional<number>;
  declare societyId: number;
  declare ticketNo: string;
  declare kind: TicketKind;
  declare unitId: number | null;
  declare locationNodeId: number | null;
  declare affectedLevel: AffectedLevel | null;
  declare affectedBuildingId: number | null;
  declare affectedFloor: number | null;
  declare affectedUnitCount: number | null;
  declare reporterUnitId: number | null;
  declare assetId: number | null;
  declare categoryId: number;
  declare subCategoryId: number | null;
  declare invoiceId: number | null;
  declare title: string;
  declare description: CreationOptional<string>;
  declare priority: Priority;
  declare prioritySource: CreationOptional<PrioritySource>;
  declare status: CreationOptional<TicketStatus>;
  declare channel: CreationOptional<Channel>;
  declare reporterRole: ReporterRole;
  declare raisedByUserId: number;
  declare requesterUserId: number | null;
  declare requesterName: string;
  declare duplicateReason: string | null;
  declare currentAssignmentId: number | null;
  declare assigneeUserId: number | null;
  declare assigneeLabel: string | null;
  declare slaPolicyId: number;
  declare slaCalendar: SlaCalendar;
  declare responseMinutes: number;
  declare resolutionMinutes: number;
  declare slaCycle: CreationOptional<number>;
  declare slaStartAt: Date;
  declare responseDueAt: Date;
  declare resolutionDueAt: Date;
  declare firstResponseAt: Date | null;
  declare slaPausedAt: Date | null;
  declare slaPausedMinutes: CreationOptional<number>;
  declare responseBreached: CreationOptional<boolean>;
  declare resolutionBreached: CreationOptional<boolean>;
  declare escalationLevel: CreationOptional<number>;
  declare nextSlaCheckAt: Date | null;
  declare lastResidentEscalationAt: Date | null;
  declare waitingReason: WaitingReason | null;
  declare waitingReminderSentAt: Date | null;
  declare preferredSlotFrom: Date | null;
  declare preferredSlotTo: Date | null;
  declare isChargeable: CreationOptional<boolean>;
  declare chargeStatus: CreationOptional<ChargeStatus>;
  declare chargeEstimatePaise: CreationOptional<number>;
  declare chargeEstimateNote: string | null;
  declare chargeEstimateSentAt: Date | null;
  declare chargeDecidedByUserId: number | null;
  declare chargeDecidedAt: Date | null;
  declare chargeFinalPaise: CreationOptional<number>;
  declare chargeInvoiceId: number | null;
  declare chargeWaiveReason: string | null;
  declare upvoteCount: CreationOptional<number>;
  declare priorityAutoRaisedAt: Date | null;
  declare isRecurring: CreationOptional<boolean>;
  declare mergedIntoTicketId: number | null;
  declare reopenCount: CreationOptional<number>;
  declare resolutionNote: string | null;
  declare resolvedAt: Date | null;
  declare resolvedByUserId: number | null;
  declare closedAt: Date | null;
  declare closeSource: CloseSource | null;
  declare cancelledAt: Date | null;
  declare cancelReason: string | null;
  declare csatScore: number | null;
  declare csatComment: string | null;
  declare csatAt: Date | null;
  declare csatAvgTenths: number | null;
  declare csatCount: CreationOptional<number>;
  declare lastActivityAt: Date;
  declare version: CreationOptional<number>;
  declare createdBy: number | null;
  declare updatedBy: number | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize): void {
    Ticket.init(
      {
        id: idColumn,
        societyId: fkColumn(false),
        ticketNo: { type: DataTypes.STRING(30), allowNull: false },
        kind: { type: DataTypes.STRING(10), allowNull: false },
        unitId: fkColumn(true),
        locationNodeId: fkColumn(true),
        affectedLevel: { type: DataTypes.STRING(10), allowNull: true, defaultValue: null },
        affectedBuildingId: fkColumn(true),
        affectedFloor: { type: DataTypes.SMALLINT, allowNull: true, defaultValue: null },
        affectedUnitCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true, defaultValue: null },
        reporterUnitId: fkColumn(true),
        assetId: fkColumn(true),
        categoryId: fkColumn(false),
        subCategoryId: fkColumn(true),
        invoiceId: fkColumn(true),
        title: { type: DataTypes.STRING(150), allowNull: false },
        description: { type: DataTypes.STRING(2000), allowNull: false, defaultValue: '' },
        priority: { type: DataTypes.STRING(2), allowNull: false },
        prioritySource: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'CATEGORY' },
        status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'OPEN' },
        channel: { type: DataTypes.STRING(10), allowNull: false, defaultValue: 'APP' },
        reporterRole: { type: DataTypes.STRING(10), allowNull: false },
        raisedByUserId: fkColumn(false),
        requesterUserId: fkColumn(true),
        requesterName: { type: DataTypes.STRING(120), allowNull: false },
        duplicateReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        currentAssignmentId: fkColumn(true),
        assigneeUserId: fkColumn(true),
        assigneeLabel: { type: DataTypes.STRING(150), allowNull: true, defaultValue: null },
        slaPolicyId: fkColumn(false),
        slaCalendar: { type: DataTypes.STRING(20), allowNull: false },
        responseMinutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        resolutionMinutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        slaCycle: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 1 },
        slaStartAt: dateColumn(false),
        responseDueAt: dateColumn(false),
        resolutionDueAt: dateColumn(false),
        firstResponseAt: dateColumn(),
        slaPausedAt: dateColumn(),
        slaPausedMinutes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        responseBreached: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        resolutionBreached: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        escalationLevel: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        nextSlaCheckAt: dateColumn(),
        lastResidentEscalationAt: dateColumn(),
        waitingReason: { type: DataTypes.STRING(20), allowNull: true, defaultValue: null },
        waitingReminderSentAt: dateColumn(),
        preferredSlotFrom: dateColumn(),
        preferredSlotTo: dateColumn(),
        isChargeable: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        chargeStatus: { type: DataTypes.STRING(15), allowNull: false, defaultValue: 'NONE' },
        chargeEstimatePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        chargeEstimateNote: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        chargeEstimateSentAt: dateColumn(),
        chargeDecidedByUserId: fkColumn(true),
        chargeDecidedAt: dateColumn(),
        chargeFinalPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
        chargeInvoiceId: fkColumn(true),
        chargeWaiveReason: { type: DataTypes.STRING(300), allowNull: true, defaultValue: null },
        upvoteCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        priorityAutoRaisedAt: dateColumn(),
        isRecurring: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        mergedIntoTicketId: fkColumn(true),
        reopenCount: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        resolutionNote: { type: DataTypes.STRING(2000), allowNull: true, defaultValue: null },
        resolvedAt: dateColumn(),
        resolvedByUserId: fkColumn(true),
        closedAt: dateColumn(),
        closeSource: { type: DataTypes.STRING(10), allowNull: true, defaultValue: null },
        cancelledAt: dateColumn(),
        cancelReason: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        csatScore: { type: DataTypes.TINYINT.UNSIGNED, allowNull: true, defaultValue: null },
        csatComment: { type: DataTypes.STRING(500), allowNull: true, defaultValue: null },
        csatAt: dateColumn(),
        csatAvgTenths: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: true, defaultValue: null },
        csatCount: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastActivityAt: dateColumn(false),
        version: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 1 },
        createdBy: fkColumn(true),
        updatedBy: fkColumn(true),
        ...timestampColumns,
      },
      { sequelize, tableName: 'tickets' },
    );
  }
}
