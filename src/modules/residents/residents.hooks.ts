import { Op, type Transaction } from 'sequelize';
import { EmergencyProfile, JoinRequest, Resident, ResidentDocument, UnitResident } from '../../models';
import { now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { AUDIT, ENTITY, KYC_DOC_TYPES, OPEN_JOIN_STATUSES } from './residents.constants';
import { notifyAfterCommit, recipients } from './residents.notify';
import { residentPorts, touchReports } from './residents.ports';

/** Hooks of module 02 (BR-09-76, BR-09-77). They run in module 02's transaction and never block the user's change. */
const sys: Ctx = { requestId: 'module-02', ip: '', userAgent: '' };

export async function onUserMobileChanged(
  userId: number,
  oldMobile: string,
  newMobile: string,
  t: Transaction,
): Promise<void> {
  try {
    const rows = await Resident.findAll({ where: { userId }, transaction: t, lock: t.LOCK.UPDATE });
    for (const r of rows) {
      if (r.mobile === newMobile) continue;
      const clash = await Resident.findOne({
        where: { societyId: r.societyId, mobile: newMobile, id: { [Op.ne]: r.id! } },
        attributes: ['id'],
        transaction: t,
      });
      if (clash) {
        notifyAfterCommit(t, 'residents.mobile_conflict', r.societyId, recipients.editors, {
          name: r.name,
          link: '/residents',
        });
        continue;
      }
      const before = { mobile: r.mobile };
      r.mobile = newMobile;
      r.version += 1;
      await r.save({ transaction: t });
      await audit(
        sys,
        {
          action: AUDIT.mobileSynced,
          entityType: ENTITY.resident,
          entityId: r.id!,
          societyId: r.societyId,
          before: { mobile: before.mobile ?? oldMobile },
          after: { mobile: newMobile },
        },
        t,
      );
      touchReports(t, r.societyId);
    }
  } catch (err) {
    logger.error({ err, userId }, 'residents.onUserMobileChanged failed; the mobile change continues');
  }
}

export async function onUserAnonymised(userId: number, t: Transaction): Promise<void> {
  const rows = await Resident.findAll({ where: { userId }, transaction: t, lock: t.LOCK.UPDATE });
  for (const r of rows) {
    const open = await UnitResident.count({
      where: { societyId: r.societyId, residentId: r.id!, toDate: null },
      transaction: t,
    });
    const full = open === 0;
    r.userId = null;
    r.memberId = null;
    r.mobile = null;
    r.email = null;
    r.alternateMobile = null;
    r.overseasPhone = null;
    r.dateOfBirth = null;
    r.photoFileId = null;
    if (full) {
      r.name = 'Former resident';
      r.anonymisedAt = now();
      await EmergencyProfile.destroy({ where: { residentId: r.id! }, transaction: t });
      const docs = await ResidentDocument.findAll({
        where: { societyId: r.societyId, residentId: r.id!, docType: { [Op.in]: [...KYC_DOC_TYPES] } },
        transaction: t,
      });
      for (const d of docs) {
        const fileId = d.fileId;
        await d.destroy({ transaction: t });
        t.afterCommit(() => {
          void residentPorts().files.deleteFile(fileId);
        });
      }
    }
    r.version += 1;
    await r.save({ transaction: t });
    await audit(
      sys,
      {
        action: AUDIT.residentAnonymised,
        entityType: ENTITY.resident,
        entityId: r.id!,
        societyId: r.societyId,
        after: { fullyAnonymised: full },
      },
      t,
    );
    touchReports(t, r.societyId);
  }
  const pending = await JoinRequest.findAll({
    where: { userId, status: { [Op.in]: [...OPEN_JOIN_STATUSES] } },
    transaction: t,
  });
  for (const j of pending) {
    j.status = 'WITHDRAWN';
    j.version += 1;
    await j.save({ transaction: t });
  }
}
