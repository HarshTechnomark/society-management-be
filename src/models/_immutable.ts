import type { Model } from 'sequelize';
import type { ModelHooks } from 'sequelize/types/hooks';

/**
 * Hooks of the immutable financial tables of module 11 (BR-11-6, section 7). `beforeUpdate` throws when a column outside
 * `mutable` changes (`updatedAt` always may); `beforeDestroy` and bulk destroy always throw; bulk updates run the per-row
 * hook so `Model.update` cannot bypass the rule. Raw SQL bypasses hooks, so services change these rows through the model.
 * `lockedWhen` limits the rule to rows in a state (a billing note is free until it is ISSUED); omitted = always locked.
 */
export function immutableHooks<M extends Model>(
  table: string,
  mutable: readonly string[],
  lockedWhen?: (row: M) => boolean,
): Partial<ModelHooks<M>> {
  const allowed = new Set<string>([...mutable, 'updatedAt']);
  return {
    beforeUpdate: row => {
      if (lockedWhen && !lockedWhen(row)) return;
      const bad = (row.changed() || []).filter(c => !allowed.has(String(c)));
      if (bad.length)
        throw new Error(`${table} row ${String(row.get('id'))} is immutable: ${bad.join(', ')}`);
    },
    beforeBulkUpdate: options => {
      options.individualHooks = true;
    },
    beforeDestroy: () => {
      throw new Error(`${table} rows are never deleted`);
    },
    beforeBulkDestroy: () => {
      throw new Error(`${table} rows are never deleted`);
    },
  };
}
