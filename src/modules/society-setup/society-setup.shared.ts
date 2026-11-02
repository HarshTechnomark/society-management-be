import { randomInt } from 'node:crypto';
import { AppError, NotFoundError } from '../../utils/errors';
import { getMany } from './society-setup.settings.service';

/** Small helpers shared by the services of module 08. */
export const staleVersion = (what = 'This record') =>
  new AppError(409, 'STALE_VERSION', `${what} changed since you opened it. Reload and try again.`);
export const invalidState = (message: string) => new AppError(409, 'INVALID_STATE', message);
export const buildingNotFound = () => new NotFoundError('BUILDING_NOT_FOUND', 'Building not found');
export const unitNotFound = () => new NotFoundError('UNIT_NOT_FOUND', 'Unit not found');
export const locationNotFound = () => new NotFoundError('LOCATION_NOT_FOUND', 'Location not found');
export const holidayNotFound = () => new NotFoundError('HOLIDAY_NOT_FOUND', 'Holiday not found');

/** BR-08-17: floor labels come from the structure settings. */
export interface FloorLabels {
  ground: string;
  basementPrefix: string;
}
export async function floorLabelSettings(societyId: number): Promise<FloorLabels> {
  const v = await getMany(societyId, ['structure.groundFloorLabel', 'structure.basementPrefix']);
  return {
    ground: v['structure.groundFloorLabel'] as string,
    basementPrefix: v['structure.basementPrefix'] as string,
  };
}
export const floorLabel = (floor: number, l: FloorLabels): string =>
  floor === 0 ? l.ground : floor < 0 ? `${l.basementPrefix}${-floor}` : String(floor);

/** The node name of a floor: "Floor 3", "Ground floor", "Basement 1". */
export const floorNodeName = (floor: number): string =>
  floor === 0 ? 'Ground floor' : floor < 0 ? `Basement ${-floor}` : `Floor ${floor}`;

export const inFloorRange = (b: { basements: number; floorsAboveGround: number }, floor: number): boolean =>
  floor >= -b.basements && floor <= b.floorsAboveGround;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** BR-08-41: 12 random base62 characters, no personal data. */
export const newQrToken = (): string => Array.from({ length: 12 }, () => BASE62[randomInt(62)]).join('');

export const isUniqueViolation = (err: unknown): boolean =>
  (err as { name?: string })?.name === 'SequelizeUniqueConstraintError';
export const isForeignKeyViolation = (err: unknown): boolean =>
  (err as { name?: string })?.name === 'SequelizeForeignKeyConstraintError';

/** `YYYY-MM-DD` helpers on plain calendar dates (no time zone involved). */
export const ymdToUtc = (d: string): Date => new Date(`${d}T00:00:00.000Z`);
export const addDaysYmd = (d: string, n: number): string =>
  new Date(ymdToUtc(d).getTime() + n * 86_400_000).toISOString().slice(0, 10);
export const weekdayOf = (d: string): number => ymdToUtc(d).getUTCDay();
