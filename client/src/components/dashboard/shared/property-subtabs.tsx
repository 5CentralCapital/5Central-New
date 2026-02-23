import { useState, useEffect, useCallback } from "react";

export interface Property {
  id: string;
  name: string;
  address?: string;
  city?: string;
  state?: string;
  units?: number;
  phase?: string;
}

interface PropertySubTabsProps {
  selected: string;
  onSelect: (id: string) => void;
  properties: Property[];
  showAll?: boolean;
  allLabel?: string;
}

/**
 * Sleek pill-style property subtabs.
 * Renders a horizontal row of property tabs with an optional "All" tab.
 * Design: minimalist warm brass accent on active, subtle hover lift.
 */
export function PropertySubTabs({ selected, onSelect, properties, showAll = false, allLabel = "All Properties" }: PropertySubTabsProps) {
  if (properties.length === 0) return null;

  return (
    <div style={{
      display: "flex",
      gap: 6,
      flexWrap: "wrap",
      padding: "2px 0",
      marginBottom: 14,
    }}>
      {showAll && (
        <button
          onClick={() => onSelect("all")}
          style={{
            padding: "6px 16px",
            fontSize: 12,
            fontWeight: selected === "all" ? 600 : 400,
            fontFamily: "var(--font-sans)",
            letterSpacing: "0.02em",
            border: "1px solid",
            borderColor: selected === "all" ? "var(--color-accent)" : "var(--color-border)",
            borderRadius: 20,
            cursor: "pointer",
            transition: "all 0.2s ease",
            background: selected === "all" ? "var(--color-accent)" : "transparent",
            color: selected === "all" ? "#fff" : "var(--color-text-muted)",
          }}
        >
          {allLabel}
        </button>
      )}
      {properties.map((p) => {
        const isActive = selected === p.id;
        return (
          <button
            key={p.id}
            onClick={() => onSelect(p.id)}
            style={{
              padding: "6px 16px",
              fontSize: 12,
              fontWeight: isActive ? 600 : 400,
              fontFamily: "var(--font-sans)",
              letterSpacing: "0.02em",
              border: "1px solid",
              borderColor: isActive ? "var(--color-accent)" : "var(--color-border)",
              borderRadius: 20,
              cursor: "pointer",
              transition: "all 0.2s ease",
              background: isActive ? "var(--color-accent)" : "transparent",
              color: isActive ? "#fff" : "var(--color-text-muted)",
            }}
          >
            {p.name}
            {p.units != null && (
              <span style={{
                marginLeft: 6,
                fontSize: 10,
                opacity: isActive ? 0.85 : 0.6,
                fontWeight: 400,
              }}>
                {p.units}u
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Hook to fetch properties from the API.
 * Returns properties array and loading state.
 * Caches results so multiple components don't re-fetch.
 */
let cachedProperties: Property[] | null = null;

export function useProperties(): { properties: Property[]; loading: boolean } {
  const [properties, setProperties] = useState<Property[]>(cachedProperties || []);
  const [loading, setLoading] = useState(!cachedProperties);

  useEffect(() => {
    if (cachedProperties) {
      setProperties(cachedProperties);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/properties/current");
        if (r.ok) {
          const ct = r.headers.get("content-type") || "";
          if (ct.includes("application/json")) {
            const data = await r.json();
            if (Array.isArray(data) && !cancelled) {
              cachedProperties = data;
              setProperties(data);
            }
          }
        }
      } catch {
        // Properties fetch failed — components will show empty tabs
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { properties, loading };
}

export default PropertySubTabs;
