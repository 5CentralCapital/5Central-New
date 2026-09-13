import type { AdminPersonView } from "./types";

type PhoneMethod = NonNullable<AdminPersonView["phoneMethods"]>[number];

export function normalizedPhone(value: string | undefined): string {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits ? digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits : (value ?? "").trim().toLowerCase();
}

/** Build a display/edit copy only; an explicit current phone wins over imported flags. */
export function currentPhoneMethods(person: AdminPersonView) {
  const current = person.phone?.trim();
  const currentKey = normalizedPhone(current);
  const groups = new Map<string, PhoneMethod>();
  for (const source of person.phoneMethods ?? []) {
    const number = source.value?.trim();
    if (!number) continue;
    const key = normalizedPhone(number);
    const existing = groups.get(key);
    if (!existing) { groups.set(key, { ...source, value: number }); continue; }
    const types = Array.from(new Set([existing.type, source.type].flatMap(type => type?.split(" / ").map(part => part.trim()).filter(Boolean) ?? [])));
    groups.set(key, {
      ...existing,
      type: types.length ? types.join(" / ") : undefined,
      isPrimary: existing.isPrimary === true || source.isPrimary === true ? true : existing.isPrimary ?? source.isPrimary,
      isTextReady: existing.isTextReady === undefined ? source.isTextReady : source.isTextReady === undefined ? existing.isTextReady : existing.isTextReady === source.isTextReady ? existing.isTextReady : undefined,
    });
  }
  const hasPreviousPrimary = Boolean(current && Array.from(groups).some(([key, method]) => method.isPrimary === true && key !== currentKey));
  if (current) groups.set(currentKey, { ...groups.get(currentKey), value: current, isPrimary: true });
  const rows = Array.from(groups).map(([key, method]) => ({ ...method, ...(current ? { isPrimary: key === currentKey } : {}) }));
  rows.sort((left, right) => Number(right.isPrimary === true) - Number(left.isPrimary === true));
  return { rows, hasPreviousPrimary };
}

/** Imported numeric type codes have no confirmed user-facing label. */
export function phoneTypeLabel(type: string | undefined): string | undefined {
  const labels = type?.split(" / ").map(label => label.trim()).filter(label => label && !/^\d+$/.test(label));
  return labels?.length ? labels.join(" / ") : undefined;
}
