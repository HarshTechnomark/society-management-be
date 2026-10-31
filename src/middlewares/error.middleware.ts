import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../utils/errors';
import { logger } from '../lib/logger';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', 'Route not found'));
};

/** The single error handler: every failure leaves as the envelope with the request id (BR-01-1, BR-01-2). */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.ctx?.requestId;
  if (err instanceof AppError) {
    if (err.headers) for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
    return res.status(err.status).json({
      success: false,
      code: err.code,
      message: err.message,
      ...(err.errors ? { errors: err.errors } : {}),
      requestId,
    });
  }
  // JSON that cannot be parsed
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    return res.status(400).json({
      success: false,
      code: 'VALIDATION_FAILED',
      message: 'Request body is not valid JSON',
      requestId,
    });
  }
  if ((err as { type?: string }).type === 'entity.too.large') {
    return res
      .status(413)
      .json({ success: false, code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large', requestId });
  }
  (res.locals.log ?? logger).error({ err, requestId }, 'unhandled error');
  return res
    .status(500)
    .json({ success: false, code: 'INTERNAL_ERROR', message: 'Something went wrong', requestId });
};
