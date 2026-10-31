import { z } from 'zod';

/** Standard list query (BR-01-7). `sortBy` is restricted to the endpoint's allowed columns. */
export const paginationQuery = <T extends readonly [string, ...string[]]>(
  sortColumns: T,
  defaultSort: T[number],
) =>
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sortBy: z.enum(sortColumns).default(defaultSort),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  });

export interface PageMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export const pageMeta = (page: number, limit: number, total: number): PageMeta => ({
  page,
  limit,
  total,
  totalPages: Math.max(1, Math.ceil(total / limit)),
});
