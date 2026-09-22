import { canonicalJsonSha256 } from "../company/commands/fingerprint";
import { isoDateSchema, isoTimestampSchema } from "../../shared/company";
import type { TimeEntryType, TimeJobcode, TimeSourceReference, TimeUser } from "../../shared/time";
import { timeJobcodeSchema, timeEntryTypeSchema, timeUserSchema } from "../../shared/time";
import type { TimeConnectionScope } from "../../shared/time";

export interface NormalizedTimeEntry {
  readonly source: TimeSourceReference;
  readonly providerTimesheetId: string;
  readonly providerUserId: string;
  readonly providerJobcodeId: string;
  readonly type: TimeEntryType;
  readonly start: string | null;
  readonly end: string | null;
  readonly date: string;
  readonly durationSeconds: number;
  readonly timezoneOffsetMinutes: number | null;
  readonly timezoneName: string | null;
  readonly onTheClock: boolean;
  readonly locked: boolean;
  readonly providerActive: boolean;
  readonly deletedAt: string | null;
  readonly notes: string;
  readonly lastModified: string;
  readonly sourceVersion: string;
  readonly bodyHash: string;
  readonly providerBody: Record<string, unknown>;
  readonly conflict: "none" | "invalid_duration";
}

export interface NormalizedDelete { readonly providerTimesheetId: string; readonly lastModified: string; readonly sourceVersion: string; readonly bodyHash: string; readonly providerBody: Record<string, unknown>; }
export interface NormalizedTimeUser extends TimeUser { readonly providerBody: Record<string, unknown>; readonly bodyHash: string; }
export interface NormalizedTimeJobcode extends TimeJobcode { readonly providerBody: Record<string, unknown>; readonly bodyHash: string; }

function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function text(value: unknown, field: string, optional = false): string | null { if (value === undefined || value === null || value === "") return optional ? null : (() => { throw new Error(`${field} is required`); })(); if (typeof value !== "string" && typeof value !== "number") throw new Error(`${field} is invalid`); const result = String(value).trim(); if (!result || result.length > 4_000) throw new Error(`${field} is invalid`); return result; }
function providerId(value: unknown, field: string): string { const result = text(value, field); if (!result || !/^[A-Za-z0-9_.:-]+$/.test(result)) throw new Error(`${field} is invalid`); return result; }
function timestamp(value: unknown, field: string): string { const result = text(value, field); if (!result || !Number.isFinite(Date.parse(result))) throw new Error(`${field} is invalid`); return isoTimestampSchema.parse(new Date(result).toISOString()); }
function date(value: unknown, field: string): string { return isoDateSchema.parse(text(value, field)); }
function integer(value: unknown, field: string, max = 2_147_483_647): number { const result = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value; if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0 || result > max) throw new Error(`${field} is invalid`); return result; }
function bool(value: unknown, fallback = false): boolean { return value === undefined || value === null ? fallback : value === true || value === 1 || value === "1" || value === "true"; }
function localTime(value: unknown, field: string, optional = false): string | null { const result = text(value, field, optional); if (!result) return null; if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(result) || !Number.isFinite(Date.parse(result))) throw new Error(`${field} is invalid`); return result; }
function offsetMinutes(value: unknown, start: string | null): number | null { if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 24) return Math.round(value * 60); if (typeof value === "string" && /^-?\d+(?:\.\d+)?$/.test(value) && Math.abs(Number(value)) <= 24) return Math.round(Number(value) * 60); const match = start?.match(/([+-])(\d{2}):?(\d{2})$/); return match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : start?.endsWith("Z") ? 0 : null; }
function bodyHash(body: Record<string, unknown>): string { return canonicalJsonSha256(body); }
function source(scope: TimeConnectionScope, kind: "user" | "jobcode" | "timesheet", id: string, version: string): TimeSourceReference { return { provider: "quickbooks_time", ...scope, objectKind: kind, providerObjectId: id, sourceVersion: version }; }

export function normalizeTimeUser(scope: TimeConnectionScope, value: Record<string, unknown>): NormalizedTimeUser {
  const id = providerId(value.id, "Time user id"); const modified = timestamp(value.last_modified, "Time user last_modified");
  return { ...timeUserSchema.parse({ source: source(scope, "user", id, modified), providerUserId: id, firstName: text(value.first_name, "Time user first_name", true) ?? "", lastName: text(value.last_name, "Time user last_name", true) ?? "", displayName: [text(value.first_name, "Time user first_name", true), text(value.last_name, "Time user last_name", true)].filter(Boolean).join(" ") || `User ${id}`, email: text(value.email, "Time user email", true), active: bool(value.active, true), submittedTo: value.submitted_to ? date(value.submitted_to, "Time user submitted_to") : null, approvedTo: value.approved_to ? date(value.approved_to, "Time user approved_to") : null, lastModified: modified, deletedAt: null }), providerBody: value, bodyHash: bodyHash(value) };
}

export function normalizeTimeJobcode(scope: TimeConnectionScope, value: Record<string, unknown>): NormalizedTimeJobcode {
  const id = providerId(value.id, "Time jobcode id"); const modified = timestamp(value.last_modified, "Time jobcode last_modified");
  return { ...timeJobcodeSchema.parse({ source: source(scope, "jobcode", id, modified), providerJobcodeId: id, name: text(value.name, "Time jobcode name") ?? id, parentId: value.parent_id === undefined || value.parent_id === 0 || value.parent_id === "0" ? null : providerId(value.parent_id, "Time jobcode parent_id"), type: text(value.type, "Time jobcode type", true) ?? "", billable: bool(value.billable), active: bool(value.active, true), lastModified: modified, deletedAt: null }), providerBody: value, bodyHash: bodyHash(value) };
}

export function normalizeTimeEntry(scope: TimeConnectionScope, value: Record<string, unknown>, deleted = false): NormalizedTimeEntry {
  const id = providerId(value.id, "Time timesheet id"); const userId = providerId(value.user_id, "Time timesheet user_id"); const jobcodeId = providerId(value.jobcode_id, "Time timesheet jobcode_id"); const modified = timestamp(value.last_modified, "Time timesheet last_modified");
  const type = timeEntryTypeSchema.parse(text(value.type, "Time timesheet type"));
  const start = type === "regular" ? localTime(value.start, "Time timesheet start") : null; const end = type === "regular" ? localTime(value.end, "Time timesheet end", true) : null;
  const entryDate = date(value.date, "Time timesheet date"); const durationSeconds = integer(value.duration, "Time timesheet duration");
  let conflict: "none" | "invalid_duration" = "none";
  if (type === "regular" && start && end) { const elapsed = Math.round((Date.parse(end) - Date.parse(start)) / 1000); if (elapsed < 0 || elapsed !== durationSeconds) conflict = "invalid_duration"; }
  if (type === "regular" && !start) throw new Error("Regular timesheet start is required");
  if (type === "manual" && (value.start || value.end)) throw new Error("Manual timesheet cannot contain start or end");
  const hash = bodyHash(value); const sourceVersion = `${modified}:${hash}`;
  return { source: source(scope, "timesheet", id, sourceVersion), providerTimesheetId: id, providerUserId: userId, providerJobcodeId: jobcodeId, type, start, end, date: entryDate, durationSeconds, timezoneOffsetMinutes: offsetMinutes(value.tz, start), timezoneName: text(value.tz_str, "Time timesheet tz_str", true), onTheClock: bool(value.on_the_clock, type === "regular" && !end), locked: integer(value.locked ?? 0, "Time timesheet locked") > 0, providerActive: !deleted && bool(value.active, true), deletedAt: deleted ? modified : null, notes: text(value.notes, "Time timesheet notes", true) ?? "", lastModified: modified, sourceVersion, bodyHash: hash, providerBody: value, conflict };
}

export function normalizeTimeDeleted(scope: TimeConnectionScope, value: Record<string, unknown>): NormalizedDelete {
  const id = providerId(value.id, "Deleted Time timesheet id"); const modified = timestamp(value.last_modified, "Deleted Time timesheet last_modified"); const hash = bodyHash(value); return { providerTimesheetId: id, lastModified: modified, sourceVersion: `${modified}:${hash}`, bodyHash: hash, providerBody: value };
}
