/** The only source of "now" (BR-01-18). Tests freeze or move time with `setNow` / `advance`. */
let frozen: Date | null = null;

export const now = (): Date => (frozen ? new Date(frozen.getTime()) : new Date());

export const nowMs = (): number => (frozen ? frozen.getTime() : Date.now());

/** Test helper: freeze the clock at a moment. Pass `null` to return to real time. */
export const setNow = (d: Date | string | number | null): void => {
  frozen = d === null ? null : new Date(d);
};

/** Test helper: move a frozen clock forward (freezes at the real time first when not frozen). */
export const advance = (ms: number): void => {
  frozen = new Date((frozen ?? new Date()).getTime() + ms);
};

export const addMs = (d: Date, ms: number): Date => new Date(d.getTime() + ms);
export const addSeconds = (d: Date, s: number): Date => addMs(d, s * 1000);
export const addMinutes = (d: Date, m: number): Date => addMs(d, m * 60_000);
export const addHours = (d: Date, h: number): Date => addMs(d, h * 3_600_000);
export const addDays = (d: Date, days: number): Date => addMs(d, days * 86_400_000);

const IST_OFFSET_MS = 5.5 * 3_600_000;
/** Calendar date `YYYY-MM-DD` in Asia/Kolkata. */
export const istDate = (d: Date = now()): string =>
  new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
/** Hour and minute in Asia/Kolkata. */
export const istClock = (d: Date = now()): { hour: number; minute: number } => {
  const x = new Date(d.getTime() + IST_OFFSET_MS);
  return { hour: x.getUTCHours(), minute: x.getUTCMinutes() };
};
