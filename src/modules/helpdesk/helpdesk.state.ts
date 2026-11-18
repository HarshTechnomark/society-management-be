import { AppError } from '../../utils/errors';
import {
  ERR,
  type CallerType,
  type TicketKind,
  type TicketStatus,
  type TransitionAction,
} from './helpdesk.constants';
import type { CallerTypes, TicketFacts } from './helpdesk.types';

/**
 * Section 6.2, the one transition table. PURE: no database. `by` lists the caller types that may perform the row; a caller holding any of them
 * passes (`UNIT_RESIDENT` only on PERSONAL tickets, `UPVOTER` only on BUILDING tickets: see `kindOk`). Assign, reassign and unassign are
 * not actions of `POST /transition`; they are `ASSIGN_FROM` / `UNASSIGN_FROM` below and live in `helpdesk.routing.ts`.
 */
export interface TransitionRow {
  from: TicketStatus;
  to: TicketStatus;
  action: TransitionAction;
  by: readonly CallerType[];
}

const ADM: CallerType[] = ['ADMIN'];
const WORK: CallerType[] = ['ADMIN', 'ASSIGNEE'];
const SYS: CallerType[] = ['SYSTEM'];
const RESIDENTS: CallerType[] = ['REQUESTER', 'UNIT_RESIDENT'];

export const TRANSITIONS: readonly TransitionRow[] = [
  { from: 'ASSIGNED', to: 'IN_PROGRESS', action: 'START', by: WORK },
  { from: 'IN_PROGRESS', to: 'WAITING_ON_RESIDENT', action: 'WAIT_ON_RESIDENT', by: [...WORK, ...SYS] },
  { from: 'WAITING_ON_RESIDENT', to: 'IN_PROGRESS', action: 'RESUME', by: [...WORK, ...SYS] },
  { from: 'IN_PROGRESS', to: 'RESOLVED', action: 'RESOLVE', by: [...WORK, ...SYS] },
  { from: 'WAITING_ON_RESIDENT', to: 'RESOLVED', action: 'RESOLVE', by: [...WORK, ...SYS] },
  { from: 'RESOLVED', to: 'CLOSED', action: 'CLOSE', by: [...ADM, ...RESIDENTS, ...SYS] },
  { from: 'RESOLVED', to: 'REOPENED', action: 'REOPEN', by: [...ADM, ...RESIDENTS, 'UPVOTER'] },
  { from: 'CLOSED', to: 'REOPENED', action: 'REOPEN', by: [...ADM, ...RESIDENTS, 'UPVOTER'] },
  { from: 'OPEN', to: 'CANCELLED', action: 'CANCEL', by: [...ADM, 'REQUESTER', ...SYS] },
  { from: 'ASSIGNED', to: 'CANCELLED', action: 'CANCEL', by: [...ADM, 'REQUESTER', ...SYS] },
  { from: 'IN_PROGRESS', to: 'CANCELLED', action: 'CANCEL', by: [...ADM, ...SYS] },
  { from: 'WAITING_ON_RESIDENT', to: 'CANCELLED', action: 'CANCEL', by: [...ADM, ...SYS] },
  { from: 'REOPENED', to: 'CANCELLED', action: 'CANCEL', by: [...ADM, ...SYS] },
];

/** Statuses from which an admin may assign or reassign (6.2 and BR-15-36); the result is always ASSIGNED. */
export const ASSIGN_FROM: readonly TicketStatus[] = [
  'OPEN',
  'REOPENED',
  'ASSIGNED',
  'IN_PROGRESS',
  'WAITING_ON_RESIDENT',
];
/** ASSIGNED to OPEN (assignment ends UNASSIGNED). */
export const UNASSIGN_FROM: readonly TicketStatus[] = ['ASSIGNED'];

/** Caller types that only make sense for one kind (6.2: "unit resident (personal)", "upvoter (building)"). */
export function kindOk(type: CallerType, kind: TicketKind): boolean {
  if (type === 'UNIT_RESIDENT') return kind === 'PERSONAL';
  if (type === 'UPVOTER') return kind === 'BUILDING';
  return true;
}

function rowFor(facts: TicketFacts, action: TransitionAction): TransitionRow | undefined {
  return TRANSITIONS.find(r => {
    if (r.from !== facts.status || r.action !== action) return false;
    // BR-15-43 / 6.2: RESOLVE from WAITING needs a reason other than the estimate approval
    if (
      action === 'RESOLVE' &&
      r.from === 'WAITING_ON_RESIDENT' &&
      facts.waitingReason === 'ESTIMATE_APPROVAL'
    )
      return false;
    return true;
  });
}

const holds = (row: TransitionRow, caller: CallerTypes, kind: TicketKind): boolean =>
  row.by.some(t => caller.has(t) && kindOk(t, kind));

/** The actions this caller could take now (the `allowedActions` of the DTOs). Chargeable and time-window guards are checked by the transition. */
export function allowedActions(facts: TicketFacts, caller: CallerTypes): TransitionAction[] {
  const out: TransitionAction[] = [];
  for (const row of TRANSITIONS) {
    if (row.from !== facts.status || out.includes(row.action)) continue;
    const r = rowFor(facts, row.action);
    if (r && holds(r, caller, facts.kind)) out.push(row.action);
  }
  return out;
}

/** The target status of `action`, or `undefined` when the table has no row for it from this status or for this caller. */
export function resolveTransition(
  facts: TicketFacts,
  action: TransitionAction,
  caller: CallerTypes,
): TicketStatus | undefined {
  const row = rowFor(facts, action);
  return row && holds(row, caller, facts.kind) ? row.to : undefined;
}

/** BR-15-33: `409 TICKET_INVALID_TRANSITION` with `errors[]` = the allowed actions of this caller. */
export function assertTransition(
  facts: TicketFacts,
  action: TransitionAction,
  caller: CallerTypes,
): TicketStatus {
  const to = resolveTransition(facts, action, caller);
  if (to) return to;
  const allowed = allowedActions(facts, caller);
  throw new AppError(
    409,
    ERR.invalidTransition,
    `${action} is not allowed while the ticket is ${facts.status}`,
    allowed.map(a => ({ field: 'action', message: a })),
  );
}

/** True when the status has no way out except REOPEN inside the window (RESOLVED, CLOSED) or none at all (CANCELLED). */
export const isFinal = (s: TicketStatus): boolean => s === 'CANCELLED';
