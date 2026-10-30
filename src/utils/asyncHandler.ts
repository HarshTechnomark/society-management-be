import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Wraps an async controller so a rejected promise reaches the error middleware. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
