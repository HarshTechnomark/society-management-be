import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validate } from '../src/middlewares/validate.middleware';
import { requestId } from '../src/middlewares/requestId.middleware';
import { errorHandler } from '../src/middlewares/error.middleware';
import { asyncHandler } from '../src/utils/asyncHandler';
import { ok } from '../src/utils/response';
import { NotFoundError } from '../src/utils/errors';

const app = express();
app.use(requestId, express.json());
app.post('/x', validate({ body: z.object({ name: z.string().min(2) }).strict() }), (req, res) =>
  ok(res, req.valid.body, 'Done', 201),
);
app.get(
  '/missing',
  asyncHandler(async () => {
    throw new NotFoundError('THING_NOT_FOUND', 'No such thing');
  }),
);
app.use(errorHandler);

describe('pipeline', () => {
  it('throws NotFoundError as a 404 envelope with code and request id', async () => {
    const res = await request(app).get('/missing');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: 'THING_NOT_FOUND', message: 'No such thing' });
    expect(res.body.requestId).toMatch(/^req_/);
  });
  it('unknown body key gives 400 VALIDATION_FAILED listing the key', async () => {
    const res = await request(app).post('/x').send({ name: 'Raj', extra: 1 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.errors).toContainEqual({ field: 'extra', message: 'Unknown field' });
  });
  it('valid body reaches the controller through req.valid', async () => {
    const res = await request(app).post('/x').send({ name: 'Raj' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, data: { name: 'Raj' }, message: 'Done' });
  });
});
