import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../../helpers/auth';
import { closeDb } from '../../../src/models';
import { approvalStore } from '../../../src/modules/residents/residents.part3.ports';
import { approvalStub } from '../../../src/modules/residents/residents.part2.ports';

afterAll(async () => {
  await closeDb();
});
beforeEach(() => {
  approvalStore.clear();
  approvalStub.reset();
});

describe('development approvals (stand-in for module 14)', () => {
  it('lists nothing when no request is waiting', async () => {
    const res = await request(app).get('/api/v1/dev/approvals');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('lists the pending requests of both parts', async () => {
    approvalStore.set(9001, {
      id: 9001,
      type: 'OWNERSHIP_TRANSFER',
      entityId: 5,
      societyId: 3,
      unitId: 7,
      status: 'PENDING',
    });
    approvalStub.requests.set(4, { id: 4, societyId: 3, type: 'MOVE_IN', entityId: 8, status: 'PENDING' });
    approvalStub.requests.set(5, { id: 5, societyId: 3, type: 'MOVE_IN', entityId: 9, status: 'APPROVED' });
    const res = await request(app).get('/api/v1/dev/approvals');
    expect(res.body.data.map((a: { id: number }) => a.id)).toEqual([4, 9001]);
  });

  it('answers 404 for an unknown request and 409 for one already decided', async () => {
    expect((await request(app).post('/api/v1/dev/approvals/12345/approve')).status).toBe(404);
    approvalStub.requests.set(6, { id: 6, societyId: 3, type: 'MOVE_IN', entityId: 9, status: 'REJECTED' });
    const res = await request(app).post('/api/v1/dev/approvals/6/approve');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_PENDING');
  });
});
