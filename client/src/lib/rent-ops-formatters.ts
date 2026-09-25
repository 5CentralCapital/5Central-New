// Reuse immutable formatters; keep all existing value validation at call sites.
export const usdCurrencyFormatter = new Intl.NumberFormat('en-US', {style:'currency',currency:'USD'});
export const usdAccountingFormatter = new Intl.NumberFormat('en-US', {style:'currency',currency:'USD',currencySign:'accounting'});
export const utcCalendarDateFormatter = new Intl.DateTimeFormat('en-US', {month:'short',day:'numeric',year:'numeric',timeZone:'UTC'});
const utcShortDateFormatter = new Intl.DateTimeFormat('en-US', {month:'short',day:'numeric',timeZone:'UTC'});
const utcMonthFormatter = new Intl.DateTimeFormat('en-US', {month:'short',year:'numeric',timeZone:'UTC'});
const localTimeFormatter = new Intl.DateTimeFormat('en-US', {hour:'numeric',minute:'2-digit'});
const localDateTimeFormatter = new Intl.DateTimeFormat('en-US', {month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'});

/*
 * One set of display rules for dates and times across the manager
 * (design audit F3):
 * - tables: "Jun 1" in the reference year, "Jun 1, 2025" otherwise
 * - headers and fields: "Sep 24, 2026"
 * - months: "Sep 2026"
 * - times: "11:29 AM" today, "Sep 23, 11:29 AM" otherwise; never seconds
 * Date-only values ("YYYY-MM-DD") are calendar dates and are read at UTC midnight.
 */

function calendarDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return undefined;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : undefined;
}

/** "Jun 1" when the date falls in the reference year (default: this year), otherwise "Jun 1, 2025". */
export function formatTableDate(value: unknown, referenceYear = new Date().getFullYear()): string | undefined {
  const date = calendarDate(value);
  if (!date) return undefined;
  return date.getUTCFullYear() === referenceYear ? utcShortDateFormatter.format(date) : utcCalendarDateFormatter.format(date);
}

/** "Sep 24, 2026". */
export function formatLongDate(value: unknown): string | undefined {
  const date = calendarDate(value);
  return date ? utcCalendarDateFormatter.format(date) : undefined;
}

/** "Sep 2026" for a "YYYY-MM" or date value. */
export function formatMonthLabel(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d{4}-\d{2}$/.test(value.trim())) return formatMonthLabel(`${value.trim()}-01`);
  const date = calendarDate(value);
  return date ? utcMonthFormatter.format(date) : undefined;
}

/** A timestamp without seconds: "11:29 AM" when it is today, otherwise "Sep 23, 2026, 11:29 AM". */
export function formatTimestamp(value: unknown, now = new Date()): string | undefined {
  const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) return undefined;
  const sameDay = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay ? localTimeFormatter.format(date) : localDateTimeFormatter.format(date);
}

/** "just now", "5 min ago", "3 hr ago", then the timestamp. */
export function formatRelativeTime(value: unknown, now = new Date()): string | undefined {
  const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) return undefined;
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 0) return formatTimestamp(date, now);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 12 * 60) return `${Math.round(minutes / 60)} hr ago`;
  return formatTimestamp(date, now);
}

/** Whole days between two calendar dates (to − from). */
export function daysBetween(from: unknown, to: unknown): number | undefined {
  const start = calendarDate(from), end = calendarDate(to);
  if (!start || !end) return undefined;
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/** Display a stored name the way people write it, keeping the stored value untouched. */
export function displayPersonName(value: string | null | undefined): string {
  const text = (value ?? '').trim().replace(/\s+/g, ' ');
  if (!text) return '';
  // Only fix names typed entirely in lower or upper case; leave mixed case (McElwee, de la Cruz) alone.
  if (text !== text.toLowerCase() && text !== text.toUpperCase()) return text;
  return text.toLowerCase().replace(/(^|[\s'-])([a-z\u00e0-\u00ff])/g, (_, separator: string, letter: string) => separator + letter.toUpperCase());
}

/** Initials for an avatar from a name or email: "Michael McElwee" → "MM", "michael@…" → "M". */
export function initialsFor(nameOrEmail: string | null | undefined): string {
  const text = (nameOrEmail ?? '').trim();
  if (!text) return '·';
  const local = text.includes('@') ? text.split('@')[0] : text;
  const parts = local.split(/[\s._-]+/).filter(Boolean);
  if (!parts.length) return '·';
  return (parts.length === 1 ? parts[0].charAt(0) : `${parts[0].charAt(0)}${parts[parts.length - 1].charAt(0)}`).toUpperCase();
}
