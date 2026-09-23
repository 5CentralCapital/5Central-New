import type { CompanyServices } from "../services";
import type { OperationReceipt } from "../../../shared/company";
import type { RentOpsQueryExecutor } from "../../rent-ops/repositories/postgres";
import { attestTransport, loadAuthenticatedPrincipal } from "../authorization";
import { SYNTHETIC_COMPANY } from "./synthetic-database";
import { syntheticForecastAssumptionsInput, SYNTHETIC_FORECAST_START } from "../../forecasting/testing/fixture";
import { REVIEW_DETECTOR_ACTOR, runReviewDetection } from "../../review-cases/detection";
import { PostgresRentOpsRepository } from "../../rent-ops/repositories/postgres";
import { RentOpsService } from "../../rent-ops/services/service";
import { nowIsoDate } from "../../rent-ops/domain/dates";

/**
 * Synthetic company data for the local demo and browser checks: a PM statement
 * (gross-to-net), an approved forecast scenario with a snapshot, and one review
 * detection pass. Everything goes through the shared command services.
 */
export async function seedCompanyDemo(executor: RentOpsQueryExecutor, services: CompanyServices): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("Synthetic company demo data is unavailable in production");
  const { organizationId, entityId, actorId, propertyId, unitId } = SYNTHETIC_COMPANY;
  const resolvePrincipal = (connection: RentOpsQueryExecutor = executor) => loadAuthenticatedPrincipal(connection, { actorId, organizationId, role: "admin" });
  const access = { principal: await resolvePrincipal(), resolvePrincipal, transport: attestTransport("web") };
  let sequence = 0;
  const envelope = (scope: Record<string, unknown>, payload: Record<string, unknown>, expectedRevision?: number) => {
    sequence += 1;
    return { operationId: `60000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`, idempotencyKey: `demo-company:${sequence}`, scope, ...(expectedRevision ? { expectedRevision } : {}), payload };
  };

  await services.accounting.operations.execute("accounting.pm_settlement.create", envelope({ organizationId, legalEntityId: entityId }, {
    propertyId, managerName: "Example Property Management", periodStart: "2026-08-01", periodEnd: "2026-08-31", currency: "USD",
    openingHeldCents: "25000", grossCollectionsCents: "412500", pmFeesCents: "33000", pmExpensesCents: "18500", otherDeductionsCents: "0",
    ownerRemittanceCents: "361000", closingHeldCents: "25000",
    lines: [
      { kind: "rent_receipt", unitId, description: "August rent", amountCents: "412500", occurredOn: "2026-08-03" },
      { kind: "pm_fee", description: "Management fee", amountCents: "33000" },
      { kind: "pm_expense", unitId, description: "Plumbing repair", amountCents: "18500", occurredOn: "2026-08-14" },
      { kind: "owner_remittance", description: "Owner draw", amountCents: "361000", occurredOn: "2026-08-31" },
    ],
  }), access);

  const created = await services.forecasting.execute("forecast.scenario.create", envelope({ organizationId }, {
    name: "Base case", kind: "base", startDate: SYNTHETIC_FORECAST_START, horizonWeeks: 13, horizonMonths: 36, reserveFloorCents: "2500000",
    assumptions: syntheticForecastAssumptionsInput(),
  }), access);
  const scenarioId = String(created.affectedRecordIds[0]);
  const snapshot = await services.forecasting.execute("forecast.snapshot.create", envelope({ organizationId }, { scenarioId, label: "Demo snapshot" }), access);
  const snapshotId = String(snapshot.affectedRecordIds.find(id => id !== scenarioId) ?? snapshot.affectedRecordIds[0]);
  const detail = await services.forecasting.get(access.principal, { scope: { organizationId }, scenarioId });
  try {
    await services.forecasting.execute("forecast.scenario.approve", envelope({ organizationId }, { scenarioId, snapshotId, acknowledgeIncompleteOpening: true, reason: "Synthetic demo: opening cash is intentionally not set" }, detail.recordRevision), access);
  } catch (error) { throw new Error(`Demo forecast approval failed: ${error instanceof Error ? error.message : String(error)}`); }

  // A rehab project with an approved budget, a commitment and a cost-to-complete override.
  const projectScope = { organizationId, legalEntityId: entityId, propertyId };
  let projectRevision = 0;
  const track = (receipt: { resultingRevisions: readonly { recordId: unknown; revision: unknown }[] }, id: string) => {
    const entry = receipt.resultingRevisions.find(item => String(item.recordId) === id);
    if (entry) projectRevision = Number(entry.revision);
  };
  const projectCommand = (kind: string, payload: Record<string, unknown>, expected?: number) => services.projects.execute(kind as never, { ...envelope(projectScope, payload, expected), effectiveDate: "2026-09-01" }, access) as Promise<OperationReceipt>;
  const executionCommand = (kind: string, payload: Record<string, unknown>, expected?: number) => services.projects.executeExecution!(kind as never, { ...envelope(projectScope, payload, expected), effectiveDate: "2026-09-01" }, access) as Promise<OperationReceipt>;
  const project = await projectCommand("project.create", { propertyId, name: "Unit 2A turn", projectType: "rehab", status: "active", startOn: "2026-09-01", targetOn: "2026-10-15" });
  const projectId = String(project.affectedRecordIds[0]); track(project, projectId);
  for (const [description, quantity, rateCents] of [["Paint and patch", "1", "240000"], ["Flooring LVP", "650", "450"], ["Kitchen cabinets", "1", "520000"]] as const) {
    track(await projectCommand("project.scope_item.create", { projectId, description, quantity, rateCents }), projectId);
  }
  track(await projectCommand("project.budget.approve", { projectId }, projectRevision), projectId);
  track(await projectCommand("project.draft_cost.create", { projectId, description: "Paint materials", amountCents: "61250", incurredOn: "2026-09-05", vendorName: "Example Supply" }), projectId);
  const commitment = await executionCommand("project.commitment.create", { projectId, description: "Cabinet install subcontract", originalCents: "480000", currency: "USD" }, projectRevision);
  track(commitment, projectId);
  track(await executionCommand("project.commitment.update", { commitmentId: String(commitment.affectedRecordIds[0]), status: "approved" }, projectRevision), projectId);

  // An investor note with a monthly schedule and debt terms.
  const companyScope = { organizationId };
  const investorCommand = (kind: string, payload: Record<string, unknown>, scope: Record<string, unknown> = { organizationId, legalEntityId: entityId }) => services.investors.execute(kind as never, envelope(scope, payload), access);
  const account = await investorCommand("investor.account.create", { displayName: "Example Lender", newContact: { kind: "person", displayName: "Example Lender" } }, companyScope);
  const accountId = String(account.affectedRecordIds[0]);
  const instrument = await investorCommand("investor.instrument.create", { accountId, name: "Bridge note", kind: "private_loan", legalEntityId: entityId, propertyIds: [propertyId], projectIds: [], currency: "USD", committedCents: "25000000", facePrincipalCents: "25000000", effectiveFrom: "2026-03-01", maturityOn: "2027-09-01", ownershipBps: null, notes: null });
  await investorCommand("investor.debt.create", {
    instrumentId: String(instrument.affectedRecordIds[0]), legalEntityId: entityId, debtKind: "private_loan", currency: "USD", originalPrincipalCents: "25000000", fundedCapitalCents: "25000000", outstandingPrincipalCents: "25000000",
    annualRate: "0.11", schedule: "monthly", paymentDay: 1, monthEndRule: "calendar_day_or_month_end", firstDueMonth: "2026-04-01", interestOnlyUntil: "2027-09-01",
    maturityOn: "2027-09-01", amortizationMonths: null, balloonCents: "25000000", dayCount: "30_360",
  });

  // The shared synthetic fixture dates a "future" tenancy's move-in in September 2026. Once that date
  // passes, the rent roll correctly refuses a future tenancy that has already moved in, so the local
  // demo advances such tenancies through the audited patch path before running detection.
  const rental = new RentOpsService(new PostgresRentOpsRepository(executor));
  const today = nowIsoDate();
  for (const tenancy of (await rental.snapshot()).tenancies) {
    if (tenancy.status === "future" && tenancy.actualMoveInOn && tenancy.actualMoveInOn <= today) {
      await rental.patchRecord("tenancy", tenancy.id, tenancy.recordRevision ?? 1, { status: "current" }, { actorSubject: actorId, occurredAt: new Date().toISOString() });
    }
  }
  await runReviewDetection(executor, organizationId, { actorId: REVIEW_DETECTOR_ACTOR });
}
