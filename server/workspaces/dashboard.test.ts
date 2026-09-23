import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { companyScopeSchema } from "../../shared/company";
import { dashboardCompanySchema } from "../../shared/workspaces/contracts";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { createCompanyServices } from "../company/services";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { createWorkspaceReadPort } from "./port";

const amounts = (principalCents: string) => ({ principalCents, interestCents: "0", returnOfCapitalCents: "0", distributionCents: "0", feeCents: "0", balloonCents: "0" });

test("dashboard obligations net reversed payments instead of counting them as paid", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  const executor = await createSyntheticRuntimeExecutor(fixture.db);
  try {
    const services = createCompanyServices(executor, { accounting: { environment: {} }, time: { env: {} } });
    const { organizationId, entityId, actorId, propertyId } = SYNTHETIC_COMPANY;
    const scope = companyScopeSchema.parse({ organizationId, legalEntityId: entityId });
    const resolvePrincipal = (connection = executor) => loadAuthenticatedPrincipal(connection, { actorId, organizationId, role: "admin" });
    const access = { principal: await resolvePrincipal(), resolvePrincipal, transport: attestTransport("web") };
    const envelope = (payload: Record<string, unknown>, commandScope = scope) => {
      const operationId = randomUUID();
      return { operationId, idempotencyKey: `workspace-dashboard:${operationId}`, scope: commandScope, payload };
    };
    const execute = (kind: Parameters<typeof services.investors.execute>[0], command: ReturnType<typeof envelope>) => services.investors.execute(kind, command, access);

    const account = await execute("investor.account.create", envelope({ displayName: "Synthetic investor", newContact: { kind: "person", displayName: "Synthetic contact" } }, companyScopeSchema.parse({ organizationId })));
    const accountId = String(account.affectedRecordIds[0]);
    const instrument = await execute("investor.instrument.create", envelope({ accountId, name: "Synthetic note", kind: "private_loan", legalEntityId: entityId, propertyIds: [propertyId], projectIds: [], currency: "USD", committedCents: "100000", facePrincipalCents: "100000", effectiveFrom: "2026-01-01", maturityOn: "2027-01-01", ownershipBps: null, notes: null }));
    const instrumentId = String(instrument.affectedRecordIds[0]);
    const documentId = `synthetic-investor-contract-${randomUUID()}`;
    await fixture.db.query("INSERT INTO rent_ops_documents(id,type,state,file_name,mime_type,storage_key) VALUES ($1,'other','signed','synthetic-investor-contract.pdf','application/pdf',$2)", [documentId, `synthetic/${documentId}`]);
    const contract = await execute("investor.contract.create", envelope({ instrumentId, title: "Synthetic terms", kind: "promissory_note", status: "draft", effectiveFrom: "2026-01-01", signedOn: null, terms: { schedule: "monthly", paymentDay: 1, monthEndRule: "calendar_day_or_month_end", annualRate: null, preferredReturnRate: null, returnMultiple: null, fixedPaymentCents: "1000", principalPaymentCents: null, interestPaymentCents: null, returnOfCapitalCents: null, distributionCents: null, balloonCents: null, originalPrincipalCents: "100000", maturityTotalCents: null, fixedProfitCents: null, maturityPayoffCents: null, thirdPartyInstallmentCents: null, investorSpreadCents: null, unknownComponentKinds: [], interestOnly: false, dayCount: "actual_365" }, sourceDocumentIds: [documentId] }));
    const contractId = String(contract.affectedRecordIds[0]);
    const versionId = String(contract.affectedRecordIds[1]);
    await fixture.db.query("UPDATE company_investor_contract_versions SET status='active', approved_by='synthetic-test' WHERE organization_id=$1 AND id=$2", [organizationId, versionId]);
    await fixture.db.query("UPDATE company_investor_contracts SET status='active', current_version_id=$3 WHERE organization_id=$1 AND id=$2", [organizationId, contractId, versionId]);
    await execute("investor.obligation.generate", envelope({ instrumentId, contractId, fromMonth: "2026-02-01", throughMonth: "2026-04-01" }));
    const obligations = await fixture.db.query<{ id: string; period_month: string | Date }>(
      "SELECT id, period_month FROM company_investor_obligations WHERE organization_id=$1 AND instrument_id=$2 ORDER BY period_month", [organizationId, instrumentId]);
    const [february, march] = obligations.rows.map(row => row.id);
    assert.ok(february && march);

    const reversed = await execute("investor.payment.record", envelope({ accountId, instrumentId, contractId, obligationId: february, kind: "principal", method: "manual", paymentOn: "2026-01-20", periodMonth: "2026-02-01", currency: "USD", amounts: amounts("500") }));
    await execute("investor.payment.reverse", envelope({ paymentId: String(reversed.affectedRecordIds[0]), reason: "Synthetic correction", paymentOn: "2026-01-21" }));
    await execute("investor.payment.record", envelope({ accountId, instrumentId, contractId, obligationId: march, kind: "principal", method: "manual", paymentOn: "2026-01-22", periodMonth: "2026-03-01", currency: "USD", amounts: amounts("300") }));

    const port = createWorkspaceReadPort(executor, { today: () => "2026-02-01" });
    const dashboard = dashboardCompanySchema.parse(await port.dashboard(actorId, organizationId, "2026-02-01"));
    const paid = new Map(dashboard.obligations.items.map(item => [item.obligationId, item.paidCents]));
    assert.equal(paid.get(february), "0", "a reversed $5.00 payment nets to zero, not paid");
    assert.equal(paid.get(march), "300", "an unreversed payment still counts");

    // The dashboard agrees with the investor page's recorded total for every obligation.
    const detail = await services.investors.get(access.principal, { scope, accountId });
    for (const obligation of detail.obligations) {
      if (paid.has(obligation.id)) assert.equal(paid.get(obligation.id), obligation.totalRecordedCents, `obligation ${obligation.periodMonth}`);
    }
  } finally { await fixture.close(); }
});
