import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * Unit id → "Property · Unit" for company screens (PM settlements) that only
 * store the rental unit id. Filled from the rental snapshot when the shell has
 * it; screens fall back to a neutral label, never the raw id.
 */
type UnitLabelLookup = (unitId: string) => string | undefined;
const UnitLabelContext = createContext<UnitLabelLookup>(() => undefined);

export function UnitLabelsProvider({ units, properties, children }: { units?: readonly { id?: string; propertyId?: string; unitNumber?: string | null }[]; properties?: readonly { id?: string; name?: string | null }[]; children: ReactNode }) {
  const lookup = useMemo<UnitLabelLookup>(() => {
    const names = new Map((properties ?? []).filter(property => property.id).map(property => [property.id!, property.name ?? undefined]));
    const labels = new Map<string, string>();
    for (const unit of units ?? []) {
      if (!unit.id || !unit.unitNumber) continue;
      const property = unit.propertyId ? names.get(unit.propertyId) : undefined;
      labels.set(unit.id, property ? `${property} · ${unit.unitNumber}` : unit.unitNumber);
    }
    return (unitId: string) => labels.get(unitId);
  }, [units, properties]);
  return <UnitLabelContext.Provider value={lookup}>{children}</UnitLabelContext.Provider>;
}

export function useUnitLabel(): UnitLabelLookup {
  return useContext(UnitLabelContext);
}
