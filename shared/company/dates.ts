import { z } from "zod";

type Brand<Value, Name extends string> = Value & { readonly __brand: Name };

export type IsoDate = Brand<string, "IsoDate">;
export type IsoTimestamp = Brand<string, "IsoTimestamp">;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

export const isoDateSchema = z.string().refine(isIsoDate, "Expected a real YYYY-MM-DD calendar date").transform((value) => value as IsoDate);

export function isIsoTimestamp(value: unknown): value is IsoTimestamp {
  if (typeof value !== "string") return false;
  const match = ISO_TIMESTAMP.exec(value);
  if (!match || !isIsoDate(match[1])) return false;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return hours <= 23 && minutes <= 59 && seconds <= 59;
}

export const isoTimestampSchema = z.string()
  .refine(isIsoTimestamp, "Expected a UTC ISO-8601 timestamp")
  .transform((value) => value as IsoTimestamp);

export function compareIsoDates(left: IsoDate | string, right: IsoDate | string): -1 | 0 | 1 {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Business validity includes effectiveFrom and excludes effectiveTo. */
export const effectivePeriodSchema = z.object({
  effectiveFrom: isoDateSchema,
  effectiveTo: isoDateSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.effectiveTo !== undefined && value.effectiveTo <= value.effectiveFrom) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["effectiveTo"],
      message: "effectiveTo must follow effectiveFrom",
    });
  }
});

export const temporalMetadataSchema = z.object({
  effectiveDate: isoDateSchema,
  recordedAt: isoTimestampSchema,
}).strict();

export function nowIsoTimestamp(): IsoTimestamp {
  return isoTimestampSchema.parse(new Date().toISOString());
}
