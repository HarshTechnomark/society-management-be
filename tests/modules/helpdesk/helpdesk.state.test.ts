import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  TICKET_STATUSES,
  type CallerType,
  type TicketKind,
} from '../../../src/modules/helpdesk/helpdesk.constants';
import {
  ASSIGN_FROM,
  TRANSITIONS,
  UNASSIGN_FROM,
  allowedActions,
  assertTransition,
  resolveTransition,
} from '../../../src/modules/helpdesk/helpdesk.state';
import type { TicketFacts } from '../../../src/modules/helpdesk/helpdesk.types';

const facts = (
  status: TicketFacts['status'],
  kind: TicketKind = 'PERSONAL',
  over: Partial<TicketFacts> = {},
): TicketFacts => ({
  status,
  kind,
  requesterUserId: 1,
  waitingReason: null,
  chargeStatus: 'NONE',
  resolvedAt: null,
  reopenCount: 0,
  ...over,
});
const caller = (...t: CallerType[]) => new Set<CallerType>(t);
const ALL_TYPES: CallerType[] = ['ADMIN', 'ASSIGNEE', 'REQUESTER', 'UNIT_RESIDENT', 'UPVOTER', 'SYSTEM'];

describe('ticket state machine (6.2, T15-04)', () => {
  it('has exactly the rows of the table and CANCELLED is final', () => {
    expect(TRANSITIONS).toHaveLength(13);
    expect(TRANSITIONS.some(r => r.from === 'CANCELLED')).toBe(false);
    expect(TRANSITIONS.filter(r => r.from === 'CLOSED').map(r => r.action)).toEqual(['REOPEN']);
  });

  it('every (status, action, caller type) pair outside the table is TICKET_INVALID_TRANSITION', () => {
    for (const kind of ['PERSONAL', 'BUILDING'] as TicketKind[])
      for (const status of TICKET_STATUSES)
        for (const action of ACTIONS)
          for (const type of ALL_TYPES) {
            const f = facts(status, kind);
            const row = TRANSITIONS.find(r => r.from === status && r.action === action);
            const kindOk =
              !(type === 'UNIT_RESIDENT' && kind === 'BUILDING') &&
              !(type === 'UPVOTER' && kind === 'PERSONAL');
            const legal = Boolean(row && row.by.includes(type) && kindOk);
            if (legal) expect(resolveTransition(f, action, caller(type))).toBe(row!.to);
            else expect(() => assertTransition(f, action, caller(type))).toThrowError(/not allowed/);
          }
  });

  it('the error lists the allowed actions of the caller', () => {
    try {
      assertTransition(facts('OPEN'), 'RESOLVE', caller('ADMIN'));
      throw new Error('should have thrown');
    } catch (e) {
      const err = e as { status: number; code: string; errors: { message: string }[] };
      expect(err.status).toBe(409);
      expect(err.code).toBe('TICKET_INVALID_TRANSITION');
      expect(err.errors.map(x => x.message)).toEqual(['CANCEL']);
    }
  });

  it('allowed actions per caller', () => {
    expect(allowedActions(facts('ASSIGNED'), caller('ADMIN'))).toEqual(['START', 'CANCEL']);
    expect(allowedActions(facts('ASSIGNED'), caller('REQUESTER'))).toEqual(['CANCEL']);
    expect(allowedActions(facts('ASSIGNED'), caller('ASSIGNEE'))).toEqual(['START']);
    expect(allowedActions(facts('IN_PROGRESS'), caller('ADMIN'))).toEqual([
      'WAIT_ON_RESIDENT',
      'RESOLVE',
      'CANCEL',
    ]);
    expect(allowedActions(facts('RESOLVED'), caller('REQUESTER'))).toEqual(['CLOSE', 'REOPEN']);
    expect(allowedActions(facts('CANCELLED'), caller('ADMIN', 'SYSTEM'))).toEqual([]);
  });

  it('a resident cancels only OPEN or ASSIGNED; an admin any live status', () => {
    for (const s of ['IN_PROGRESS', 'WAITING_ON_RESIDENT', 'REOPENED'] as const) {
      expect(resolveTransition(facts(s), 'CANCEL', caller('REQUESTER'))).toBeUndefined();
      expect(resolveTransition(facts(s), 'CANCEL', caller('ADMIN'))).toBe('CANCELLED');
    }
    expect(resolveTransition(facts('OPEN'), 'CANCEL', caller('REQUESTER'))).toBe('CANCELLED');
  });

  it('unit residents act on personal tickets, upvoters on building issues', () => {
    expect(resolveTransition(facts('RESOLVED', 'PERSONAL'), 'CLOSE', caller('UNIT_RESIDENT'))).toBe('CLOSED');
    expect(
      resolveTransition(facts('RESOLVED', 'BUILDING'), 'CLOSE', caller('UNIT_RESIDENT')),
    ).toBeUndefined();
    expect(resolveTransition(facts('CLOSED', 'BUILDING'), 'REOPEN', caller('UPVOTER'))).toBe('REOPENED');
    expect(resolveTransition(facts('CLOSED', 'PERSONAL'), 'REOPEN', caller('UPVOTER'))).toBeUndefined();
    expect(resolveTransition(facts('RESOLVED'), 'CLOSE', caller('UPVOTER'))).toBeUndefined();
  });

  it('a ticket waiting for an estimate decision cannot be resolved', () => {
    const f = facts('WAITING_ON_RESIDENT', 'PERSONAL', { waitingReason: 'ESTIMATE_APPROVAL' });
    expect(resolveTransition(f, 'RESOLVE', caller('ADMIN'))).toBeUndefined();
    expect(resolveTransition({ ...f, waitingReason: 'INFORMATION' }, 'RESOLVE', caller('ADMIN'))).toBe(
      'RESOLVED',
    );
  });

  it('only residents, admins and the system close; the assignee cannot', () => {
    expect(resolveTransition(facts('RESOLVED'), 'CLOSE', caller('ASSIGNEE'))).toBeUndefined();
    expect(resolveTransition(facts('RESOLVED'), 'CLOSE', caller('SYSTEM'))).toBe('CLOSED');
  });

  it('assign and unassign statuses', () => {
    expect([...ASSIGN_FROM]).toEqual(['OPEN', 'REOPENED', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_ON_RESIDENT']);
    expect([...UNASSIGN_FROM]).toEqual(['ASSIGNED']);
  });
});
