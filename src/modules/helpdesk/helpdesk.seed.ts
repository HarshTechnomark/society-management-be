import type { Transaction } from 'sequelize';
import { EscalationRule, SlaPolicy, TicketCategory, sequelize } from '../../models';
import type { CategoryScope, Designation, Priority, TargetType, TriggerType } from './helpdesk.constants';

/** Section 7.8 SLA policy "Standard" (the prototype's 4 h / 24 h / 72 h / 7 d). */
export const SEED_POLICY = {
  name: 'Standard',
  description: 'Default response and resolution targets',
  p1: [30, 240],
  p2: [240, 1440],
  p3: [720, 4320],
  p4: [1440, 10080],
} as const;

interface SeedCategory {
  name: string;
  scope: CategoryScope;
  priority: Priority;
  safety?: boolean;
  afterPhoto?: boolean;
  chargeable?: boolean;
  linksInvoice?: boolean;
  subs?: [string, Priority?][];
}
export const SEED_CATEGORIES: SeedCategory[] = [
  {
    name: 'Lift',
    scope: 'BUILDING',
    priority: 'P2',
    safety: true,
    subs: [['Lift stopped', 'P1'], ['Person stuck in lift', 'P1'], ['Door fault'], ['Noise or jerks']],
  },
  {
    name: 'Plumbing',
    scope: 'BOTH',
    priority: 'P3',
    afterPhoto: true,
    subs: [['Tap leak'], ['Seepage'], ['Blocked drain'], ['Pipe burst', 'P2']],
  },
  {
    name: 'Electrical',
    scope: 'BOTH',
    priority: 'P3',
    subs: [['Power failure', 'P2'], ['Common light not working'], ['Switch or socket']],
  },
  {
    name: 'Water supply',
    scope: 'BOTH',
    priority: 'P2',
    subs: [['No water'], ['Low pressure'], ['Dirty water']],
  },
  {
    name: 'Housekeeping',
    scope: 'BUILDING',
    priority: 'P3',
    subs: [['Garbage not collected'], ['Cleaning']],
  },
  {
    name: 'Security',
    scope: 'BUILDING',
    priority: 'P2',
    safety: true,
    subs: [['Gate or barrier'], ['CCTV'], ['Intercom']],
  },
  {
    name: 'Fire and gas safety',
    scope: 'BUILDING',
    priority: 'P1',
    safety: true,
    subs: [['Fire alarm'], ['Gas smell'], ['Extinguisher']],
  },
  { name: 'Garden', scope: 'BUILDING', priority: 'P4' },
  { name: 'Parking', scope: 'BOTH', priority: 'P3' },
  { name: 'Pest control', scope: 'BOTH', priority: 'P3' },
  { name: 'Carpentry', scope: 'PERSONAL', priority: 'P3', chargeable: true },
  { name: 'Noise', scope: 'PERSONAL', priority: 'P3' },
  { name: 'Internet and cable', scope: 'PERSONAL', priority: 'P4' },
  { name: 'Billing query', scope: 'PERSONAL', priority: 'P3', linksInvoice: true },
  { name: 'Gym equipment', scope: 'BUILDING', priority: 'P4' },
  { name: 'Other', scope: 'BOTH', priority: 'P3' },
];

interface SeedRule {
  name: string;
  triggerType: TriggerType;
  thresholdPercent: number | null;
  level: number;
  targetType: TargetType;
  role?: string;
  designation?: Designation;
  notifyAssignee?: boolean;
}
export const SEED_RULES: SeedRule[] = [
  {
    name: 'SLA warning',
    triggerType: 'RESOLUTION_SLA',
    thresholdPercent: 75,
    level: 1,
    targetType: 'ROLE',
    role: 'facility_manager',
  },
  {
    name: 'SLA breached',
    triggerType: 'RESOLUTION_SLA',
    thresholdPercent: 100,
    level: 2,
    targetType: 'DESIGNATION',
    designation: 'SECRETARY',
    notifyAssignee: true,
  },
  {
    name: 'SLA severe',
    triggerType: 'RESOLUTION_SLA',
    thresholdPercent: 200,
    level: 3,
    targetType: 'DESIGNATION',
    designation: 'CHAIRMAN',
  },
  {
    name: 'No response',
    triggerType: 'RESPONSE_SLA',
    thresholdPercent: 100,
    level: 1,
    targetType: 'ROLE',
    role: 'facility_manager',
  },
  {
    name: 'Resident escalation',
    triggerType: 'RESIDENT_REQUEST',
    thresholdPercent: null,
    level: 2,
    targetType: 'DESIGNATION',
    designation: 'SECRETARY',
  },
  {
    name: 'Low rating',
    triggerType: 'LOW_CSAT',
    thresholdPercent: null,
    level: 1,
    targetType: 'ROLE',
    role: 'facility_manager',
  },
];

/**
 * BR-15-65 `helpdesk.ensureSeeded(societyId, t)`: creates the default SLA policy, the category tree and the escalation rules of 7.8 that the
 * society does not have yet (idempotent by name; an existing default policy is kept). Returns what it created.
 */
export async function ensureSeeded(
  societyId: number,
  t?: Transaction,
): Promise<{ policies: number; categories: number; rules: number }> {
  const run = async (tx: Transaction) => {
    const out = { policies: 0, categories: 0, rules: 0 };
    const hasDefault = await SlaPolicy.findOne({
      where: { societyId, isDefault: true, status: 'ACTIVE' },
      transaction: tx,
      lock: tx.LOCK.UPDATE,
    });
    if (!hasDefault) {
      const named = await SlaPolicy.findOne({
        where: { societyId, name: SEED_POLICY.name, status: 'ACTIVE' },
        transaction: tx,
      });
      if (named) await named.update({ isDefault: true }, { transaction: tx });
      else {
        await SlaPolicy.create(
          {
            societyId,
            name: SEED_POLICY.name,
            description: SEED_POLICY.description,
            isDefault: true,
            p1ResponseMinutes: SEED_POLICY.p1[0],
            p1ResolutionMinutes: SEED_POLICY.p1[1],
            p2ResponseMinutes: SEED_POLICY.p2[0],
            p2ResolutionMinutes: SEED_POLICY.p2[1],
            p3ResponseMinutes: SEED_POLICY.p3[0],
            p3ResolutionMinutes: SEED_POLICY.p3[1],
            p4ResponseMinutes: SEED_POLICY.p4[0],
            p4ResolutionMinutes: SEED_POLICY.p4[1],
          },
          { transaction: tx },
        );
        out.policies++;
      }
    }
    let order = 0;
    for (const c of SEED_CATEGORIES) {
      order += 10;
      let top = await TicketCategory.findOne({
        where: { societyId, parentId: null, name: c.name, status: 'ACTIVE' },
        transaction: tx,
      });
      if (!top) {
        top = await TicketCategory.create(
          {
            societyId,
            parentId: null,
            name: c.name,
            scope: c.scope,
            defaultPriority: c.priority,
            defaultAssigneeType: 'NONE',
            isSafety: Boolean(c.safety),
            requiresAfterPhoto: Boolean(c.afterPhoto),
            isChargeable: Boolean(c.chargeable),
            linksInvoice: Boolean(c.linksInvoice),
            sortOrder: order,
          },
          { transaction: tx },
        );
        out.categories++;
      }
      let subOrder = 0;
      for (const [name, prio] of c.subs ?? []) {
        subOrder += 10;
        const exists = await TicketCategory.findOne({
          where: { societyId, parentId: top.id, name, status: 'ACTIVE' },
          transaction: tx,
        });
        if (exists) continue;
        await TicketCategory.create(
          {
            societyId,
            parentId: top.id,
            name,
            scope: c.scope,
            defaultPriority: prio ?? null,
            defaultAssigneeType: 'INHERIT',
            sortOrder: subOrder,
          },
          { transaction: tx },
        );
        out.categories++;
      }
    }
    for (const r of SEED_RULES) {
      const exists = await EscalationRule.findOne({ where: { societyId, name: r.name }, transaction: tx });
      if (exists) continue;
      await EscalationRule.create(
        {
          societyId,
          name: r.name,
          triggerType: r.triggerType,
          thresholdPercent: r.thresholdPercent,
          level: r.level,
          targetType: r.targetType,
          targetRoleKey: r.role ?? null,
          targetDesignation: r.designation ?? null,
          notifyAssignee: Boolean(r.notifyAssignee),
        },
        { transaction: tx },
      );
      out.rules++;
    }
    return out;
  };
  return t ? run(t) : sequelize.transaction(run);
}

/** Lazy seeding: the first helpdesk read or write of a society seeds it (one indexed check per call afterwards; no process cache, so truncating tests stay correct). */
export async function ensureSeededOnce(societyId: number, t?: Transaction): Promise<void> {
  const has = await SlaPolicy.count({
    where: { societyId, isDefault: true, status: 'ACTIVE' },
    transaction: t,
  });
  if (!has) await ensureSeeded(societyId, t);
}

/** Every society without a default SLA policy gets the seed (new societies are also seeded lazily). Returns the ids seeded. */
export async function backfillHelpdesk(): Promise<number[]> {
  const rows = await sequelize.query<{ id: number }>(
    `SELECT s.id FROM societies s WHERE NOT EXISTS (SELECT 1 FROM sla_policies p WHERE p.societyId = s.id AND p.defaultKey = 1)`,
    { type: 'SELECT' as never },
  );
  for (const r of rows) await ensureSeeded(Number(r.id));
  return rows.map(r => Number(r.id));
}
