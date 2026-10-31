import type { RequestHandler } from 'express';
import { z, type ZodType } from 'zod';
import { ValidationError, type FieldError } from '../utils/errors';

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

const toFieldErrors = (where: string, err: z.ZodError): FieldError[] =>
  err.issues.flatMap(i => {
    // Strict objects report unknown keys as one issue with `keys`; list each key (BR-01-4).
    if (i.code === 'unrecognized_keys')
      return i.keys.map(k => ({ field: [...i.path, k].join('.'), message: 'Unknown field' }));
    return [{ field: i.path.map(String).join('.') || where, message: i.message }];
  });

/**
 * Validates body, query and params with Zod and puts the parsed values on `req.valid` (BR-01-4).
 * Write body schemas with `z.object({...}).strict()` so unknown keys give `400 VALIDATION_FAILED` and the key is listed.
 */
export const validate =
  (schemas: Schemas): RequestHandler =>
  (req, _res, next) => {
    const errors: FieldError[] = [];
    const valid: Request['valid'] = { body: undefined, query: undefined, params: undefined };
    for (const part of ['params', 'query', 'body'] as const) {
      const schema = schemas[part];
      if (!schema) continue;
      const r = schema.safeParse(req[part] ?? {});
      if (r.success) valid[part] = r.data;
      else errors.push(...toFieldErrors(part, r.error));
    }
    if (errors.length) return next(new ValidationError(errors));
    req.valid = valid;
    next();
  };

type Request = import('express').Request;
