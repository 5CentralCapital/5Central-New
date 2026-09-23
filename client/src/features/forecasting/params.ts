/** Forecasting context parameters: section=forecasting&scenario=&property=&entity=&tab= */
export const FORECAST_TABS = ["cash", "income", "balance", "debt", "scenarios", "assumptions"] as const;
export type ForecastTab = (typeof FORECAST_TABS)[number];
export const FORECAST_TAB_LABELS: Readonly<Record<ForecastTab, string>> = {
  cash: "Cash", income: "Income", balance: "Balance sheet", debt: "Debt", scenarios: "Scenarios", assumptions: "Assumptions",
};

export interface ForecastingLocation {
  readonly scenarioId?: string;
  readonly tab: ForecastTab;
  readonly propertyId?: string;
  readonly entityId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,159}$/;

export function isForecastTab(value: unknown): value is ForecastTab {
  return typeof value === "string" && (FORECAST_TABS as readonly string[]).includes(value);
}

/** Tolerant parse: unknown or malformed values fall back to defaults. */
export function parseForecastingParams(params: URLSearchParams): ForecastingLocation {
  const scenario = params.get("scenario") ?? undefined;
  const property = params.get("property") ?? undefined;
  const entity = params.get("entity") ?? undefined;
  const tab = params.get("tab");
  return {
    tab: isForecastTab(tab) ? tab : "cash",
    ...(scenario && UUID.test(scenario) ? { scenarioId: scenario } : {}),
    ...(property && REFERENCE.test(property) ? { propertyId: property } : {}),
    ...(entity && UUID.test(entity) ? { entityId: entity } : {}),
  };
}

export function forecastingParams(location: ForecastingLocation, base: URLSearchParams = new URLSearchParams()): URLSearchParams {
  const params = new URLSearchParams(base);
  params.set("section", "forecasting");
  for (const key of ["scenario", "property", "entity", "tab"]) params.delete(key);
  if (location.scenarioId) params.set("scenario", location.scenarioId);
  if (location.propertyId) params.set("property", location.propertyId);
  if (location.entityId) params.set("entity", location.entityId);
  if (location.tab !== "cash") params.set("tab", location.tab);
  return params;
}
