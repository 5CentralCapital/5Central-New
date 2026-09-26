import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { companyScopeSchema } from "../../shared/company";
import { attestTransport, loadAuthenticatedPrincipal } from "../company/authorization";
import { createCompanyServices } from "../company/services";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";

const TERMS = {
  schedule: "monthly",
  paymentDay: 1,
  monthEndRule: "calendar_day_or_month_end",
  annualRate: null,
  preferredReturnRate: null,
  returnMultiple: null,
  fixedPaymentCents: "1000",
  principalPaymentCents: null,
  interestPaymentCents: null,
  returnOfCapitalCents: null,
  distributionCents: null,
  balloonCents: null,
  originalPrincipalCents: "100000",
  maturityTotalCents: null,
  fixedProfitCents: null,
  maturityPayoffCents: null,
  thirdPartyInstallmentCents: null,
  investorSpreadCents: null,
  unknownComponentKinds: [],
  interestOnly: false,
  dayCount: "actual_365",
};

test("investor source evidence accepts verified other documents while contracts keep strict kinds", async () => {
  const fixture = await createSyntheticCompanyDatabase();
  const database = { ...fixture, executor: await createSyntheticRuntimeExecutor(fixture.db) };
  try {
    const services = createCompanyServices(database.executor, { accounting: { environment: {} }, time: { env: {} } });
    const { organizationId, entityId, actorId, propertyId } = SYNTHETIC_COMPANY;
    const scope = companyScopeSchema.parse({ organizationId, legalEntityId: entityId });
    const organizationScope = companyScopeSchema.parse({ organizationId });
    const resolvePrincipal = (executor = database.executor) => loadAuthenticatedPrincipal(executor, { actorId, organizationId, role: "admin" });
    const access = { principal: await resolvePrincipal(), resolvePrincipal, transport: attestTransport("web") };
    const envelope = (payload: Record<string, unknown>, commandScope = scope) => {
      const operationId = randomUUID();
      return { operationId, idempotencyKey: `investor-document-reference:${operationId}`, scope: commandScope, payload };
    };
    const execute = (kind: Parameters<typeof services.investors.execute>[0], command: ReturnType<typeof envelope>) => services.investors.execute(kind, command, access);

    const account = await execute("investor.account.create", envelope({ displayName: "Document evidence investor", newContact: { kind: "person", displayName: "Document evidence contact" } }, organizationScope));
    const accountId = String(account.affectedRecordIds[0]);
    const instrument = await execute("investor.instrument.create", envelope({ accountId, name: "Document evidence note", kind: "private_loan", legalEntityId: entityId, propertyIds: [propertyId], projectIds: [], currency: "USD", committedCents: "100000", facePrincipalCents: "100000", effectiveFrom: "2026-01-01", maturityOn: "2027-01-01", ownershipBps: null, notes: null }));
    const instrumentId = String(instrument.affectedRecordIds[0]);

    const documentId = `company-document:${randomUUID()}`;
    const checksum = "c".repeat(64);
    await database.db.query(
      `INSERT INTO company_documents
        (id,organization_id,legal_entity_id,property_id,kind,state,title,tags,file_name,declared_content_type,size_bytes,checksum_sha256,backend,logical_key,immutable_version,verified_at)
       VALUES ($1,$2,$3,$4,'other','verified','Wire instructions','{}','wire-instructions.pdf','application/pdf',128,$5,$6,$7,'v1',now())`,
      [documentId, organizationId, entityId, propertyId, checksum, `synthetic-${documentId}`, `sha256:${checksum}`],
    );

    const documents = await services.investors.listDocuments(access.principal, { scope });
    assert.ok(documents.items.some(item => item.id === documentId && item.type === "other"), "source-evidence picker must include verified other company documents");

    await assert.rejects(
      () => execute("investor.contract.create", envelope({ instrumentId, title: "Wrong source kind", kind: "promissory_note", status: "draft", effectiveFrom: "2026-01-01", signedOn: null, terms: TERMS, sourceDocumentIds: [documentId] })),
      /contract, loan, or investor agreement company document/,
      "contract references must keep the strict agreement-document kind gate",
    );

    const legacyDraftDocumentId = `legacy-draft-${randomUUID()}`;
    await database.db.query(
      "INSERT INTO rent_ops_documents(id,type,state,file_name,mime_type,storage_key,availability) VALUES ($1,'other','requested','draft-instructions.pdf','application/pdf',$2,'unavailable')",
      [legacyDraftDocumentId, `synthetic/${legacyDraftDocumentId}`],
    );
    await assert.rejects(
      () => execute("investor.party_mapping.create", envelope({
        accountId,
        partyKind: "third_party_lender",
        displayName: "Draft legacy payee",
        providerParty: { provider: "qbo", organizationId, legalEntityId: entityId, environment: "sandbox", realmId: "123", objectType: "Vendor", objectId: "draft-payee-1" },
        sourceDocumentId: legacyDraftDocumentId,
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
      })),
      /signed or verified source documents/,
      "third-party legacy source evidence must retain the active-state gate",
    );

    // An already verified company document can be attached to a contract in
    // place; the command repairs the FK bridge without another upload.
    const loanDocumentId = `company-document:${randomUUID()}`;
    const loanChecksum = "d".repeat(64);
    await database.db.query(
      `INSERT INTO company_documents
        (id,organization_id,legal_entity_id,kind,state,title,tags,file_name,declared_content_type,size_bytes,checksum_sha256,backend,logical_key,immutable_version,verified_at)
       VALUES ($1,$2,$3,'loan','verified','Existing loan note','{}','existing-loan.pdf','application/pdf',96,$4,$5,$6,'v1',now())`,
      [loanDocumentId, organizationId, entityId, loanChecksum, `synthetic-${loanDocumentId}`, `sha256:${loanChecksum}`],
    );
    const attachedContract = await execute("investor.contract.create", envelope({ instrumentId, title: "Existing loan note", kind: "promissory_note", status: "draft", effectiveFrom: "2026-01-01", signedOn: null, terms: TERMS, sourceDocumentIds: [loanDocumentId] }));
    assert.equal(attachedContract.affectedRecordIds.length, 2, "an existing verified company document should attach without an upload");
    const loanBridge = await database.db.query<{ count: string }>("SELECT count(*)::text AS count FROM rent_ops_documents WHERE id=$1", [loanDocumentId]);
    assert.equal(loanBridge.rows[0]?.count, "1");

    const archivedDocumentId = `company-document:${randomUUID()}`;
    const archivedChecksum = "e".repeat(64);
    await database.db.query(
      `INSERT INTO company_documents
        (id,organization_id,legal_entity_id,kind,state,archived_at,title,tags,file_name,declared_content_type,size_bytes,checksum_sha256,backend,logical_key,immutable_version,verified_at)
       VALUES ($1,$2,$3,'other','archived',now(),'Archived wire instructions','{}','archived-wire.pdf','application/pdf',64,$4,$5,$6,'v1',now())`,
      [archivedDocumentId, organizationId, entityId, archivedChecksum, `synthetic-${archivedDocumentId}`, `sha256:${archivedChecksum}`],
    );
    await assert.rejects(
      () => execute("investor.party_mapping.create", envelope({
        accountId,
        partyKind: "third_party_lender",
        displayName: "Archived wire payee",
        providerParty: { provider: "qbo", organizationId, legalEntityId: entityId, environment: "sandbox", realmId: "123", objectType: "Vendor", objectId: "archived-payee-1" },
        sourceDocumentId: archivedDocumentId,
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
      })),
      /current verified company document/,
      "archived company evidence must not fall through to legacy references",
    );

    const otherEntityId = "20000000-0000-4000-8000-000000000002";
    await database.db.query("INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency) VALUES ($1,$2,'Other Evidence LLC','llc','USD')", [otherEntityId, organizationId]);
    const crossEntityDocumentId = `company-document:${randomUUID()}`;
    const crossEntityChecksum = "f".repeat(64);
    await database.db.query(
      `INSERT INTO company_documents
        (id,organization_id,legal_entity_id,kind,state,title,tags,file_name,declared_content_type,size_bytes,checksum_sha256,backend,logical_key,immutable_version,verified_at)
       VALUES ($1,$2,$3,'other','verified','Other entity wire instructions','{}','other-entity-wire.pdf','application/pdf',64,$4,$5,$6,'v1',now())`,
      [crossEntityDocumentId, organizationId, otherEntityId, crossEntityChecksum, `synthetic-${crossEntityDocumentId}`, `sha256:${crossEntityChecksum}`],
    );
    await assert.rejects(
      () => execute("investor.party_mapping.create", envelope({
        accountId,
        partyKind: "third_party_lender",
        displayName: "Cross entity wire payee",
        providerParty: { provider: "qbo", organizationId, legalEntityId: entityId, environment: "sandbox", realmId: "123", objectType: "Vendor", objectId: "cross-entity-payee-1" },
        sourceDocumentId: crossEntityDocumentId,
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
      })),
      /outside the requested company or legal entity scope/,
      "cross-entity company evidence must be rejected before FK bridging",
    );

    const mapping = await execute("investor.party_mapping.create", envelope({
      accountId,
      partyKind: "third_party_lender",
      displayName: "Wire instruction payee",
      providerParty: { provider: "qbo", organizationId, legalEntityId: entityId, environment: "sandbox", realmId: "123", objectType: "Vendor", objectId: "wire-payee-1" },
      sourceDocumentId: documentId,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
    }));
    const partyMappingId = String(mapping.affectedRecordIds[0]);
    const bridge = await database.db.query<{ count: string }>("SELECT count(*)::text AS count FROM rent_ops_documents WHERE id=$1", [documentId]);
    assert.equal(bridge.rows[0]?.count, "1", "source evidence should repair the FK bridge before inserting the party mapping");

    const remittance = await execute("investor.remittance.create", envelope({
      accountId,
      instrumentId,
      contractId: null,
      partyMappingId,
      sourceDocumentId: documentId,
      effectiveFrom: "2026-01-01",
      effectiveTo: null,
      notes: "Synthetic wire instruction",
    }));
    assert.equal(remittance.affectedRecordIds.length, 1);
  } finally {
    await database.close();
  }
});
