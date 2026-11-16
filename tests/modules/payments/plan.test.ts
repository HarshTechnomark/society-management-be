import { describe, expect, it } from 'vitest';
import { buildPlan } from '../../../src/modules/payments/payments.alloc.plan';
import type { OpenTarget } from '../../../src/modules/payments/payments.types';

const inv = (id: number, due: string, outstanding: number, issue = '2026-08-01'): OpenTarget => ({
  targetType: 'INVOICE',
  id,
  label: `INV-${id}`,
  dueDate: due,
  issueDate: issue,
  outstandingPaise: outstanding,
});

describe('allocation plan (5.3, worked example 6.10)', () => {
  const open = [inv(123, '2026-10-10', 680_900), inv(87, '2026-08-10', 120_000)];

  it('6.10: oldest first, then the rest to advance', () => {
    const p = buildPlan(open, { mode: 'OLDEST_FIRST', amountPaise: 900_000 });
    expect(p.lines.map(l => [l.id, l.amountPaise])).toEqual([
      [87, 120_000],
      [123, 680_900],
    ]);
    expect(p.advancePaise).toBe(99_100);
    expect(p.lines.reduce((a, l) => a + l.amountPaise, 0) + p.advancePaise).toBe(900_000);
  });

  it('partial payment stops inside the oldest invoice', () => {
    const p = buildPlan(open, { mode: 'OLDEST_FIRST', amountPaise: 50_000 });
    expect(p.lines).toHaveLength(1);
    expect(p.lines[0]).toMatchObject({ id: 87, amountPaise: 50_000 });
    expect(p.advancePaise).toBe(0);
  });

  it('ties on due date break by issue date then id', () => {
    const p = buildPlan(
      [
        inv(5, '2026-10-10', 100, '2026-09-02'),
        inv(4, '2026-10-10', 100, '2026-09-02'),
        inv(9, '2026-10-10', 100, '2026-09-01'),
      ],
      {
        mode: 'OLDEST_FIRST',
        amountPaise: 300,
      },
    );
    expect(p.lines.map(l => l.id)).toEqual([9, 4, 5]);
  });

  it('duesPaise above the outstanding sends the extra to advance', () => {
    const p = buildPlan(open, { mode: 'OLDEST_FIRST', amountPaise: 1_000_000, duesPaise: 500_000 });
    expect(p.lines.reduce((a, l) => a + l.amountPaise, 0)).toBe(500_000);
    expect(p.advancePaise).toBe(500_000);
  });

  it('SELECTED honours the choice and never moves money to another invoice (BR-12-16)', () => {
    const p = buildPlan(open, {
      mode: 'SELECTED',
      amountPaise: 700_000,
      selected: [{ targetType: 'INVOICE', id: 123, amountPaise: 700_000 }],
    });
    expect(p.lines).toEqual([expect.objectContaining({ id: 123, amountPaise: 680_900 })]);
    expect(p.advancePaise).toBe(19_100);
  });

  it('SELECTED item that was paid meanwhile goes to advance', () => {
    const p = buildPlan([], {
      mode: 'SELECTED',
      amountPaise: 1_000,
      selected: [{ targetType: 'INVOICE', id: 1, amountPaise: 1_000 }],
    });
    expect(p.lines).toEqual([]);
    expect(p.advancePaise).toBe(1_000);
  });

  it('collection requests are never picked automatically (BR-12-15)', () => {
    const p = buildPlan([{ ...inv(1, '2026-01-01', 10_000), targetType: 'COLLECTION_REQUEST' }], {
      mode: 'OLDEST_FIRST',
      amountPaise: 5_000,
    });
    expect(p.lines).toEqual([]);
    expect(p.advancePaise).toBe(5_000);
  });

  it('advanceOnly sends everything to advance; chosen items above the amount are refused', () => {
    expect(buildPlan(open, { mode: 'OLDEST_FIRST', amountPaise: 700, advanceOnly: true })).toEqual({
      lines: [],
      advancePaise: 700,
    });
    expect(() =>
      buildPlan(open, {
        mode: 'SELECTED',
        amountPaise: 100,
        selected: [{ targetType: 'INVOICE', id: 87, amountPaise: 120_000 }],
      }),
    ).toThrow(/more than the amount/i);
    expect(() => buildPlan(open, { mode: 'OLDEST_FIRST', amountPaise: 0 })).toThrow();
  });
});
