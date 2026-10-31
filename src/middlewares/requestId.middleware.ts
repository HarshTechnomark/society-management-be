import { randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import { childLogger } from '../lib/logger';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'; // base32

/** `req_` + 12 random base32 characters (BR-01-2). */
export const newRequestId = (): string => {
  const bytes = randomBytes(12);
  let out = 'req_';
  for (const b of bytes) out += ALPHABET[b % 32];
  return out;
};

/** Gives every request an id and an empty context, and binds a logger to it. */
export const requestId: RequestHandler = (req, res, next) => {
  const requestId = newRequestId();
  req.ctx = {
    requestId,
    ip: req.ip ?? req.socket.remoteAddress ?? '',
    userAgent: String(req.get('user-agent') ?? '').slice(0, 255),
    permissions: new Set(),
    platformPermissions: new Set(),
    unitIds: [],
    unitLinks: [],
  };
  res.setHeader('X-Request-Id', requestId);
  res.locals.log = childLogger({ requestId });
  next();
};
