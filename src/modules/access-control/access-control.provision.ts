import { Op, type Transaction } from 'sequelize';
import { MemberGrant, Permission, Role, RolePermission, Society, sequelize } from '../../models';
import { audit } from '../../utils/audit';
import { logger } from '../../lib/logger';
import type { Ctx } from '../../types/context';
import { flushAcl } from './access-control.cache';
import {
  ALL_DEFS,
  AUDIT,
  DEFAULT_ROLE_PERMISSIONS,
  DEFAULT_SOCIETY_ROLES,
  PLATFORM_ROLES,
  PLATFORM_ROLE_PERMISSIONS,
} from './access-control.permissions';
import { permissionIdMap } from './access-control.util';

const SYSTEM: Ctx = { requestId: 'seed', ip: '', userAgent: '' };

/** `provisionSocietyRoles(societyId, t)` (module 05, demo seeder): the 15 default roles with their matrix. Idempotent. */
export async function provisionSocietyRoles(societyId: number, t: Transaction): Promise<number> {
  let created = 0;
  for (const def of DEFAULT_SOCIETY_ROLES) {
    const existing = await Role.findOne({
      where: { societyId, key: def.key },
      paranoid: false,
      transaction: t,
    });
    if (existing) continue;
    const role = await Role.create(
      {
        societyId,
        scope: def.scope,
        key: def.key,
        name: def.name,
        description: def.description,
        isSystem: true,
        requiresMfa: def.requiresMfa,
        consumesSeat: def.consumesSeat,
        basedOnRoleId: null,
        version: 1,
        createdBy: null,
        updatedBy: null,
      },
      { transaction: t },
    );
    const keys = DEFAULT_ROLE_PERMISSIONS[def.key] ?? [];
    const ids = await permissionIdMap(keys, t);
    if (ids.size !== keys.length)
      throw new Error('The permission catalogue is not synced; run the catalogue sync first');
    await RolePermission.bulkCreate(
      keys.map(k => ({ societyId, roleId: role.id!, permissionId: ids.get(k)!, createdBy: null })) as never,
      { transaction: t },
    );
    await audit(
      SYSTEM,
      {
        action: AUDIT.roleCreated,
        entityType: 'role',
        entityId: role.id!,
        entityLabel: role.name,
        societyId,
        after: { key: def.key, scope: def.scope, permissionKeys: keys },
      },
      t,
    );
    created++;
  }
  return created;
}

export interface SyncReport {
  added: number;
  updated: number;
  removed: string[];
  platformRoles: number;
  societyRolesCreated: number;
}

/**
 * `access-control:sync-catalogue` (9.1, BR-03-1): upserts the catalogue, deletes keys that no longer exist (with their role
 * and grant rows), creates the platform roles, adds missing default roles to every society and flushes `acl:*`.
 */
export async function syncCatalogue(): Promise<SyncReport> {
  const report: SyncReport = { added: 0, updated: 0, removed: [], platformRoles: 0, societyRolesCreated: 0 };
  await sequelize.transaction(async tx => {
    const existing = new Map((await Permission.findAll({ transaction: tx })).map(p => [p.key, p]));
    for (const d of ALL_DEFS) {
      const row = existing.get(d.key);
      const values = {
        scope: d.scope,
        master: d.master,
        subMaster: d.subMaster,
        action: d.action,
        label: d.label,
        moduleNo: d.moduleNo,
        isPrivileged: d.isPrivileged,
        sortOrder: d.sortOrder,
      };
      if (!row) {
        await Permission.create({ key: d.key, description: null, ...values } as never, { transaction: tx });
        report.added++;
      } else if (
        Object.entries(values).some(
          ([k, v]) => (row as any)[k] !== v && !(typeof v === 'boolean' && Boolean((row as any)[k]) === v),
        )
      ) {
        await row.update(values, { transaction: tx });
        report.updated++;
      }
    }
    const keep = new Set(ALL_DEFS.map(d => d.key));
    const gone = [...existing.values()].filter(p => !keep.has(p.key));
    if (gone.length) {
      const ids = gone.map(p => p.id!);
      await RolePermission.destroy({ where: { permissionId: { [Op.in]: ids } }, transaction: tx });
      await MemberGrant.destroy({ where: { permissionId: { [Op.in]: ids } }, transaction: tx });
      await Permission.destroy({ where: { id: { [Op.in]: ids } }, transaction: tx });
      report.removed = gone.map(p => p.key);
    }
    // platform roles
    for (const def of PLATFORM_ROLES) {
      let role = await Role.findOne({
        where: { societyId: null, key: def.key },
        paranoid: false,
        transaction: tx,
      });
      if (!role) {
        role = await Role.create(
          {
            societyId: null,
            scope: 'platform',
            key: def.key,
            name: def.name,
            description: def.description,
            isSystem: true,
            requiresMfa: def.requiresMfa,
            consumesSeat: false,
            basedOnRoleId: null,
            version: 1,
            createdBy: null,
            updatedBy: null,
          },
          { transaction: tx },
        );
        report.platformRoles++;
      }
      const want = PLATFORM_ROLE_PERMISSIONS[def.key]!;
      const ids = await permissionIdMap(want, tx);
      const have = new Set(
        (await RolePermission.findAll({ where: { roleId: role.id! }, transaction: tx })).map(
          r => r.permissionId,
        ),
      );
      const missing = want.filter(k => !have.has(ids.get(k)!));
      if (missing.length)
        await RolePermission.bulkCreate(
          missing.map(k => ({
            societyId: null,
            roleId: role!.id!,
            permissionId: ids.get(k)!,
            createdBy: null,
          })) as never,
          { transaction: tx },
        );
    }
    for (const s of await Society.findAll({ attributes: ['id'], transaction: tx }))
      report.societyRolesCreated += await provisionSocietyRoles(s.id!, tx);
    if (report.added || report.removed.length || report.platformRoles || report.societyRolesCreated)
      await audit(
        SYSTEM,
        {
          action: AUDIT.catalogueSynced,
          entityType: 'permission_catalogue',
          entityId: 'catalogue',
          societyId: null,
          after: { ...report, removed: report.removed },
        },
        tx,
      );
  });
  await flushAcl();
  logger.info(report, 'permission catalogue synced');
  return report;
}
