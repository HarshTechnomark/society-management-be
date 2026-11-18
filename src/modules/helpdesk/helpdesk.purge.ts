import { sequelize } from '../../models';

/**
 * Module 05 purge handler of module 15 (order 150: before modules 12 (120), 11 (110) and 08 (8), whose rows tickets reference; module 21 must use an order
 * above 150 because `work_orders.ticketId` references tickets). Deletes for the society, in this order: comments, upvotes, `tickets.currentAssignmentId` and
 * `mergedIntoTicketId` cleared, assignments, tickets, escalation rules, categories (children first), SLA policies. Returns the deleted count.
 */
export const PURGE_TABLES = [
  'ticket_comments',
  'ticket_upvotes',
  'ticket_assignments',
  'tickets',
  'escalation_rules',
  'ticket_categories',
  'sla_policies',
];

const BATCH = 1000;

async function deleteAll(societyId: number, table: string, order = 'id ASC'): Promise<number> {
  let total = 0;
  for (;;) {
    const [, meta] = await sequelize.query(
      `DELETE FROM ${table} WHERE societyId = :societyId ORDER BY ${order} LIMIT ${BATCH}`,
      {
        replacements: { societyId },
      },
    );
    const n = Number((meta as { affectedRows?: number })?.affectedRows ?? 0);
    total += n;
    if (n < BATCH) return total;
  }
}

export async function purgeHelpdesk(societyId: number): Promise<{ deleted: number; anonymised: number }> {
  let deleted = 0;
  deleted += await deleteAll(societyId, 'ticket_comments');
  deleted += await deleteAll(societyId, 'ticket_upvotes');
  await sequelize.query(
    'UPDATE tickets SET currentAssignmentId = NULL, mergedIntoTicketId = NULL WHERE societyId = :societyId',
    { replacements: { societyId } },
  );
  deleted += await deleteAll(societyId, 'ticket_assignments');
  deleted += await deleteAll(societyId, 'tickets');
  deleted += await deleteAll(societyId, 'escalation_rules');
  // children first: sub-categories have the higher ids than the parents they were created under
  deleted += await deleteAll(societyId, 'ticket_categories', 'IFNULL(parentId, 0) DESC, id DESC');
  deleted += await deleteAll(societyId, 'sla_policies');
  return { deleted, anonymised: 0 };
}
