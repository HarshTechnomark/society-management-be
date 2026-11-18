import { describe, expect, it } from 'vitest';
import { avg2, pct1 } from '../../../src/modules/communication/communication.surveys.results';
import { validateAnswers } from '../../../src/modules/communication/communication.surveys.me';
import { surveySchemas } from '../../../src/modules/communication/communication.surveys.validation';
import { respondentKey } from '../../../src/modules/communication/communication.crypto';

const q = (o: Record<string, unknown>) =>
  ({
    id: 1,
    type: 'TEXT',
    isRequired: true,
    options: null,
    maxSelections: null,
    minValue: null,
    maxValue: null,
    maxLength: null,
    ...o,
  }) as never;

describe('results arithmetic (8.33)', () => {
  it('percentages with one decimal, half-up; average with two decimals', () => {
    expect(pct1(61, 98)).toBe('62.2');
    expect(pct1(37, 98)).toBe('37.8');
    expect(pct1(1, 8)).toBe('12.5');
    expect(pct1(1, 3)).toBe('33.3');
    expect(pct1(0, 0)).toBe('0.0');
    expect(avg2(4 + 12 + 54 + 160 + 160, 100)).toBe('3.90');
    expect(avg2(1, 3)).toBe('0.33');
    expect(avg2(2, 3)).toBe('0.67');
  });
});

describe('answer validation (8.34)', () => {
  const questions = [
    q({
      id: 1,
      type: 'SINGLE_CHOICE',
      options: [
        { key: 'o1', label: 'A' },
        { key: 'o2', label: 'B' },
      ],
    }),
    q({
      id: 2,
      type: 'MULTI_CHOICE',
      maxSelections: 2,
      options: [
        { key: 'o1', label: 'A' },
        { key: 'o2', label: 'B' },
        { key: 'o3', label: 'C' },
      ],
    }),
    q({ id: 3, type: 'RATING' }),
    q({ id: 4, type: 'NPS', isRequired: false }),
    q({ id: 5, type: 'NUMBER', minValue: 10, maxValue: 20, isRequired: false }),
    q({ id: 6, type: 'TEXT', maxLength: 5, isRequired: false }),
    q({ id: 7, type: 'DATE', isRequired: false }),
    q({ id: 8, type: 'YES_NO', isRequired: false }),
  ];
  const base = [
    { questionId: 1, optionKey: 'o2' },
    { questionId: 2, optionKeys: ['o1', 'o3'] },
    { questionId: 3, number: 5 },
  ];
  const fails = (a: any[]) => {
    try {
      validateAnswers(questions, a);
    } catch (e: any) {
      return e.code === 'SURVEY_ANSWER_INVALID' ? e.errors[0].questionId : e.code;
    }
    return null;
  };
  it('accepts a valid set and splits multi-choice into one row per option', () => {
    const rows = validateAnswers(questions, [
      ...base,
      { questionId: 4, number: 0 },
      { questionId: 5, number: 15 },
      { questionId: 6, text: ' hi ' },
      { questionId: 7, date: '2026-02-28' },
      { questionId: 8, optionKey: 'no' },
    ]);
    expect(rows).toHaveLength(9);
    expect(rows.filter(r => r.questionId === 2).map(r => r.optionKey)).toEqual(['o1', 'o3']);
    expect(rows.find(r => r.questionId === 6)!.textValue).toBe('hi');
  });
  it('rejects every shape violation with the question id', () => {
    expect(fails(base.slice(1))).toBe(1); // required missing
    expect(fails([...base, { questionId: 99, number: 1 }])).toBe(99);
    expect(fails([...base, { questionId: 3, number: 1 }])).toBe(3); // twice
    expect(fails([{ questionId: 1, optionKey: 'o9' }, ...base.slice(1)])).toBe(1);
    expect(fails([base[0], { questionId: 2, optionKeys: ['o1', 'o2', 'o3'] }, base[2]])).toBe(2); // over maxSelections
    expect(fails([base[0], { questionId: 2, optionKeys: ['o1', 'o1'] }, base[2]])).toBe(2);
    expect(fails([base[0], base[1], { questionId: 3, number: 6 }])).toBe(3);
    expect(fails([...base, { questionId: 4, number: 11 }])).toBe(4);
    expect(fails([...base, { questionId: 5, number: 21 }])).toBe(5);
    expect(fails([...base, { questionId: 6, text: 'toolong' }])).toBe(6);
    expect(fails([...base, { questionId: 6, text: '   ' }])).toBe(6);
    expect(fails([...base, { questionId: 7, date: '2026-02-30' }])).toBe(7);
    expect(fails([...base, { questionId: 8, optionKey: 'o1' }])).toBe(8);
    expect(fails([base[0], base[1], { questionId: 3, number: 5, text: 'x' }])).toBe(3); // wrong field for the type
  });
});

describe('question schema (BR-16-45, 7.11)', () => {
  const ok = (o: Record<string, unknown>) =>
    surveySchemas.create.safeParse({ title: 'Gym timings', questions: [o] }).success;
  it('checks options, selections, number range and text length per type', () => {
    const two = [
      { key: 'o1', label: 'A' },
      { key: 'o2', label: 'B' },
    ];
    expect(ok({ type: 'SINGLE_CHOICE', prompt: 'Pick one', options: two })).toBe(true);
    expect(ok({ type: 'SINGLE_CHOICE', prompt: 'Pick one', options: [two[0]] })).toBe(false);
    expect(ok({ type: 'SINGLE_CHOICE', prompt: 'Pick one' })).toBe(false);
    expect(
      ok({ type: 'SINGLE_CHOICE', prompt: 'Pick one', options: [two[0], { key: 'o1', label: 'C' }] }),
    ).toBe(false);
    expect(
      ok({ type: 'SINGLE_CHOICE', prompt: 'Pick one', options: [two[0], { key: 'x1', label: 'C' }] }),
    ).toBe(false);
    expect(
      ok({ type: 'SINGLE_CHOICE', prompt: 'Pick one', options: [two[0], { key: 'o2', label: 'a' }] }),
    ).toBe(false);
    expect(ok({ type: 'TEXT', prompt: 'Say more', options: two })).toBe(false);
    expect(ok({ type: 'MULTI_CHOICE', prompt: 'Pick some', options: two, maxSelections: 3 })).toBe(false);
    expect(ok({ type: 'MULTI_CHOICE', prompt: 'Pick some', options: two, maxSelections: 2 })).toBe(true);
    expect(ok({ type: 'RATING', prompt: 'Rate it', maxSelections: 2 })).toBe(false);
    expect(ok({ type: 'NUMBER', prompt: 'How many?', minValue: 1, maxValue: 5 })).toBe(true);
    expect(ok({ type: 'NUMBER', prompt: 'How many?', minValue: 5, maxValue: 5 })).toBe(false);
    expect(ok({ type: 'NUMBER', prompt: 'How many?' })).toBe(false);
    expect(ok({ type: 'TEXT', prompt: 'Say more', maxLength: 1000 })).toBe(true);
    expect(ok({ type: 'TEXT', prompt: 'Say more', maxLength: 1001 })).toBe(false);
    expect(ok({ type: 'YES_NO', prompt: 'Agree?', maxLength: 10 })).toBe(false);
    expect(
      surveySchemas.create.safeParse({
        title: 'Gym timings',
        questions: Array(31).fill({ type: 'YES_NO', prompt: 'Agree?' }),
      }).success,
    ).toBe(false);
    expect(surveySchemas.create.safeParse({ title: 'Gym', questions: [] }).success).toBe(false); // title 5+
    expect(
      surveySchemas.create.safeParse({ title: 'Gym timings', audience: { type: 'ALL', ids: [1] } }).success,
    ).toBe(false);
    expect(
      surveySchemas.create.safeParse({ title: 'Gym timings', audience: { type: 'UNITS' } }).success,
    ).toBe(false);
  });
});

describe('respondent key (BR-16-48)', () => {
  it('is stable per person or flat, different when anonymous, and never the plain hash of the id', () => {
    const a = respondentKey(9, 'PERSON', 5, true);
    expect(a).toBe(respondentKey(9, 'PERSON', 5, true));
    expect(a).not.toBe(respondentKey(9, 'PERSON', 5, false));
    expect(a).not.toBe(respondentKey(9, 'FLAT', 5, true));
    expect(a).not.toBe(respondentKey(10, 'PERSON', 5, true));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
