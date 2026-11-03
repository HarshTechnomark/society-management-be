import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { QueryTypes } from 'sequelize';
import { CommitteeTerm, closeDb, sequelize } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { committeeWorld, rawTerm, resetCommittee } from '../../helpers/committee';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetCommittee);

/** Section 7.1: the generated columns, CHECKs, unique indexes and foreign keys of `committee_terms`. */
describe('schema constraints (section 7.1)', () => {
  it('defaults: an empty seat list and checklist, version 1, no election', async () => {
    const w = await committeeWorld();
    const t = await rawTerm(w.society.id!, { status: 'DRAFT', tookChargeOn: null });
    const row = (await CommitteeTerm.findByPk(t.id!))!;
    expect(row.members).toEqual([]);
    expect(row.handoverChecklist).toEqual([]);
    expect(row.version).toBe(1);
    expect(row.electionId).toBeNull();
  });

  it('CHECKs: kind, source, status, historical must be ENDED, end after start, strength 3 to 25, election needs an election id', async () => {
    const w = await committeeWorld();
    const bad = (o: Record<string, unknown>, re: RegExp) =>
      expect(rawTerm(w.society.id!, o as never)).rejects.toThrow(re);
    await bad({ kind: 'OTHER' }, /ck_ct_kind|Check constraint/i);
    await bad({ source: 'IMPORT' }, /ck_ct_source|Check constraint/i);
    await bad({ status: 'DONE' }, /ck_ct_status|Check constraint/i);
    await bad({ source: 'HISTORICAL', status: 'ACTIVE' }, /ck_ct_historical|Check constraint/i);
    await bad({ endDate: '2024-04-01' }, /ck_ct_dates|Check constraint/i);
    await bad({ endDate: '2024-03-01' }, /ck_ct_dates|Check constraint/i);
    await bad({ strength: 2 }, /ck_ct_strength|Check constraint/i);
    await bad({ strength: 26 }, /ck_ct_strength|Check constraint/i);
    await bad({ source: 'ELECTION', status: 'DRAFT', electionId: null }, /ck_ct_election|Check constraint/i);
    expect(await CommitteeTerm.count()).toBe(0);
    await rawTerm(w.society.id!, { source: 'HISTORICAL', status: 'ENDED' });
    await rawTerm(w.society.id!, { source: 'ELECTION', status: 'DRAFT', electionId: 5 });
  });

  it('the seat list holds at most 150 entries and the checklist at most 40, and both must be JSON arrays', async () => {
    const w = await committeeWorld();
    const t = await rawTerm(w.society.id!);
    const raw = (col: string, json: string) =>
      sequelize.query(`UPDATE committee_terms SET ${col} = :json WHERE id = :id`, {
        replacements: { json, id: t.id! },
      });
    const many = (n: number) => JSON.stringify(Array.from({ length: n }, () => ({})));
    await expect(raw('members', many(151))).rejects.toThrow(/ck_ct_members|Check constraint/i);
    await expect(raw('members', '{}')).rejects.toThrow(/ck_ct_members|Check constraint/i);
    await expect(raw('handoverChecklist', many(41))).rejects.toThrow(/ck_ct_checklist|Check constraint/i);
    await raw('members', many(150));
    await raw('handoverChecklist', many(40));
  });

  it('generated columns: currentSlot for ACTIVE and EXPIRED, draftSlot for DRAFT, electionSlot for a live election id', async () => {
    const w = await committeeWorld();
    const cols = async (id: number) =>
      (
        await sequelize.query<Record<string, number | null>>(
          'SELECT currentSlot, draftSlot, electionSlot FROM committee_terms WHERE id = :id',
          {
            replacements: { id },
            type: QueryTypes.SELECT,
          },
        )
      )[0]!;
    const s = w.society.id!;
    expect(await cols((await rawTerm(s, { status: 'EXPIRED' })).id!)).toEqual({
      currentSlot: s,
      draftSlot: null,
      electionSlot: null,
    });
    const draft = await rawTerm(s, { status: 'DRAFT', electionId: 9, source: 'ELECTION' });
    expect(await cols(draft.id!)).toEqual({ currentSlot: null, draftSlot: s, electionSlot: 9 });
    await draft.destroy();
    expect(await cols(draft.id!)).toEqual({ currentSlot: null, draftSlot: null, electionSlot: null });
    expect(
      await cols((await rawTerm(s, { status: 'ENDED', startDate: '2019-04-01', endDate: '2024-03-31' })).id!),
    ).toEqual({
      currentSlot: null,
      draftSlot: null,
      electionSlot: null,
    });
  });

  it('at most one current term and one draft per society (BR-10-1), one live term per election (BR-10-19)', async () => {
    const a = await committeeWorld();
    const b = await committeeWorld();
    await rawTerm(a.society.id!, { status: 'ACTIVE' });
    await expect(
      rawTerm(a.society.id!, { status: 'EXPIRED', startDate: '2019-04-01', endDate: '2024-03-31' }),
    ).rejects.toThrow(/Validation error|Duplicate/i);
    await rawTerm(b.society.id!, { status: 'ACTIVE' });
    await rawTerm(a.society.id!, { status: 'ENDED', startDate: '2019-04-01', endDate: '2024-03-31' });
    await rawTerm(a.society.id!, { status: 'ENDED', startDate: '2014-04-01', endDate: '2019-03-31' });
    const d1 = await rawTerm(a.society.id!, {
      status: 'DRAFT',
      electionId: 31,
      source: 'ELECTION',
      tookChargeOn: null,
    });
    await expect(rawTerm(a.society.id!, { status: 'DRAFT', tookChargeOn: null })).rejects.toThrow(
      /Validation error|Duplicate/i,
    );
    await d1.destroy();
    await rawTerm(a.society.id!, { status: 'DRAFT', tookChargeOn: null });
    const e = await rawTerm(b.society.id!, {
      status: 'DRAFT',
      electionId: 31,
      source: 'ELECTION',
      tookChargeOn: null,
    }).catch(x => x);
    expect(e).toBeInstanceOf(CommitteeTerm); // the earlier election draft was deleted, so the id is free again
    await expect(
      rawTerm(a.society.id!, {
        status: 'ENDED',
        electionId: 31,
        source: 'ELECTION',
        startDate: '2009-04-01',
        endDate: '2014-03-31',
      }),
    ).rejects.toThrow(/Validation error|Duplicate/i);
  });

  it('foreign keys: the society and the predecessor are RESTRICT', async () => {
    const w = await committeeWorld();
    await expect(rawTerm(999999)).rejects.toThrow(/fk_ct_society|foreign key/i);
    await expect(rawTerm(w.society.id!, { predecessorTermId: 999999 })).rejects.toThrow(
      /fk_ct_predecessor|foreign key/i,
    );
    const old = await rawTerm(w.society.id!, {
      status: 'ENDED',
      startDate: '2019-04-01',
      endDate: '2024-03-31',
    });
    await rawTerm(w.society.id!, { predecessorTermId: old.id! });
    await expect(
      sequelize.query('DELETE FROM committee_terms WHERE id = :id', { replacements: { id: old.id! } }),
    ).rejects.toThrow(/foreign key/i);
  });

  it('the indexes of section 7.1 exist', async () => {
    const rows = await sequelize.query<{ n: string }>(
      "SELECT DISTINCT INDEX_NAME AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'committee_terms'",
      { type: QueryTypes.SELECT },
    );
    expect(rows.map(r => r.n).sort()).toEqual(
      [
        'PRIMARY',
        'ix_ct_election',
        'ix_ct_predecessor',
        'ix_ct_society_status',
        'ix_ct_status_end',
        'uq_ct_current',
        'uq_ct_draft',
        'uq_ct_election',
      ].sort(),
    );
  });
});
