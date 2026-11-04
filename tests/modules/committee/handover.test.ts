import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, CommitteeTerm, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { setRealtimeSink } from '../../../src/lib/realtime';
import { DEFAULT_HANDOVER_TEMPLATE } from '../../../src/modules/committee/committee.constants';
import { committeePortCalls } from '../../../src/modules/committee/committee.ports';
import type { HandoverItemJson } from '../../../src/modules/committee/committee.schemas';
import { nextPlaceholderFileId, placeholderFiles } from '../../../src/modules/societies/societies.ports';
import {
  adminClient,
  committeeWorld,
  holder,
  idem,
  rawTerm,
  resetCommittee,
  seatedFor,
  setRole,
  suspend,
} from '../../helpers/committee';
import { memberOf } from '../../helpers/society-setup';

const events: { event: string; payload: unknown }[] = [];
afterAll(async () => {
  setRealtimeSink(undefined);
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  await resetCommittee();
  events.length = 0;
  setRealtimeSink({
    emit: e => events.push(e as unknown as { event: string; payload: unknown }),
    disconnectSession: () => undefined,
  });
});

const checklist = (done: string[] = []): HandoverItemJson[] =>
  DEFAULT_HANDOVER_TEMPLATE.map((it, i) => ({
    itemId: `H${i + 1}`,
    title: it.title,
    ownerDesignation: it.ownerDesignation,
    status: done.includes(`H${i + 1}`) ? ('DONE' as const) : ('PENDING' as const),
    note: null,
    evidenceFileIds: [],
    updatedByUserId: null,
    updatedAt: null,
  }));

/** An ACTIVE term with a seated treasurer (signed in), secretary and chairman; the world's chairman `w.c` is not seated. */
async function world(o: Record<string, unknown> = {}) {
  const w = await committeeWorld();
  const lata = await holder(w, 1, 'Lata Menon');
  const arjun = await holder(w, 2, 'Arjun Shah');
  await setRole(w.society.id!, lata.user.id, 'treasurer');
  await setRole(w.society.id!, arjun.user.id, 'secretary');
  const term = await rawTerm(w.society.id!, {
    members: [await seatedFor(w, lata, 'S1', 'TREASURER'), await seatedFor(w, arjun, 'S2', 'SECRETARY')],
    handoverChecklist: checklist(),
    ...o,
  });
  return { w, term, lata, arjun, treasurer: await adminClient(lata), secretary: await adminClient(arjun) };
}
const url = (id: number, tail = '') => `/committee/terms/${id}/handover${tail}`;
const patch = (c: Awaited<ReturnType<typeof world>>['treasurer'], id: number, item: string, body: object) =>
  c('patch', url(id, `/items/${item}`), body);

describe('GET /committee/terms/:id/handover (8.10)', () => {
  it('lists the items with progress, owner names and per-caller canEdit', async () => {
    const x = await world({ handoverChecklist: checklist(['H1']) });
    await CommitteeTerm.update(
      {
        handoverChecklist: checklist(['H1']).map(i =>
          i.itemId === 'H1'
            ? {
                ...i,
                updatedByUserId: x.lata.user.id,
                updatedAt: '2026-10-30T06:30:00.000Z',
                note: 'HDFC letter',
              }
            : i,
        ),
      },
      { where: { id: x.term.id! } },
    );
    const r = await x.treasurer('get', url(x.term.id!));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      termId: x.term.id,
      completedAt: null,
      progress: { total: 10, done: 1, notApplicable: 0, pending: 9 },
    });
    const items = r.body.data.items;
    expect(items[0]).toMatchObject({
      itemId: 'H1',
      ownerDesignation: 'TREASURER',
      ownerName: 'Lata Menon',
      status: 'DONE',
      note: 'HDFC letter',
      evidenceFileIds: [],
      updatedByName: 'Lata Menon',
      updatedAt: '2026-10-30T06:30:00.000Z',
      canEdit: true,
    });
    expect(items[3]).toMatchObject({ itemId: 'H4', ownerName: 'Arjun Shah', canEdit: false });
    expect(items[8]).toMatchObject({
      itemId: 'H9',
      ownerDesignation: 'CHAIRMAN',
      ownerName: null,
      canEdit: false,
    });
    // a manager sees every item as editable
    const all = await x.w.c('get', url(x.term.id!));
    expect(all.body.data.items.every((i: { canEdit: boolean }) => i.canEdit)).toBe(true);
  });

  it('nothing is editable on an ended term', async () => {
    const x = await world();
    const draft = await rawTerm(x.w.society.id!, { status: 'ENDED', handoverChecklist: checklist() });
    const r = await x.w.c('get', url(draft.id!));
    expect(r.body.data.items.every((i: { canEdit: boolean }) => i.canEdit === false)).toBe(true);
  });

  it('a resident without settings.members.view is 403 PERMISSION_DENIED', async () => {
    const x = await world();
    const owner = await holder(x.w, 3, 'Plain Owner');
    const r = await owner.c('get', url(x.term.id!));
    expect([r.status, r.body.code]).toEqual([403, 'PERMISSION_DENIED']);
  });
});

describe('PATCH an item (8.10, BR-10-26, BR-10-27, T10-26)', () => {
  it('T10-26: the treasurer marks H1 DONE, is refused on H4 (SECRETARY), and the last item sets handoverCompletedAt', async () => {
    const x = await world();
    const ok = await patch(x.treasurer, x.term.id!, 'H1', {
      status: 'DONE',
      note: 'HDFC letter dated 10 Apr',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.items[0]).toMatchObject({
      status: 'DONE',
      note: 'HDFC letter dated 10 Apr',
      updatedByName: 'Lata Menon',
      canEdit: true,
    });
    expect(ok.body.data.progress).toMatchObject({ done: 1, pending: 9 });
    const denied = await patch(x.treasurer, x.term.id!, 'H4', { status: 'DONE' });
    expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    const row = async () => (await CommitteeTerm.findByPk(x.term.id!))!;
    expect((await row()).handoverChecklist[3]!.status).toBe('PENDING');
    expect((await row()).version).toBe(1); // BR-10-31: an item update does not bump the version

    const baseline = (await AuditLog.max<number, AuditLog>('id')) ?? 0;
    for (const id of ['H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9'])
      await patch(x.secretary, x.term.id!, id, { status: 'DONE' });
    expect((await row()).handoverCompletedAt).toBeNull();
    const last = await patch(x.secretary, x.term.id!, 'H10', {
      status: 'NOT_APPLICABLE',
      note: 'No court cases pending',
    });
    expect(last.status).toBe(200);
    expect(last.body.data.completedAt).not.toBeNull();
    expect(last.body.data.progress).toEqual({ total: 10, done: 9, notApplicable: 1, pending: 0 });
    expect((await row()).handoverCompletedAt).not.toBeNull();
    const logs = await AuditLog.findAll({ where: { societyId: x.w.society.id! } });
    const actions = logs.filter(l => l.id! > baseline).map(l => l.action);
    expect(actions.filter(a => a === 'committee.handover.item_updated')).toHaveLength(9);
    expect(actions.filter(a => a === 'committee.handover.completed')).toHaveLength(1);
  });

  it('setting an item back to PENDING clears the completion', async () => {
    const x = await world({
      handoverChecklist: checklist(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10']),
      handoverCompletedAt: new Date('2026-10-01T00:00:00Z'),
    });
    const r = await patch(x.secretary, x.term.id!, 'H3', { status: 'PENDING' });
    expect(r.status).toBe(200);
    expect(r.body.data.completedAt).toBeNull();
    expect((await CommitteeTerm.findByPk(x.term.id!))!.handoverCompletedAt).toBeNull();
  });

  it('NOT_APPLICABLE needs a note of 5 to 300 characters; the note may be cleared otherwise', async () => {
    const x = await world();
    for (const body of [{ status: 'NOT_APPLICABLE' }, { status: 'NOT_APPLICABLE', note: 'no' }]) {
      const r = await patch(x.secretary, x.term.id!, 'H4', body);
      expect([r.status, r.body.code], JSON.stringify(body)).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect((await patch(x.secretary, x.term.id!, 'H4', { note: 'x'.repeat(301) })).status).toBe(400);
    expect((await patch(x.secretary, x.term.id!, 'H4', {})).status).toBe(400);
    expect(
      (
        await patch(x.secretary, x.term.id!, 'H4', {
          status: 'NOT_APPLICABLE',
          note: 'Seal lost, new one ordered',
        })
      ).status,
    ).toBe(200);
    expect(
      (await patch(x.secretary, x.term.id!, 'H4', { status: 'DONE', note: null })).body.data.items[3].note,
    ).toBeNull();
  });

  it('a manager (settings.members.edit) may update any item; an item of a designation nobody holds needs the permission', async () => {
    const x = await world();
    expect((await patch(x.w.c, x.term.id!, 'H9', { status: 'DONE' })).status).toBe(200);
    const r = await patch(x.treasurer, x.term.id!, 'H9', { status: 'DONE' });
    expect(r.status).toBe(403);
  });

  it('404 HANDOVER_ITEM_NOT_FOUND for an unknown item; 400 for a malformed item id', async () => {
    const x = await world();
    const r = await patch(x.secretary, x.term.id!, 'H11', { status: 'DONE' });
    expect([r.status, r.body.code]).toEqual([404, 'HANDOVER_ITEM_NOT_FOUND']);
    expect((await patch(x.secretary, x.term.id!, 'H0', { status: 'DONE' })).status).toBe(400);
  });

  it('409 INVALID_STATE while the term is a DRAFT or ENDED (BR-10-26); an EXPIRED term accepts changes', async () => {
    const x = await world();
    const draft = await rawTerm(x.w.society.id!, { status: 'DRAFT', handoverChecklist: checklist() });
    const ended = await rawTerm(x.w.society.id!, { status: 'ENDED', handoverChecklist: checklist() });
    for (const id of [draft.id!, ended.id!]) {
      const r = await patch(x.w.c, id, 'H1', { status: 'DONE' });
      expect([r.status, r.body.code], String(id)).toEqual([409, 'INVALID_STATE']);
      const a = await x.w.c(
        'post',
        url(id, '/items'),
        { title: 'Extra item', ownerDesignation: null },
        { headers: idem() },
      );
      expect([a.status, a.body.code], String(id)).toEqual([409, 'INVALID_STATE']);
    }
    await CommitteeTerm.update({ status: 'EXPIRED' }, { where: { id: x.term.id! } });
    expect((await patch(x.secretary, x.term.id!, 'H1', { status: 'DONE' })).status).toBe(200);
  });

  it('evidence files: a full replacement, linked through the files port, unique and at most 5', async () => {
    const x = await world();
    const file = (purpose = 'HANDOVER_EVIDENCE', societyId = x.w.society.id!) => {
      const fileId = nextPlaceholderFileId();
      placeholderFiles.set(fileId, {
        fileId,
        societyId,
        purpose,
        name: 'letter.pdf',
        contentType: 'application/pdf',
        content: Buffer.from('x'),
        ownerUserId: null,
        status: 'CLEAN',
      });
      return fileId;
    };
    const [a, b] = [file(), file()];
    const r = await patch(x.treasurer, x.term.id!, 'H1', { status: 'DONE', evidenceFileIds: [a, b] });
    expect(r.status).toBe(200);
    expect(r.body.data.items[0].evidenceFileIds).toEqual([a, b]);
    expect(committeePortCalls.filter(c => c.fn === 'files.linkEvidence')).toHaveLength(1);
    // replacing with [b] keeps b without linking it again
    const again = await patch(x.treasurer, x.term.id!, 'H1', { evidenceFileIds: [b] });
    expect(again.body.data.items[0].evidenceFileIds).toEqual([b]);
    expect(committeePortCalls.filter(c => c.fn === 'files.linkEvidence')).toHaveLength(1);
    expect(
      (await patch(x.treasurer, x.term.id!, 'H1', { evidenceFileIds: [] })).body.data.items[0]
        .evidenceFileIds,
    ).toEqual([]);
    // wrong purpose, other society, unknown file: 422 FILE_NOT_LINKABLE and nothing saved
    for (const bad of [file('KYC_DOCUMENT'), file('HANDOVER_EVIDENCE', 999_999), 424242]) {
      const f = await patch(x.treasurer, x.term.id!, 'H1', { evidenceFileIds: [bad] });
      expect([f.status, f.body.code], String(bad)).toEqual([422, 'FILE_NOT_LINKABLE']);
    }
    const dup = await patch(x.treasurer, x.term.id!, 'H1', { evidenceFileIds: [a, a] });
    expect(dup.status).toBe(400);
    const six = await patch(x.treasurer, x.term.id!, 'H1', { evidenceFileIds: [1, 2, 3, 4, 5, 6] });
    expect(six.status).toBe(400);
    expect((await CommitteeTerm.findByPk(x.term.id!))!.handoverChecklist[0]!.evidenceFileIds).toEqual([]);
  });

  it('two people updating two items at once are both saved and the term version is unchanged (section 14)', async () => {
    const x = await world();
    const [r1, r2] = await Promise.all([
      patch(x.treasurer, x.term.id!, 'H1', { status: 'DONE' }),
      patch(x.secretary, x.term.id!, 'H4', { status: 'DONE' }),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const row = (await CommitteeTerm.findByPk(x.term.id!))!;
    expect([row.handoverChecklist[0]!.status, row.handoverChecklist[3]!.status]).toEqual(['DONE', 'DONE']);
    expect(row.version).toBe(1);
  });

  it('emits committee.changed with reason HANDOVER without names', async () => {
    const x = await world();
    await patch(x.secretary, x.term.id!, 'H4', { status: 'DONE', note: 'Seal received' });
    await new Promise(r => setTimeout(r, 30));
    const ev = events.find(e => e.event === 'committee.changed');
    expect(ev).toBeDefined();
    expect(JSON.stringify(ev)).toContain('"reason":"HANDOVER"');
    expect(JSON.stringify(ev)).not.toContain('Seal');
  });
});

describe('POST /committee/terms/:id/handover/items (8.10)', () => {
  it('adds a PENDING item with the next id, clears the completion and audits it', async () => {
    const x = await world({
      handoverChecklist: checklist(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10']),
      handoverCompletedAt: new Date('2026-10-01T00:00:00Z'),
    });
    const r = await x.secretary(
      'post',
      url(x.term.id!, '/items'),
      { title: 'Intercom panel handed over', ownerDesignation: 'SECRETARY' },
      { headers: idem() },
    );
    expect(r.status).toBe(201);
    expect(r.body.data.completedAt).toBeNull();
    expect(r.body.data.items).toHaveLength(11);
    expect(r.body.data.items[10]).toMatchObject({
      itemId: 'H11',
      status: 'PENDING',
      ownerDesignation: 'SECRETARY',
      canEdit: true,
    });
    expect(await AuditLog.count({ where: { action: 'committee.handover.item_added' } })).toBe(1);
  });

  it('refuses the 41st item with 422 HANDOVER_ITEM_LIMIT', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...checklist()[0]!, itemId: `H${i + 1}` }));
    const x = await world({ handoverChecklist: many });
    const r = await x.secretary(
      'post',
      url(x.term.id!, '/items'),
      { title: 'One too many', ownerDesignation: null },
      { headers: idem() },
    );
    expect([r.status, r.body.code]).toEqual([422, 'HANDOVER_ITEM_LIMIT']);
  });

  it('needs settings.members.edit (the treasurer holds view only), validates the body and honours Idempotency-Key', async () => {
    const x = await world();
    const body = { title: 'Fire NOC file handed over', ownerDesignation: null };
    const denied = await x.treasurer('post', url(x.term.id!, '/items'), body, { headers: idem() });
    expect([denied.status, denied.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    for (const bad of [
      { title: 'ab', ownerDesignation: null },
      { title: 'Fine title' },
      { ...body, extra: 1 },
      { title: 'Fine title', ownerDesignation: 'GUARD' },
    ]) {
      expect((await x.secretary('post', url(x.term.id!, '/items'), bad, { headers: idem() })).status).toBe(
        400,
      );
    }
    const key = idem();
    const first = await x.secretary('post', url(x.term.id!, '/items'), body, { headers: key });
    const second = await x.secretary('post', url(x.term.id!, '/items'), body, { headers: key });
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect((await CommitteeTerm.findByPk(x.term.id!))!.handoverChecklist).toHaveLength(11);
  });
});

describe('tenant isolation and society state (T10-29, T10-34)', () => {
  it("society A's users get 404 COMMITTEE_TERM_NOT_FOUND for society B's checklist", async () => {
    const a = await committeeWorld();
    const b = await world();
    for (const [m, p, body] of [
      ['get', url(b.term.id!), undefined],
      ['post', url(b.term.id!, '/items'), { title: 'Not yours', ownerDesignation: null }],
      ['patch', url(b.term.id!, '/items/H1'), { status: 'DONE' }],
    ] as const) {
      const r = await a.c(m, p, body, { headers: idem() });
      expect([r.status, r.body.code], `${m} ${p}`).toEqual([404, 'COMMITTEE_TERM_NOT_FOUND']);
    }
    expect((await CommitteeTerm.findByPk(b.term.id!))!.handoverChecklist[0]!.status).toBe('PENDING');
  });

  it('a suspended society reads the checklist and every write is 423 SOCIETY_SUSPENDED', async () => {
    const x = await world();
    await suspend(x.w.society.id!);
    expect((await x.w.c('get', url(x.term.id!))).status).toBe(200);
    const p = await x.w.c('patch', url(x.term.id!, '/items/H1'), { status: 'DONE' });
    expect([p.status, p.body.code]).toEqual([423, 'SOCIETY_SUSPENDED']);
    const a = await x.w.c(
      'post',
      url(x.term.id!, '/items'),
      { title: 'Nope not now', ownerDesignation: null },
      { headers: idem() },
    );
    expect([a.status, a.body.code]).toEqual([423, 'SOCIETY_SUSPENDED']);
  });

  it('a committee member with view only reads but cannot edit any item', async () => {
    const x = await world();
    const m = await memberOf(x.w.society, 'committee_member');
    expect((await m.c('get', url(x.term.id!))).status).toBe(200);
    expect((await m.c('patch', url(x.term.id!, '/items/H1'), { status: 'DONE' })).status).toBe(403);
  });
});
