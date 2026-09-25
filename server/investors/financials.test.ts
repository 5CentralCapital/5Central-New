import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { centsToBigInt, companyScopeSchema } from "../../shared/company";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { createCompanyServices } from "../company/services";
import { resolveEffectiveDate } from "./helpers";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";

const zeroAmounts = { principalCents: "0", interestCents: "0", returnOfCapitalCents: "0", distributionCents: "0", feeCents: "0", balloonCents: "0" };

test("instrument financials, payment calendar and maturity ladder derive from recorded activity", async () => {
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
      return { operationId, idempotencyKey: `investor-financials:${operationId}`, scope: commandScope, payload };
    };
    const execute = (kind: Parameters<typeof services.investors.execute>[0], command: ReturnType<typeof envelope>) => services.investors.execute(kind, command, access);

    const account = await execute("investor.account.create", envelope({ displayName: "Synthetic lender", newContact: { kind: "person", displayName: "Synthetic lender contact" } }, companyScopeSchema.parse({ organizationId })));
    const accountId = String(account.affectedRecordIds[0]);
    const instrument = await execute("investor.instrument.create", envelope({ accountId, name: "Synthetic bridge note", kind: "private_loan", legalEntityId: entityId, propertyIds: [propertyId], projectIds: [], currency: "USD", committedCents: "100000", facePrincipalCents: "100000", effectiveFrom: "2026-01-01", maturityOn: "2027-01-01", ownershipBps: null, notes: null }));
    const instrumentId = String(instrument.affectedRecordIds[0]);
    await execute("investor.debt.create", envelope({
      instrumentId, legalEntityId: entityId, debtKind: "private_loan", currency: "USD", originalPrincipalCents: "100000", fundedCapitalCents: "100000", outstandingPrincipalCents: "90000",
      annualRate: "0.12", schedule: "monthly", paymentDay: 1, monthEndRule: "calendar_day_or_month_end", firstDueMonth: "2026-02-01", interestOnlyUntil: "2026-07-01",
      maturityOn: "2027-01-01", amortizationMonths: 12, balloonCents: null, dayCount: "30_360",
    }));
    const documentId = `synthetic-lender-note-${randomUUID()}`;
    await database.db.query("INSERT INTO rent_ops_documents(id,type,state,file_name,mime_type,storage_key) VALUES ($1,'other','signed','synthetic-note.pdf','application/pdf',$2)", [documentId, `synthetic/${documentId}`]);
    const contract = await execute("investor.contract.create", envelope({ instrumentId, title: "Synthetic note terms", kind: "promissory_note", status: "draft", effectiveFrom: "2026-01-01", signedOn: null, terms: { schedule: "monthly", paymentDay: 1, monthEndRule: "calendar_day_or_month_end", annualRate: null, preferredReturnRate: null, returnMultiple: null, fixedPaymentCents: "1000", principalPaymentCents: null, interestPaymentCents: null, returnOfCapitalCents: null, distributionCents: null, balloonCents: null, originalPrincipalCents: "100000", maturityTotalCents: null, fixedProfitCents: "20000", maturityPayoffCents: null, thirdPartyInstallmentCents: null, investorSpreadCents: null, unknownComponentKinds: [], interestOnly: false, dayCount: "actual_365" }, sourceDocumentIds: [documentId] }));
    const contractId = String(contract.affectedRecordIds[0]);
    const versionId = String(contract.affectedRecordIds[1]);
    await database.db.query("UPDATE company_investor_contract_versions SET status='active', approved_by='synthetic-test' WHERE organization_id=$1 AND id=$2", [organizationId, versionId]);
    await database.db.query("UPDATE company_investor_contracts SET status='active', current_version_id=$3 WHERE organization_id=$1 AND id=$2", [organizationId, contractId, versionId]);
    await execute("investor.obligation.generate", envelope({ instrumentId, contractId, fromMonth: "2026-02-01", throughMonth: "2026-06-01" }));
    const obligations = await database.db.query<{ id: string; period_month: string | Date }>(`SELECT id, period_month FROM company_investor_obligations WHERE organization_id=$1 AND instrument_id=$2 ORDER BY period_month`, [organizationId, instrumentId]);
    const february = obligations.rows[0]!.id;

    await execute("investor.payment.record", envelope({ accountId, instrumentId, kind: "contribution", method: "manual", paymentOn: "2026-01-01", currency: "USD", amounts: { ...zeroAmounts, principalCents: "100000" } }));
    await execute("investor.payment.record", envelope({ accountId, instrumentId, kind: "principal", method: "manual", paymentOn: "2026-02-10", currency: "USD", amounts: { ...zeroAmounts, principalCents: "5000", interestCents: "1000" } }));
    await execute("investor.payment.record", envelope({ accountId, instrumentId, contractId, obligationId: february, kind: "principal", method: "manual", paymentOn: "2026-02-01", periodMonth: "2026-02-01", currency: "USD", amounts: { ...zeroAmounts, principalCents: "400" } }));
    await execute("investor.payment.record", envelope({ accountId, instrumentId, kind: "interest", method: "manual", paymentOn: "2026-03-02", currency: "USD", amounts: { ...zeroAmounts, unclassifiedCents: "700" } }));

    const financials = await services.investors.instrumentFinancials(access.principal, { scope, instrumentId, asOf: "2026-03-15" });
    assert.equal(financials.fromMonth, "2026-01-01");
    assert.equal(financials.throughMonth, "2026-03-01");
    assert.equal(financials.rollforward.basis, "payments");
    assert.equal(financials.rollforward.derivedOutstandingCents, "94600", "funded less principal repaid; the unknown split never reduces principal");
    assert.equal(financials.rollforward.manualOutstandingCents, "90000");
    assert.equal(financials.rollforward.reconciliation, "mismatch");
    assert.equal(financials.rollforward.differenceCents, "-4600");
    assert.equal(financials.rollforward.unclassifiedTotalCents, "700");
    assert.equal(financials.rollforward.conserved, true);
    assert.equal(financials.rollforward.unverifiedPaymentCount, 4);
    assert.deepEqual(financials.rollforward.guaranteedReturn, { returnCents: "20000", paidCents: "1000", remainingCents: "19000" });
    const rows = financials.rollforward.rows;
    assert.equal(rows.length, 3);
    assert.equal(rows[0]!.closingCents, "100000");
    assert.equal(rows[1]!.principalRepaidCents, "5400");
    assert.equal(rows[1]!.expectedPrincipalCents, "1000", "a non-interest-only fixed payment is scheduled as principal");
    for (let index = 1; index < rows.length; index += 1) assert.equal(rows[index]!.openingCents, rows[index - 1]!.closingCents);
    const amortization = financials.amortization;
    assert.ok(amortization);
    assert.equal(amortization.status, "ready");
    assert.equal(amortization.rows[0]!.phase, "interest_only");
    assert.equal(amortization.rows[0]!.interestCents, "1000", "one 30/360 month at 12% on $1,000");
    assert.equal(amortization.rows.find(row => row.periodMonth === "2026-07-01")?.phase, "amortizing");
    assert.equal(amortization.rows.at(-1)?.phase, "maturity");
    assert.equal(amortization.rows.at(-1)?.closingCents, "0");
    assert.equal(amortization.totalPrincipalCents, "100000", "scheduled principal and balloon repay the funded principal exactly");

    const calendar = await services.investors.paymentCalendar(access.principal, { scope, fromMonth: "2026-02-01", throughMonth: "2026-04-01", asOf: "2026-03-15" });
    assert.deepEqual(calendar.items.map(item => [item.periodMonth, item.state]), [["2026-02-01", "partial"], ["2026-03-01", "overdue"], ["2026-04-01", "scheduled"]]);
    assert.equal(calendar.items[0]!.recordedCents, "400");
    assert.equal(calendar.items[0]!.remainingCents, "600");
    assert.equal(calendar.items[0]!.accountName, "Synthetic lender");
    assert.equal(calendar.items[0]!.instrumentName, "Synthetic bridge note");
    const firstPage = await services.investors.paymentCalendar(access.principal, { scope, fromMonth: "2026-02-01", throughMonth: "2026-06-01", asOf: "2026-03-15", limit: 2 });
    assert.equal(firstPage.items.length, 2);
    assert.ok(firstPage.nextCursor);
    const secondPage = await services.investors.paymentCalendar(access.principal, { scope, fromMonth: "2026-02-01", throughMonth: "2026-06-01", asOf: "2026-03-15", limit: 2, cursor: firstPage.nextCursor! });
    assert.deepEqual(secondPage.items.map(item => item.periodMonth), ["2026-04-01", "2026-05-01"]);
    const overdueOnly = await services.investors.paymentCalendar(access.principal, { scope, fromMonth: "2026-02-01", throughMonth: "2026-04-01", asOf: "2026-03-15", state: "overdue" });
    assert.deepEqual(overdueOnly.items.map(item => item.periodMonth), ["2026-03-01"]);

    const ladder = await services.investors.debtMaturities(access.principal, { scope, asOf: "2026-03-15" });
    assert.equal(ladder.items.length, 1);
    const rung = ladder.items[0]!;
    assert.equal(rung.maturityOn, "2027-01-01");
    assert.equal(rung.monthsToMaturity, 10);
    assert.equal(rung.derivedOutstandingCents, "94600");
    assert.equal(rung.reconciliation, "mismatch");
    assert.equal(rung.balloonSource, "computed");
    assert.ok(rung.balloonCents !== null && centsToBigInt(rung.balloonCents) > BigInt(0));

    await assert.rejects(
      () => services.investors.debtMaturities(access.principal, { scope: { organizationId: randomUUID() } }),
      (error: unknown) => error instanceof Error && /forbidden|not authorized|scope|organization/i.test(`${error.name} ${error.message}`),
    );
    await assert.rejects(() => services.investors.instrumentFinancials(access.principal, { scope, instrumentId: randomUUID() }), /not found/);
  } finally {
    await database.close();
  }
});

test("investor default as-of date is the New York operating date, not the UTC date", () => {
  assert.equal(resolveEffectiveDate(undefined, new Date("2027-03-08T04:00:00.000Z")), "2027-03-07");
  assert.equal(resolveEffectiveDate("2026-01-02", new Date("2026-09-24T02:00:00.000Z")), "2026-01-02");
});
