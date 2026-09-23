import { forecastAssumptionsSchema, type ForecastAssumptions, type ForecastAssumptionsInput } from "../../../shared/forecasting/assumptions";
import type { ForecastOpeningItem } from "../../../shared/forecasting/result";
import type { ForecastEngineInput, ForecastScenarioParameters, ForecastSourceData } from "../engine";

/**
 * Synthetic portfolio used by tests and the local demo. Every name and amount
 * is invented; no company, tenant or lender data is represented.
 */
export const SYNTHETIC_FORECAST_CUTOFF = "2026-12-27";
export const SYNTHETIC_FORECAST_START = "2026-12-28";

export function syntheticForecastAssumptionsInput(): ForecastAssumptionsInput {
  return {
    schemaVersion: 1,
    currency: "USD",
    actualsCutoff: SYNTHETIC_FORECAST_CUTOFF,
    leasing: {
      renewOnExpiry: true, renewalTermMonths: 12, newLeaseTermMonths: 12, makeReadyDays: 10, vacancyDays: 20,
      annualRentGrowthBps: 300, newLeaseConcessionCents: "25000", collectionsBps: 9_700, badDebtBps: 100,
      collectionLagDays: 4, subsidyLagDays: 6, depositMonths: 1, depositReturnDays: 15,
    },
    properties: [
      { propertyId: "prop-a", name: "Example Court", fixedAsset: { costBasisCents: "90000000", accumulatedDepreciationCents: "12000000", depreciableBasisCents: "72000000", usefulLifeMonths: 330, placedInServiceOn: "2019-06-01" },
        propertyManager: { managed: true, feeBps: 800, remittanceLagDays: 10 } },
      { propertyId: "prop-b", name: "Sample Row", fixedAsset: { costBasisCents: "40000000", accumulatedDepreciationCents: "3000000", depreciableBasisCents: "32000000", usefulLifeMonths: 330, placedInServiceOn: "2022-03-01" } },
    ],
    units: [
      { unitId: "a-1", propertyId: "prop-a", label: "A-1", status: "occupied", currentRentCents: "150000", subsidyCents: "60000", marketRentCents: "155000", leaseEndOn: "2027-03-31", depositCents: "150000" },
      { unitId: "a-2", propertyId: "prop-a", label: "A-2", status: "occupied", currentRentCents: "140000", marketRentCents: "148000", leaseEndOn: "2027-02-28", renewOnExpiry: false, depositCents: "140000" },
      { unitId: "a-3", propertyId: "prop-a", label: "A-3", status: "vacant", marketRentCents: "145000", availableOn: "2027-01-10" },
      { unitId: "b-1", propertyId: "prop-b", label: "B-1", status: "offline", marketRentCents: "132500", newLeaseSubsidyCents: "50000", projectId: "proj-b" },
      { unitId: "b-2", propertyId: "prop-b", label: "B-2", status: "occupied", currentRentCents: "120000", marketRentCents: "125000" },
    ],
    expenses: [
      { id: "util-a", label: "Water and sewer", category: "utilities", propertyId: "prop-a", amountCents: "45000", frequency: "monthly", firstOn: "2027-01-15", paymentLagDays: 10 },
      { id: "ins-all", label: "Property insurance", category: "insurance", amountCents: "360000", frequency: "annual", firstOn: "2027-03-01", annualGrowthBps: 500 },
      { id: "tax-b", label: "Property taxes", category: "property_tax", propertyId: "prop-b", amountCents: "210000", frequency: "quarterly", firstOn: "2027-01-20", paidFromEscrow: false },
      { id: "maint", label: "Maintenance labor", category: "payroll", amountCents: "80000", frequency: "weekly", firstOn: "2027-01-01", laborEstimate: true },
      { id: "old-labor", label: "Legacy labor section", category: "payroll", amountCents: "99999", frequency: "weekly", firstOn: "2027-01-01", retired: true },
    ],
    projects: [
      { projectId: "proj-b", name: "Sample Row unit B-1 rehab", propertyId: "prop-b", openingCipCents: "500000", remainingCostCents: "3000000", laborEstimateCents: "400000",
        costStartOn: "2027-01-04", completionOn: "2027-04-30", paymentLagDays: 14, retainageBps: 1_000, retainageReleaseDays: 30, usefulLifeMonths: 180,
        drawLoanId: "loan-b", drawBps: 8_000, drawLagDays: 10 },
    ],
    loans: [
      { id: "loan-a", label: "Example Court mortgage", lender: "Sample Bank", principalCents: "50000000", annualRateBps: 650, dayCount: "30_360", paymentDay: 1,
        firstPaymentOn: "2027-01-01", amortizationMonths: 300, maturityOn: "2029-06-01", escrowMonthlyCents: "50000", propertyId: "prop-a" },
      { id: "loan-b", label: "Sample Row construction line", lender: "Sample Credit Union", principalCents: "0", annualRateBps: 900, dayCount: "actual_360", paymentDay: 1,
        firstPaymentOn: "2027-02-01", maturityOn: "2028-12-01", propertyId: "prop-b" },
    ],
    refinances: [
      { id: "refi-b", label: "Sample Row permanent loan", closeOn: "2027-09-15", payoffLoanIds: ["loan-b"],
        newLoan: { id: "loan-c", label: "Sample Row permanent", lender: "Sample Life Co", principalCents: "5500000", annualRateBps: 600, dayCount: "30_360", paymentDay: 1,
          firstPaymentOn: "2027-11-01", amortizationMonths: 360, maturityOn: "2037-10-01", propertyId: "prop-b" },
        closingCostsCents: "85000", prepaymentCostsCents: "0", reserveCents: "150000" },
    ],
    investorFlows: [
      { id: "dist-q", label: "Quarterly distribution", kind: "distribution", amountCents: "500000", frequency: "quarterly", firstOn: "2027-03-31" },
    ],
    ownerItems: [{ id: "owner-draw", label: "Owner household draw", amountCents: "-250000", frequency: "monthly", firstOn: "2027-01-05" }],
    timeActuals: [
      { id: "ta-1", workedOn: "2027-01-13", projectId: "proj-b", amountCents: "90000", sourceId: "time:synthetic-1" },
      { id: "ta-2", workedOn: "2027-01-06", expenseId: "maint", amountCents: "76500", sourceId: "time:synthetic-2" },
    ],
    overrides: [],
  };
}

export function syntheticForecastAssumptions(patch: (draft: ForecastAssumptionsInput) => void = () => {}): ForecastAssumptions {
  const draft = syntheticForecastAssumptionsInput();
  patch(draft);
  return forecastAssumptionsSchema.parse(draft);
}

export function syntheticForecastSources(): ForecastSourceData {
  const item = (key: string, amountCents: string | null, state: ForecastOpeningItem["state"] = amountCents === null ? "unknown" : "sourced"): ForecastOpeningItem => ({
    key, label: key, amountCents, asOf: amountCents === null ? null : SYNTHETIC_FORECAST_CUTOFF, state, source: "Synthetic source", sourceIds: amountCents === null ? [] : [`synthetic:${key}`],
  });
  return {
    items: [
      item("cash_operating", "12000000"), item("cash_restricted", "1000000"), item("rental_receivables", "350000"), item("pm_held_funds", "420000"),
      item("accounts_payable", "610000"), item("deposits_held", "590000"), item("investor_obligations", null), item("project_commitments", "1200000"),
    ],
    debtBalances: {},
  };
}

export function syntheticScenario(overrides: Partial<ForecastScenarioParameters> = {}): ForecastScenarioParameters {
  return { name: "Base", kind: "base", startDate: SYNTHETIC_FORECAST_START, horizonWeeks: 13, horizonMonths: 24, reserveFloorCents: "2500000", currency: "USD", ...overrides };
}

export function syntheticEngineInput(patch?: (draft: ForecastAssumptionsInput) => void, scenario?: Partial<ForecastScenarioParameters>): ForecastEngineInput {
  return { scenario: syntheticScenario(scenario), assumptions: syntheticForecastAssumptions(patch), sources: syntheticForecastSources() };
}
