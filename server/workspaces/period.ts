/** Drill-down rows returned per measure; the full list stays in the linked report. */
export const RECORD_LIMIT = 200;

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Inclusive first and last calendar day of an ISO month. */
export function monthBounds(month: string): { from: string; to: string } {
  const match = MONTH.exec(month);
  if (!match) throw new RangeError("Month must be YYYY-MM");
  const year = Number(match[1]); const monthIndex = Number(match[2]);
  const last = new Date(Date.UTC(year, monthIndex, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Rental report cents are legacy safe integers; convert without floating-point arithmetic. */
export function centsOf(value: number | null | undefined): bigint | null {
  if (value === null || value === undefined || !Number.isSafeInteger(value)) return null;
  return BigInt(value);
}
