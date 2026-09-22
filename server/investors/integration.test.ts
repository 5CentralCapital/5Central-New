import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { companyScopeSchema } from "../../shared/company";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { createCompanyServices } from "../company/services";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";

test("investor payment allocation and reversal preserve append-only history", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  const database = { ...fixture, executor: await createSyntheticRuntimeExecutor(fixture.db) };
  try {
    const services = createCompanyServices(database.executor, { accounting: { environment: {} }, time: { env: {} } });
    const { organizationId, entityId, actorId, propertyId } = SYNTHETIC_COMPANY;
    const scope = companyScopeSchema.parse({ organizationId, legalEntityId: entityId });
    const resolvePrincipal = (executor = database.executor) => loadAuthenticatedPrincipal(executor, { actorId, organizationId, role: "admin" });
    const access = { principal: await resolvePrincipal(), resolvePrincipal, transport: attestTransport("web") };
    const envelope = (payload: Record<string, unknown>, commandScope = scope) => {
      const operationId = randomUUID();
      return { operationId, idempotencyKey: `investor-integration:${operationId}`, scope: commandScope, payload };
    };
    const execute = (kind: Parameters<typeof services.investors.execute>[0], command: ReturnType<typeof envelope>) => services.investors.execute(kind, command, access);

    const account = await execute("investor.account.create", envelope({ displayName: "Synthetic investor", newContact: { kind: "person", displayName: "Synthetic contact" }, }, companyScopeSchema.parse({ organizationId })));
    const accountId = String(account.affectedRecordIds[0]);
    const instrument = await execute("investor.instrument.create", envelope({ accountId, name: "Synthetic note", kind: "private_loan", legalEntityId: entityId, propertyIds: [propertyId], projectIds: [], currency: "USD", committedCents: "100000", facePrincipalCents: "100000", effectiveFrom: "2026-01-01", maturityOn: "2027-01-01", ownershipBps: null, notes: null }));
    const instrumentId = String(instrument.affectedRecordIds[0]);
    const documentId = `synthetic-investor-contract-${randomUUID()}`;
    await database.db.query("INSERT INTO rent_ops_documents(id,type,state,file_name,mime_type,storage_key) VALUES ($1,'other','signed','synthetic-investor-contract.pdf','application/pdf',$2)", [documentId, `synthetic/${documentId}`]);
    const contract = await execute("investor.contract.create", envelope({ instrumentId, title: "Synthetic terms", kind: "promissory_note", status: "draft", effectiveFrom: "2026-01-01", signedOn: null, terms: { schedule: "monthly", paymentDay: 1, monthEndRule: "calendar_day_or_month_end", annualRate: null, preferredReturnRate: null, returnMultiple: null, fixedPaymentCents: "1000", principalPaymentCents: null, interestPaymentCents: null, returnOfCapitalCents: null, distributionCents: null, balloonCents: null, originalPrincipalCents: "100000", maturityTotalCents: null, fixedProfitCents: null, maturityPayoffCents: null, thirdPartyInstallmentCents: null, investorSpreadCents: null, unknownComponentKinds: [], interestOnly: false, dayCount: "actual_365" }, sourceDocumentIds: [documentId] }));
    const contractId = String(contract.affectedRecordIds[0]);
    const versionId = String(contract.affectedRecordIds[1]);
    await database.db.query("UPDATE company_investor_contract_versions SET status='active', approved_by='synthetic-test' WHERE organization_id=$1 AND id=$2", [organizationId, versionId]);
    await database.db.query("UPDATE company_investor_contracts SET status='active', current_version_id=$3 WHERE organization_id=$1 AND id=$2", [organizationId, contractId, versionId]);
    const generated = await execute("investor.obligation.generate", envelope({ instrumentId, contractId, fromMonth: "2026-02-01", throughMonth: "2027-02-01" }));
    assert.equal(generated.affectedRecordIds.length, 12);
    const obligationRows = await database.db.query<{ id: string; period_month: string | Date; due_on: string | Date }>(`SELECT id,period_month,due_on FROM company_investor_obligations WHERE organization_id=$1 AND instrument_id=$2 ORDER BY period_month`, [organizationId, instrumentId]);
    const dateText = (value: string | Date | undefined): string => value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
    assert.equal(obligationRows.rows.length, 12);
    assert.equal(dateText(obligationRows.rows.at(-1)?.period_month), "2027-01-01");
    assert.equal(dateText(obligationRows.rows.at(-1)?.due_on), "2027-01-01");
    const obligationId = obligationRows.rows.find(row => dateText(row.period_month) === "2026-02-01")?.id;
    assert.ok(obligationId);
    const payment = await execute("investor.payment.record", envelope({ accountId, instrumentId, contractId, obligationId, kind: "principal", method: "manual", paymentOn: "2026-02-01", periodMonth: "2026-02-01", currency: "USD", amounts: { principalCents: "500", interestCents: "0", returnOfCapitalCents: "0", distributionCents: "0", feeCents: "0", balloonCents: "0" } }));
    const paymentId = String(payment.affectedRecordIds[0]);
    const before = await services.investors.get(access.principal, { scope, accountId });
    const original = before.payments.find(item => String(item.id) === paymentId);
    assert.ok(original);
    assert.equal(original.allocatedAmounts.principalCents, "500");
    assert.equal(before.obligations[0]?.totalRecordedCents, "500");
    assert.equal(before.obligations[0]?.status, "partially_recorded");

    const reversal = await execute("investor.payment.reverse", envelope({ paymentId, reason: "Synthetic correction", paymentOn: "2026-02-02" }));
    const reversalId = String(reversal.affectedRecordIds[0]);
    const after = await services.investors.get(access.principal, { scope, accountId });
    const correction = after.payments.find(item => String(item.id) === reversalId);
    assert.ok(correction);
    assert.equal(correction.reversesPaymentId, paymentId);
    assert.equal(correction.amounts.principalCents, "-500");
    assert.equal(correction.allocatedAmounts.principalCents, "-500");
    assert.equal(after.obligations[0]?.totalRecordedCents, "0");
    assert.equal(after.obligations[0]?.status, "expected");
    await assert.rejects(() => execute("investor.payment.reverse", envelope({ paymentId, reason: "Duplicate correction", paymentOn: "2026-02-03" })), /already has a reversal|already reversed/);

    const editable = await execute("investor.payment.record", envelope({ accountId, instrumentId, contractId, obligationId, kind: "principal", method: "manual", paymentOn: "2026-02-04", periodMonth: "2026-02-01", currency: "USD", amounts: { principalCents: "300", interestCents: "0", returnOfCapitalCents: "0", distributionCents: "0", feeCents: "0", balloonCents: "0" } }));
    const editableId = String(editable.affectedRecordIds[0]);
    const edited = await execute("investor.payment.edit_manual", envelope({ paymentId: editableId, obligationId, contractId, kind: "principal", method: "manual", paymentOn: "2026-02-05", periodMonth: "2026-02-01", amounts: { principalCents: "700", interestCents: "0", returnOfCapitalCents: "0", distributionCents: "0", feeCents: "0", balloonCents: "0" }, reason: "Synthetic manual edit" }));
    const editedId = String(edited.affectedRecordIds[0]);
    const editedDetail = await services.investors.get(access.principal, { scope, accountId });
    const editedOriginal = editedDetail.payments.find(item => String(item.id) === editableId);
    const editedReplacement = editedDetail.payments.find(item => String(item.id) === editedId);
    assert.ok(editedOriginal);
    assert.ok(editedReplacement);
    assert.equal(editedOriginal.amounts.principalCents, "300");
    assert.equal(editedOriginal.status, "manual_recorded");
    assert.equal(editedReplacement.amounts.principalCents, "700");
    assert.equal(editedReplacement.allocatedAmounts.principalCents, "700");
    assert.equal(editedDetail.obligations[0]?.totalRecordedCents, "700");
  } finally {
    await database.close();
  }
});
