import assert from "node:assert/strict";
import test from "node:test";
import type { QuickBooksJsonObject } from "../../shared/accounting/quickbooks";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import type { QuickBooksAccountingClient, QuickBooksCdcResponse } from "../integrations/quickbooks/accounting";
import { QuickBooksIntegrationError } from "../integrations/quickbooks/errors";
import { PostgresQuickBooksCapabilityStore } from "./capabilities";
import { createQboAccountingMirrorStore } from "./mirror-store";
import { createQboProviderSync } from "./provider-sync";
import { providerBalanceCents, readCustomerLedger, resolveTenancyCustomer } from "./receivables-read";
import { linkTenancyToQboCustomer } from "./receivables-links";
import { AccountingError } from "./errors";

const scope = { organizationId: SYNTHETIC_COMPANY.organizationId, legalEntityId: SYNTHETIC_COMPANY.entityId, environment: "sandbox" as const, realmId: "123456" };
const sourceScope = { provider: "qbo" as const, ...scope };
type Store = Record<string, QuickBooksJsonObject[]>;
const T = (day: string) => `2026-09-${day}T12:00:00Z`;

function customer(id: string, balance: string | number, overrides: Record<string, unknown> = {}): QuickBooksJsonObject {
  return { Id: id, SyncToken: "0", DisplayName: `Synthetic Tenant ${id}`, Active: true, Balance: balance, MetaData: { LastUpdatedTime: T("20") }, ...overrides } as QuickBooksJsonObject;
}

function invoice(id: string, amount: number, balance: number, options: { token?: string; date?: string; due?: string; customer?: string; updated?: string; extra?: Record<string, unknown> } = {}): QuickBooksJsonObject {
  return {
    Id: id, SyncToken: options.token ?? "0", TxnDate: options.date ?? "2026-09-01", DueDate: options.due ?? "2026-09-05", DocNumber: `INV-${id}`,
    CustomerRef: { value: options.customer ?? "58" }, CurrencyRef: { value: "USD" }, TotalAmt: amount, Balance: balance,
    EmailStatus: "NotSet", AllowOnlineCreditCardPayment: false, AllowOnlineACHPayment: false, AllowIPNPayment: false,
    MetaData: { LastUpdatedTime: options.updated ?? T("10") },
    Line: [{ Id: "1", Amount: amount, DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "10" } } }],
    ...(options.extra ?? {}),
  } as QuickBooksJsonObject;
}

function payment(id: string, total: number, applications: readonly [string, string, number][], unapplied = 0, date = "2026-09-03"): QuickBooksJsonObject {
  return {
    Id: id, SyncToken: "0", TxnDate: date, CustomerRef: { value: "58" }, CurrencyRef: { value: "USD" }, TotalAmt: total, UnappliedAmt: unapplied,
    MetaData: { LastUpdatedTime: T("10") },
    Line: applications.map(([type, target, amount]) => ({ Amount: amount, LinkedTxn: [{ TxnId: target, TxnType: type }] })),
  } as QuickBooksJsonObject;
}

function baseStore(): Store {
  return {
    Account: [
      { Id: "84", SyncToken: "0", Name: "Accounts Receivable (A/R)", AccountType: "Accounts Receivable", Active: true, MetaData: { LastUpdatedTime: T("01") } },
      { Id: "79", SyncToken: "0", Name: "Rental Income", AccountType: "Income", Active: true, MetaData: { LastUpdatedTime: T("01") } },
    ] as QuickBooksJsonObject[],
    // 1200 + 1200 − 1150 paid − 50 credit + 25 late-fee journal = 1225
    Customer: [customer("58", "1225.00"), customer("59", 0)],
    Invoice: [invoice("130", 1200, 0), invoice("131", 1200, 1200, { date: "2026-08-01", due: "2026-08-05" })],
    Payment: [payment("200", 1150, [["Invoice", "130", 1150]])],
    CreditMemo: [{
      Id: "77", SyncToken: "0", TxnDate: "2026-09-02", CustomerRef: { value: "58" }, CurrencyRef: { value: "USD" }, TotalAmt: 50, Balance: 0,
      MetaData: { LastUpdatedTime: T("10") }, Line: [{ Id: "1", Amount: 50, DetailType: "SalesItemLineDetail", SalesItemLineDetail: {} }],
    }] as QuickBooksJsonObject[],
    JournalEntry: [
      {
        Id: "90", SyncToken: "0", TxnDate: "2026-09-04", CurrencyRef: { value: "USD" }, MetaData: { LastUpdatedTime: T("10") },
        Line: [
          { Id: "0", Amount: 25, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "84" }, Entity: { Type: "Customer", EntityRef: { value: "58" } } } },
          { Id: "1", Amount: 25, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "79" } } },
        ],
      },
      {
        // An ordinary journal with no receivable line is not stored.
        Id: "91", SyncToken: "0", TxnDate: "2026-09-04", CurrencyRef: { value: "USD" }, MetaData: { LastUpdatedTime: T("10") },
        Line: [
          { Id: "0", Amount: 10, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "79" } } },
          { Id: "1", Amount: 10, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "79" } } },
        ],
      },
    ] as QuickBooksJsonObject[],
    SalesReceipt: [],
    RefundReceipt: [],
  };
}

function fakeClient(store: Store, queries: string[], cdc: { next: () => QuickBooksCdcResponse }): QuickBooksAccountingClient {
  return {
    read: async (entity: string, id: string) => {
      if (entity === "CompanyInfo") return { entity: { Id: "1", CompanyName: "Synthetic", MetaData: { LastUpdatedTime: "2026-09-01T00:00:00Z" } }, raw: {}, status: 200 };
      const found = (store[entity] ?? []).find(item => item.Id === id);
      if (!found) throw new QuickBooksIntegrationError("quickbooks_api", "not found", { status: 400, details: { providerCode: "610" } });
      return { entity: found, raw: {}, status: 200 };
    },
    query: async (query: string) => {
      queries.push(query);
      if (/FROM Preferences/.test(query)) return { entities: [{ CurrencyPrefs: { HomeCurrency: { value: "USD" }, MultiCurrencyEnabled: false } }], raw: {}, status: 200 };
      const entity = /FROM (\w+)/.exec(query)?.[1] ?? "";
      const start = Number(/STARTPOSITION (\d+)/.exec(query)?.[1] ?? "1");
      return { entities: (store[entity] ?? []).slice(start - 1, start - 1 + 500), raw: {}, status: 200 };
    },
    cdc: async () => cdc.next(),
    create: async () => { throw new Error("unused"); },
    update: async () => { throw new Error("unused"); },
  } as unknown as QuickBooksAccountingClient;
}

async function harness(store: Store) {
  const synthetic = await createSyntheticCompanyDatabase();
  const executor = await createSyntheticRuntimeExecutor(synthetic.db);
  let current = new Date("2026-09-21T00:00:00Z");
  const now = () => current;
  const queries: string[] = [];
  const cdc = { queue: [] as QuickBooksCdcResponse[], next: () => cdc.queue.shift() ?? { entities: {}, objectCount: 0, truncated: false, time: now().toISOString(), status: 200 } };
  const mirror = createQboAccountingMirrorStore(executor, now);
  const sync = createQboProviderSync({ executor, client: fakeClient(store, queries, cdc), scope, mirror, capabilityStore: new PostgresQuickBooksCapabilityStore(executor), now });
  await sync.bootstrapRead();
  const ledger = (customerObjectId = "58", extra: { asOf?: string; limit?: number; cursor?: string } = {}) => readCustomerLedger(executor, { scope: sourceScope, customerObjectId, today: "2026-09-21", ...extra });
  return { synthetic, executor, sync, queries, cdc, ledger, advance: (ms: number) => { current = new Date(current.getTime() + ms); }, close: () => synthetic.close() };
}

test("a full replay mirrors customers and receivables and the ledger ties to QuickBooks' customer balance", async () => {
  const h = await harness(baseStore());
  try {
    const result = await h.sync.syncChanges();
    assert.equal(result.mode, "full_replay");
    assert.equal(result.anchored, true);
    assert.equal(result.status, "complete");
    assert.ok(h.queries.some(query => /FROM Customer WHERE Active IN \(true, false\)/.test(query)));
    const ledger = await h.ledger();
    assert.equal(ledger.customer.displayName, "Synthetic Tenant 58");
    assert.deepEqual(ledger.entries.map(entry => [entry.objectType, entry.objectId, entry.amountCents, entry.runningBalanceCents]), [
      ["Invoice", "131", "120000", "120000"],
      ["Invoice", "130", "120000", "240000"],
      ["CreditMemo", "77", "-5000", "235000"],
      ["Payment", "200", "-115000", "120000"],
      ["JournalEntry", "90", "2500", "122500"],
    ]);
    assert.deepEqual(ledger.totals, { chargesCents: "240000", creditsCents: "-5000", paymentsCents: "-115000", adjustmentsCents: "2500", endingBalanceCents: "122500" });
    assert.deepEqual(ledger.verification, { state: "verified", providerBalanceCents: "122500", computedBalanceCents: "122500", reason: null });
    assert.equal(ledger.coverage.status, "complete", ledger.coverage.reasons.join("; "));
    // Open items and aging come from QuickBooks' own open balances.
    assert.deepEqual(ledger.openItems.map(item => [item.objectId, item.openBalanceCents, item.daysPastDue]), [["131", "120000", 47]]);
    assert.equal(ledger.aging?.days31To60Cents, "120000");
    // The journal without a receivable line was not stored.
    const stored = await h.synthetic.db.query<{ object_id: string }>("SELECT object_id FROM accounting_qbo_receivable_documents WHERE object_type='JournalEntry'");
    assert.deepEqual(stored.rows.map(row => row.object_id), ["90"]);
    // Another customer's ledger is separate and empty, not borrowed.
    const other = await h.ledger("59");
    assert.deepEqual([other.entries.length, other.totals.endingBalanceCents, other.verification.state], [0, "0", "verified"]);
  } finally {
    await h.close();
  }
});

test("voided receivable revisions remain stored for audit but never affect the ledger", async () => {
  const store = baseStore();
  store.JournalEntry.push({
    Id: "92", SyncToken: "0", TxnStatus: "Voided", TxnDate: "2026-09-05", CurrencyRef: { value: "USD" }, MetaData: { LastUpdatedTime: T("11") },
    Line: [
      { Id: "0", Amount: 5, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "84" }, Entity: { Type: "Customer", EntityRef: { value: "58" } } } },
      { Id: "1", Amount: 5, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "79" } } },
    ],
  } as QuickBooksJsonObject);
  const h = await harness(store);
  try {
    await h.sync.syncChanges();
    const ledger = await h.ledger();
    assert.equal(ledger.entries.some(entry => entry.objectId === "92"), false);
    assert.equal(ledger.totals.endingBalanceCents, "122500");
    assert.equal(ledger.verification.state, "verified");
    const stored = await h.synthetic.db.query<{ mirror_state: string; posting_state: string }>("SELECT mirror_state, posting_state FROM accounting_qbo_receivable_documents WHERE object_type='JournalEntry' AND object_id='92'");
    assert.deepEqual(stored.rows.map(row => [row.mirror_state, row.posting_state]), [["current", "voided"]]);

    // A legacy/imported row in another currency is excluded at read time and
    // leaves visible partial coverage rather than being relabeled as USD.
    await h.synthetic.db.query("UPDATE accounting_qbo_receivable_documents SET currency='CAD' WHERE object_type='JournalEntry' AND object_id='90'");
    const foreign = await h.ledger();
    assert.equal(foreign.entries.some(entry => entry.objectId === "90"), false);
    assert.equal(foreign.coverage.status, "partial");
    assert.ok(foreign.coverage.reasons.some(reason => /different from the legal entity/.test(reason)));
  } finally {
    await h.close();
  }
});

test("pages keep the complete-history running balance and refuse a ledger that changed between pages", async () => {
  const store = baseStore();
  const h = await harness(store);
  try {
    await h.sync.syncChanges();
    const first = await h.ledger("58", { limit: 2 });
    assert.equal(first.page.total, 5);
    assert.deepEqual(first.entries.map(entry => entry.runningBalanceCents), ["120000", "240000"]);
    const second = await h.ledger("58", { limit: 2, cursor: first.page.nextCursor! });
    assert.deepEqual(second.entries.map(entry => entry.runningBalanceCents), ["235000", "120000"]);
    const third = await h.ledger("58", { limit: 2, cursor: second.page.nextCursor! });
    assert.deepEqual([third.entries.length, third.page.nextCursor], [1, null]);
    // A new invoice arrives between pages.
    store.Invoice.push(invoice("132", 100, 100, { date: "2026-09-15", updated: T("21") }));
    await h.sync.applyObject({ objectType: "Invoice", objectId: "132", operation: "created" });
    await assert.rejects(h.ledger("58", { limit: 2, cursor: second.page.nextCursor! }), (error: unknown) => error instanceof AccountingError && error.code === "accounting_conflict");
  } finally {
    await h.close();
  }
});

test("edits replace effects by revision, older deliveries are ignored, deletes and unsupported revisions stop counting", async () => {
  const store = baseStore();
  const h = await harness(store);
  try {
    await h.sync.syncChanges();
    // Invoice 131 edited in QuickBooks: amount corrected to 1100.
    const edited = invoice("131", 1100, 1100, { token: "1", date: "2026-08-01", due: "2026-08-05", updated: T("21") });
    store.Invoice[1] = edited;
    store.Customer[0] = customer("58", "1125.00", { SyncToken: "1", MetaData: { LastUpdatedTime: T("21") } });
    await h.sync.applyObject({ objectType: "Invoice", objectId: "131", operation: "updated" });
    await h.sync.applyObject({ objectType: "Customer", objectId: "58", operation: "updated" });
    let ledger = await h.ledger();
    assert.equal(ledger.totals.endingBalanceCents, "112500");
    assert.equal(ledger.verification.state, "verified");
    // The earlier revision is kept for traceability, not counted.
    const revisions = await h.synthetic.db.query<{ object_version: string; amount_cents: string }>("SELECT object_version, amount_cents::text FROM accounting_qbo_receivable_effects WHERE object_type='Invoice' AND object_id='131' ORDER BY object_version");
    assert.deepEqual(revisions.rows.map(row => [row.object_version, row.amount_cents]), [["0", "120000"], ["1", "110000"]]);
    // A late webhook for the old revision changes nothing.
    store.Invoice[1] = invoice("131", 1200, 1200, { token: "0", date: "2026-08-01", due: "2026-08-05" });
    const stale = await h.sync.applyObject({ objectType: "Invoice", objectId: "131", operation: "updated" });
    assert.equal(stale.status, "stale");
    store.Invoice[1] = edited;
    // A revision the mirror cannot read (sales tax) retires the document and says so.
    store.Invoice[0] = invoice("130", 1200, 0, { token: "5", updated: T("21"), extra: { TxnTaxDetail: { TotalTax: 3 } } });
    const unsupported = await h.sync.applyObject({ objectType: "Invoice", objectId: "130", operation: "updated" });
    assert.equal(unsupported.status, "unsupported");
    ledger = await h.ledger();
    assert.equal(ledger.entries.some(entry => entry.objectId === "130"), false);
    assert.equal(ledger.coverage.status, "partial");
    assert.ok(ledger.coverage.reasons.some(reason => /cannot read/.test(reason)));
    assert.equal(ledger.verification.state, "mismatch", "the excluded invoice leaves a visible gap");
    // A deletion in QuickBooks removes the credit memo from the history.
    const deleted = await h.sync.applyObject({ objectType: "CreditMemo", objectId: "77", operation: "deleted", occurredAt: T("21") });
    assert.equal(deleted.status, "deleted");
    ledger = await h.ledger();
    assert.equal(ledger.entries.some(entry => entry.objectId === "77"), false);
  } finally {
    await h.close();
  }
});

test("a same-token receivable recovers after its prerequisite account becomes available", async () => {
  const store = baseStore();
  const h = await harness(store);
  try {
    await h.sync.syncChanges();
    const firstRevision = {
      Id: "92", SyncToken: "0", TxnDate: "2026-09-05", CurrencyRef: { value: "USD" }, MetaData: { LastUpdatedTime: T("11") },
      Line: [
        { Id: "0", Amount: 5, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "84" }, Entity: { Type: "Customer", EntityRef: { value: "58" } } } },
        { Id: "1", Amount: 5, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "79" } } },
      ],
    } as QuickBooksJsonObject;
    store.JournalEntry.push(firstRevision);
    store.Customer[0] = customer("58", "1230.00", { SyncToken: "1", MetaData: { LastUpdatedTime: T("21") } });
    await h.sync.applyObject({ objectType: "JournalEntry", objectId: "92", operation: "created" });
    await h.sync.applyObject({ objectType: "Customer", objectId: "58", operation: "updated" });
    assert.equal((await h.ledger()).totals.endingBalanceCents, "123000");

    // The same provider revision is first unreadable because Account 85 has
    // not been mirrored. It retires the prior effects and records an exception.
    store.JournalEntry[2] = {
      ...firstRevision,
      SyncToken: "1",
      MetaData: { LastUpdatedTime: T("13") },
      Line: [
        { Id: "0", Amount: 5, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "85" }, Entity: { Type: "Customer", EntityRef: { value: "58" } } } },
        { Id: "1", Amount: 5, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "79" } } },
      ],
    } as QuickBooksJsonObject;
    const unsupported = await h.sync.applyObject({ objectType: "JournalEntry", objectId: "92", operation: "updated" });
    assert.equal(unsupported.status, "unsupported");
    assert.equal((await h.ledger()).entries.some(entry => entry.objectId === "92"), false);

    // Once the missing account is mirrored, the exact same SyncToken can be
    // normalized. Its append-only effects are inserted once and the current
    // document is promoted from unsupported to current.
    store.Account.push({ Id: "85", SyncToken: "0", Name: "Accounts Receivable (A/R) - Reclassified", AccountType: "Accounts Receivable", Active: true, MetaData: { LastUpdatedTime: T("13") } } as QuickBooksJsonObject);
    await h.sync.applyObject({ objectType: "Account", objectId: "85", operation: "created" });
    const recovered = await h.sync.applyObject({ objectType: "JournalEntry", objectId: "92", operation: "updated" });
    assert.equal(recovered.status, "applied");
    const ledger = await h.ledger();
    assert.deepEqual(ledger.entries.filter(entry => entry.objectId === "92").map(entry => [entry.amountCents, entry.postingState]), [["500", "posted"]]);
    assert.equal(ledger.totals.endingBalanceCents, "123000");
    assert.equal(ledger.verification.state, "verified");
    assert.equal(ledger.coverage.status, "complete", ledger.coverage.reasons.join("; "));
    const effects = await h.synthetic.db.query<{ object_version: string; effect_id: string }>("SELECT object_version, effect_id FROM accounting_qbo_receivable_effects WHERE object_type='JournalEntry' AND object_id='92' ORDER BY object_version, effect_id");
    assert.deepEqual(effects.rows.map(row => [row.object_version, row.effect_id]), [["0", "0"], ["1", "0"]]);
  } finally {
    await h.close();
  }
});

test("CDC applies receivable changes after accounts and customers, and a journal that loses its A/R line is retired", async () => {
  const store = baseStore();
  const h = await harness(store);
  try {
    await h.sync.syncChanges();
    h.advance(60_000);
    const journal = { ...store.JournalEntry[0]!, SyncToken: "1", MetaData: { LastUpdatedTime: T("21") }, Line: [
      { Id: "0", Amount: 25, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Debit", AccountRef: { value: "79" } } },
      { Id: "1", Amount: 25, DetailType: "JournalEntryLineDetail", JournalEntryLineDetail: { PostingType: "Credit", AccountRef: { value: "79" } } },
    ] } as QuickBooksJsonObject;
    const newPayment = payment("201", 100, [["Invoice", "131", 100]], 0, "2026-09-20");
    h.cdc.queue.push({ entities: { JournalEntry: [journal], Payment: [newPayment], Customer: [customer("58", "1100.00", { SyncToken: "2", MetaData: { LastUpdatedTime: T("21") } })] }, objectCount: 3, truncated: false, time: "2026-09-21T00:01:00Z", status: 200 });
    const result = await h.sync.syncChanges();
    assert.equal(result.mode, "cdc");
    assert.equal(result.status, "complete");
    const ledger = await h.ledger();
    assert.equal(ledger.entries.some(entry => entry.objectId === "90"), false);
    assert.equal(ledger.totals.endingBalanceCents, "110000");
    assert.equal(ledger.verification.state, "verified");
  } finally {
    await h.close();
  }
});

test("an as-of view excludes later activity and never claims verification against today's balance", async () => {
  const h = await harness(baseStore());
  try {
    await h.sync.syncChanges();
    const ledger = await h.ledger("58", { asOf: "2026-09-02" });
    assert.deepEqual(ledger.entries.map(entry => entry.objectId), ["131", "130", "77"]);
    assert.equal(ledger.totals.endingBalanceCents, "235000");
    assert.equal(ledger.verification.state, "unverified");
    assert.equal(ledger.aging, null);
  } finally {
    await h.close();
  }
});

test("an unread mirror is reported as unavailable, never as a zero balance", async () => {
  const h = await harness(baseStore());
  try {
    const ledger = await h.ledger();
    assert.equal(ledger.coverage.status, "unavailable");
    assert.equal(ledger.verification.state, "unavailable");
    assert.equal(ledger.entries.length, 0);
  } finally {
    await h.close();
  }
});

test("tenancies link to one QuickBooks customer through the immutable identity map", async () => {
  const h = await harness(baseStore());
  try {
    await h.sync.syncChanges();
    const input = { scope: sourceScope, tenancyId: "t-1", customerObjectId: "58" };
    await assert.rejects(h.executor.transaction!(tx => linkTenancyToQboCustomer(tx, input)), (error: unknown) => error instanceof AccountingError && /not bound/.test(error.message));
    await h.synthetic.db.query(
      "INSERT INTO company_external_identities (id, organization_id, legal_entity_id, provider, source_scope, record_kind, external_id, local_kind, local_id) VALUES ('50000000-0000-4000-8000-000000000001',$1,$2::uuid,'qbo','qbo:sandbox:123456','CompanyInfo','1','legal_entity',$3::text)",
      [scope.organizationId, scope.legalEntityId, scope.legalEntityId],
    );
    await assert.rejects(h.executor.transaction!(tx => linkTenancyToQboCustomer(tx, input)), (error: unknown) => error instanceof AccountingError && error.code === "accounting_not_found");
    await h.synthetic.db.exec(`
      INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency) VALUES('20000000-0000-4000-8000-000000000002','${scope.organizationId}','Other Property LLC','llc','USD');
      INSERT INTO rent_ops_properties(id,name,slug) VALUES('demo-property-b','Demo property B','demo-property-b');
      INSERT INTO rent_ops_units(id,property_id,unit_number) VALUES('demo-unit-b-1','demo-property-b','1B');
      INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from) VALUES('30000000-0000-4000-8000-000000000002','${scope.organizationId}','20000000-0000-4000-8000-000000000002','demo-property-b','2020-01-01');
      INSERT INTO company_organizations(id,name) VALUES('10000000-0000-4000-8000-000000000002','Other Company');
      INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency) VALUES('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','Other Company LLC','llc','USD');
      INSERT INTO rent_ops_properties(id,name,slug) VALUES('foreign-property','Foreign property','foreign-property');
      INSERT INTO rent_ops_units(id,property_id,unit_number) VALUES('foreign-unit-1','foreign-property','1F');
      INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from) VALUES('30000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000003','foreign-property','2020-01-01');
      INSERT INTO rent_ops_people(id,first_name,last_name) VALUES('person-1','QA','Resident'),('person-2','QA','Next'),('person-3','QA','Historical'),('person-4','QA','Other entity'),('person-5','QA','Other company');
      INSERT INTO rent_ops_tenancies(id,property_id,unit_id,primary_person_id,status,created_at,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge,status_knowledge)
      VALUES('t-1','${SYNTHETIC_COMPANY.propertyId}','${SYNTHETIC_COMPANY.unitId}','person-1','past',NOW(),'manual','manual','manual','manual'),
              ('t-2','${SYNTHETIC_COMPANY.propertyId}','${SYNTHETIC_COMPANY.unitId}','person-2','current',NOW(),'manual','manual','manual','manual'),
              ('t-3','${SYNTHETIC_COMPANY.propertyId}','${SYNTHETIC_COMPANY.unitId}','person-3','past',NOW(),'manual','manual','manual','manual'),
              ('t-4','demo-property-b','demo-unit-b-1','person-4','past',NOW(),'manual','manual','manual','manual'),
              ('t-5','foreign-property','foreign-unit-1','person-5','past',NOW(),'manual','manual','manual','manual');
      UPDATE rent_ops_tenancies SET actual_move_in_on='2021-01-01', actual_move_out_on='2021-12-31' WHERE id='t-1';
      UPDATE rent_ops_tenancies SET actual_move_in_on='2022-01-01' WHERE id='t-2';
      UPDATE rent_ops_tenancies SET actual_move_in_on='2019-01-01', actual_move_out_on='2019-12-31' WHERE id='t-3';`);
    assert.equal((await h.executor.transaction!(tx => linkTenancyToQboCustomer(tx, input))).status, "linked");
    assert.equal((await h.executor.transaction!(tx => linkTenancyToQboCustomer(tx, input))).status, "already_linked");
    // The next occupant of the same unit never inherits the former tenant's history.
    await assert.rejects(h.executor.transaction!(tx => linkTenancyToQboCustomer(tx, { ...input, tenancyId: "t-2" })), (error: unknown) => error instanceof AccountingError && /another tenancy/.test(error.message));
    await assert.rejects(h.executor.transaction!(tx => linkTenancyToQboCustomer(tx, { ...input, customerObjectId: "59" })), (error: unknown) => error instanceof AccountingError && /different QuickBooks customer/.test(error.message));
    await assert.rejects(h.executor.transaction!(tx => linkTenancyToQboCustomer(tx, { ...input, tenancyId: "t-2", customerObjectId: "999" })), (error: unknown) => error instanceof AccountingError && error.code === "accounting_not_found");
    // A globally existing tenancy outside the legal entity's historical
    // property assignment cannot be linked or used to resolve a stale map.
    await assert.rejects(h.executor.transaction!(tx => linkTenancyToQboCustomer(tx, { ...input, tenancyId: "t-3", customerObjectId: "59" })), (error: unknown) => error instanceof AccountingError && error.code === "accounting_not_found");
    // A property assigned to another legal entity in this organization, or to
    // an entirely different organization, is outside the requested scope.
    await assert.rejects(h.executor.transaction!(tx => linkTenancyToQboCustomer(tx, { ...input, tenancyId: "t-4", customerObjectId: "59" })), (error: unknown) => error instanceof AccountingError && error.code === "accounting_not_found");
    await assert.rejects(h.executor.transaction!(tx => linkTenancyToQboCustomer(tx, { ...input, tenancyId: "t-5", customerObjectId: "59" })), (error: unknown) => error instanceof AccountingError && error.code === "accounting_not_found");
    await h.synthetic.db.query(
      "INSERT INTO company_external_identities (id, organization_id, legal_entity_id, provider, source_scope, record_kind, external_id, local_kind, local_id) VALUES ('50000000-0000-4000-8000-000000000002',$1,$2::uuid,'qbo','qbo:sandbox:123456','Customer','59','tenancy','t-3')",
      [scope.organizationId, scope.legalEntityId],
    );
    assert.equal(await resolveTenancyCustomer(h.executor, { organizationId: scope.organizationId, tenancyId: "t-3", environment: "sandbox" }), null);
    const link = await resolveTenancyCustomer(h.executor, { organizationId: scope.organizationId, tenancyId: "t-1", environment: "sandbox" });
    assert.deepEqual(link, { scope: sourceScope, customerObjectId: "58" });
    assert.equal(await resolveTenancyCustomer(h.executor, { organizationId: scope.organizationId, tenancyId: "t-1", environment: "production" }), null);
    assert.equal(await resolveTenancyCustomer(h.executor, { organizationId: scope.organizationId, tenancyId: "t-2", environment: "sandbox" }), null);
  } finally {
    await h.close();
  }
});

test("provider customer balances convert exactly", () => {
  assert.equal(providerBalanceCents("1225.00"), "122500");
  assert.equal(providerBalanceCents("-3.5"), "-350");
  assert.equal(providerBalanceCents(1225), "122500");
  assert.equal(providerBalanceCents(0.1), "10");
  assert.equal(providerBalanceCents("12.345"), null);
  assert.equal(providerBalanceCents(undefined), null);
});

test("customer ledger uses accepted same-version observations without accepting material profile changes", async () => {
  const h = await harness(baseStore());
  try {
    await h.sync.syncChanges();
    const mirror = createQboAccountingMirrorStore(h.executor, () => new Date("2026-09-22T00:00:00Z"));
    const observe = (body: QuickBooksJsonObject) => mirror.ingestNamedObject({ scope, objectType: "Customer", objectId: "58", version: "0", providerBody: body, providerUpdatedAt: T("20") });
    await observe(customer("58", "1000.00"));
    assert.equal((await h.ledger()).verification.providerBalanceCents, "100000");
    await observe(customer("58", "1225.00"));
    assert.equal((await h.ledger()).verification.providerBalanceCents, "122500");
    const conflict = await observe(customer("58", "9999.00", { Taxable: true }));
    assert.equal(conflict.conflict, true);
    assert.equal((await h.ledger()).verification.providerBalanceCents, "122500");
    const original = (await h.synthetic.db.query<{ provider_body: { Balance: string } }>("SELECT provider_body FROM accounting_qbo_source_objects WHERE object_type='Customer' AND object_id='58'" )).rows[0];
    assert.equal(original.provider_body.Balance, "1225.00");
  } finally { await h.close(); }
});
