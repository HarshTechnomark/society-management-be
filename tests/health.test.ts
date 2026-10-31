import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { closeDb } from '../src/models';

const app = createApp();
afterAll(closeDb);

describe('health', () => {
  it('liveness answers in the envelope with a request id', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, message: 'OK', data: { status: 'ok' } });
    expect(res.headers['x-request-id']).toMatch(/^req_[a-z2-7]{12}$/);
  });

  it('readiness checks the database', async () => {
    const res = await request(app).get('/api/v1/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ db: 'ok' });
  });

  it('a route that does not exist and is not public asks for a session first (module 02)', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ success: false, code: 'UNAUTHENTICATED' });
    expect(res.body.requestId).toBe(res.headers['x-request-id']);
  });
});
