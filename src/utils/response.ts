import type { Response } from 'express';

export interface Envelope<T> {
  success: true;
  data: T;
  message: string;
}

/** The only ways a controller writes a success response (BR-01-1). */
export function ok<T>(res: Response, data: T, message = 'OK', status = 200): Response {
  const body: Envelope<T> = { success: true, data, message };
  return res.status(status).json(body);
}

export function created<T>(res: Response, data: T, message = 'Created'): Response {
  return ok(res, data, message, 201);
}

export function noContent(res: Response): Response {
  return res.status(204).end();
}
