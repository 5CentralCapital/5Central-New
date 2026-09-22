import type { OperationReceipt } from "../../../shared/company";
import type { WorkOrderCommandKind } from "../../../shared/work-orders";
import { attestTransport, loadAuthenticatedPrincipal } from "../authorization";
import type { RentOpsQueryExecutor } from "../../rent-ops/repositories/postgres";
import type { WorkOrderPort } from "../../work-orders/port";
import { SYNTHETIC_COMPANY } from "./synthetic-database";

/**
 * Synthetic demo work orders, written through the same command service as the
 * browser and Codex. Names and vendors are fictional; nothing is posted.
 */
export async function seedWorkOrderDemo(executor: RentOpsQueryExecutor, workOrders: WorkOrderPort): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("Synthetic work orders are unavailable in production");
  const { organizationId, entityId, actorId } = SYNTHETIC_COMPANY;
  const resolvePrincipal = (connection: RentOpsQueryExecutor = executor) => loadAuthenticatedPrincipal(connection, { actorId, organizationId, role: "admin" });
  const access = { principal: await resolvePrincipal(), resolvePrincipal, transport: attestTransport("web") };
  const scope = { organizationId, legalEntityId: entityId };
  let sequence = 0;
  const run = (kind: WorkOrderCommandKind, payload: Record<string, unknown>, expectedRevision?: number): Promise<OperationReceipt> => {
    sequence += 1;
    const operationId = `50000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
    return workOrders.execute(kind, { operationId, idempotencyKey: `demo-work-order:${sequence}`, scope, ...(expectedRevision ? { expectedRevision } : {}), payload }, access);
  };
  const create = async (payload: Record<string, unknown>): Promise<{ id: string; revision: number }> => {
    const receipt = await run("work_order.create", payload);
    return { id: String(receipt.affectedRecordIds[0]), revision: receipt.resultingRevisions[0]!.revision };
  };

  const sink = await create({
    propertyId: "demo-property-a", unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", title: "Kitchen sink leaking under cabinet",
    description: "Tenant reports a slow drip from the trap; cabinet floor is damp.", category: "plumbing", priority: "high",
    reportedOn: "2026-09-18", assignedTo: "Example Plumbing Co.", entryPermitted: true, estimatedCostCents: "18500",
  });
  const sinkScheduled = await run("work_order.status.change", { workOrderId: sink.id, status: "scheduled", scheduledOn: "2026-09-21" }, sink.revision);
  await run("work_order.status.change", { workOrderId: sink.id, status: "in_progress" }, sinkScheduled.resultingRevisions[0]!.revision);

  await create({
    propertyId: "demo-property-b", unitId: "demo-unit-b-1", tenancyId: "demo-tenancy-3", title: "No heat in back bedroom",
    description: "Thermostat calls for heat but the bedroom register stays cold.", category: "hvac", priority: "emergency",
    reportedOn: "2026-09-21", entryPermitted: true,
  });

  await create({
    propertyId: "demo-property-a", unitId: "demo-unit-a-4", title: "Unit 4A make-ready", category: "turnover", priority: "normal",
    description: "Paint, replace blinds, deep clean and replace smoke detector battery before listing.",
    status: "scheduled", reportedOn: "2026-09-15", scheduledOn: "2026-09-28", assignedTo: "Example Turnover Crew", estimatedCostCents: "145000",
  });

  const dishwasher = await create({
    propertyId: "demo-property-b", unitId: "demo-unit-b-2", title: "Dishwasher not draining", category: "appliance", priority: "normal",
    reportedOn: "2026-09-12", assignedTo: "Example Appliance Service", estimatedCostCents: "22000",
  });
  await run("work_order.status.change", { workOrderId: dishwasher.id, status: "on_hold", note: "Waiting on a replacement drain pump." }, dishwasher.revision);

  const screen = await create({
    propertyId: "demo-property-a", unitId: "demo-unit-a-1", tenancyId: "demo-tenancy-1", title: "Replace torn window screen",
    category: "exterior", priority: "low", reportedOn: "2026-09-02", assignedTo: "Example Handyman", estimatedCostCents: "7500",
  });
  const screenDone = await run("work_order.status.change", { workOrderId: screen.id, status: "completed", completedOn: "2026-09-05" }, screen.revision);
  await run("work_order.chargeback.set", { workOrderId: screen.id, amountCents: "7500", description: "Screen damage beyond normal wear" }, screenDone.resultingRevisions[0]!.revision);

  const pest = await create({
    propertyId: "demo-property-a", title: "Quarterly exterior pest treatment", category: "pest", priority: "low", reportedOn: "2026-09-10",
  });
  await run("work_order.note.add", { workOrderId: pest.id, note: "Treatment covers building perimeter only; no unit entry needed." });
}
