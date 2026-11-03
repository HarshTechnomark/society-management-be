/** SQL for "younger than 18 on :today" (BR-09-4); a missing birth date counts as an adult. */
export const isMinorSql = (col: string): string =>
  `(${col} IS NOT NULL AND ${col} > DATE_SUB(:today, INTERVAL 18 YEAR))`;
