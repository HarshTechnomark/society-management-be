import { Unit, UnitAdvance } from '../../models';
import { NotFoundError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import { ERR } from './payments.constants';
import { isoOrNull } from './payments.admin.dto';
import { advanceBalance } from './payments.advances';
import { n } from './payments.shared';

/** `GET /me/advances` and `GET /units/:unitId/advances` (8.7): balance and history of one flat, newest first. */
export async function advanceHistory(societyId: number, unitId: number, page: number, limit: number) {
  const unit = await Unit.findOne({ where: { id: unitId, societyId }, attributes: ['id'] });
  if (!unit) throw new NotFoundError(ERR.unitNotFound, 'Unit not found');
  const [balancePaise, total, rows] = await Promise.all([
    advanceBalance(societyId, unitId),
    UnitAdvance.count({ where: { societyId, unitId } }),
    UnitAdvance.findAll({
      where: { societyId, unitId },
      order: [['id', 'DESC']],
      limit,
      offset: (page - 1) * limit,
    }),
  ]);
  return {
    data: {
      unitId,
      balancePaise,
      entries: rows.map(r => ({
        id: n(r.id),
        entryType: r.entryType,
        amountPaise: n(r.amountPaise),
        balanceAfterPaise: n(r.balanceAfterPaise),
        narration: r.narration,
        createdAt: isoOrNull(r.createdAt),
      })),
    },
    pagination: pageMeta(page, limit, total),
  };
}
