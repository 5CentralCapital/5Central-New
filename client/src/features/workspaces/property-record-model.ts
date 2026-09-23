/** Property record tabs (roadmap §5 record pages). */
export const PROPERTY_RECORD_TABS = ["overview", "rent-roll", "financials", "projects", "work-orders", "documents"] as const;
export type PropertyRecordTab = (typeof PROPERTY_RECORD_TABS)[number];

export const PROPERTY_RECORD_TAB_LABELS: Record<PropertyRecordTab, string> = {
  overview: "Overview", "rent-roll": "Rent roll", financials: "Financials", projects: "Projects", "work-orders": "Work orders", documents: "Documents",
};

/** Earlier property tabs keep working in bookmarks: general/units/marketing → Overview, occupancy/recurring → Rent roll. */
export const LEGACY_PROPERTY_TAB_ALIASES: Readonly<Record<string, PropertyRecordTab>> = Object.freeze({
  general: "overview", units: "overview", marketing: "overview", occupancy: "rent-roll", recurring: "rent-roll",
});

export function canonicalPropertyTab(value: string | null | undefined): PropertyRecordTab {
  if (value && (PROPERTY_RECORD_TABS as readonly string[]).includes(value)) return value as PropertyRecordTab;
  return (value && LEGACY_PROPERTY_TAB_ALIASES[value]) || "overview";
}
