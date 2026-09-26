import assert from "node:assert/strict";
import test from "node:test";
import type { QuickBooksTransportRequest, QuickBooksTransportResponse } from "../../shared/accounting/quickbooks";
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from "../company/testing/synthetic-database";
import { createQuickBooksAccountingClient } from "../integrations/quickbooks/accounting";
import { AccountingError } from "./errors";
import { assertQboWriteFields, createQboWriteService, qboWritePolicyFromEnv } from "./qbo-write";
import { hasQboSourceTag, qboSourceTag, withQboSourceTag } from "./qbo-source-tag";

test("creates without a natural key get a stable 5CO tag line in their internal note", () => {
  for (const entity of ["Invoice", "Payment", "CreditMemo", "SalesReceipt", "RefundReceipt", "JournalEntry", "Bill"]) {
    assert.deepEqual(withQboSourceTag(entity, "create", { TxnDate: "2026-09-01" }, "cmd:op-1"), { TxnDate: "2026-09-01", PrivateNote: "5CO:cmd:op-1" }, entity);
  }
  // Customer has no PrivateNote in the QuickBooks API; its internal note is Notes.
  assert.deepEqual(withQboSourceTag("Customer", "create", { DisplayName: "Ada" }, "cmd:op-2"), { DisplayName: "Ada", Notes: "5CO:cmd:op-2" });
  assert.deepEqual(withQboSourceTag("Bill", "create", { PrivateNote: "Roof repair, invoice 7  \n" }, "k"), { PrivateNote: "Roof repair, invoice 7\n5CO:k" }, "existing text is kept");
  // Updates and other entities are unchanged.
  const fields = { PrivateNote: "corrected" };
  assert.equal(withQboSourceTag("Invoice", "update", fields, "k"), fields);
  assert.deepEqual(withQboSourceTag("Vendor", "create", { DisplayName: "Supply" }, "k"), { DisplayName: "Supply" });
});

test("the tag is idempotent and fits Intuit's note limits without losing the tag", () => {
  const once = withQboSourceTag("Invoice", "create", { PrivateNote: "Note" }, "k-1");
  assert.deepEqual(withQboSourceTag("Invoice", "create", once, "k-1"), once, "re-tagging does not add a second line");
  const long = withQboSourceTag("JournalEntry", "create", { PrivateNote: "x".repeat(5000) }, "cmd:op-3").PrivateNote as string;
  assert.equal(long.length, 4000);
  assert.ok(long.endsWith("\n5CO:cmd:op-3"));
  const customer = withQboSourceTag("Customer", "create", { Notes: "y".repeat(2500) }, "cmd:op-4").Notes as string;
  assert.equal(customer.length, 2000);
  assert.ok(customer.endsWith("\n5CO:cmd:op-4"));
  // A surrogate pair is never split at the cut.
  const emoji = withQboSourceTag("Bill", "create", { PrivateNote: "a" + "\u{1F3E0}".repeat(2500) }, "k").PrivateNote as string;
  assert.ok(emoji.length <= 4000);
  assert.doesNotMatch(emoji, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  assert.throws(() => withQboSourceTag("Bill", "create", { PrivateNote: 12 }, "k"), (error: unknown) => error instanceof AccountingError && error.code === "accounting_validation");
  assert.throws(() => assertQboWriteFields({ scope: { organizationId: SYNTHETIC_COMPANY.organizationId, legalEntityId: SYNTHETIC_COMPANY.entityId, environment: "sandbox", realmId: "1" }, operationKey: "k", entity: "Bill", operation: "create", fields: { PrivateNote: { text: "x" } } }), /must be text/);
});

test("a record read back from QuickBooks is matched by its exact tag line", () => {
  assert.equal(qboSourceTag("cmd:abc"), "5CO:cmd:abc");
  assert.equal(hasQboSourceTag("Invoice", { PrivateNote: "Note\n5CO:cmd:abc" }, "cmd:abc"), true);
  assert.equal(hasQboSourceTag("Invoice", { PrivateNote: "Note\r\n 5CO:cmd:abc " }, "cmd:abc"), true);
  assert.equal(hasQboSourceTag("Invoice", { PrivateNote: "5CO:cmd:abcd" }, "cmd:abc"), false, "a longer key is not a match");
  assert.equal(hasQboSourceTag("Invoice", { PrivateNote: "see 5CO:cmd:abc" }, "cmd:abc"), false, "the tag must be its own line");
  assert.equal(hasQboSourceTag("Customer", { Notes: "5CO:cmd:abc" }, "cmd:abc"), true);
  assert.equal(hasQboSourceTag("Vendor", { Notes: "5CO:cmd:abc" }, "cmd:abc"), false);
  assert.equal(hasQboSourceTag("Invoice", null, "cmd:abc"), false);
});

test("the write service sends the tag with the create and hashes the tagged request (writes enabled only in this test)", async () => {
  const synthetic = await createSyntheticCompanyDatabase();
  try {
    const executor = await createSyntheticRuntimeExecutor(synthetic.db);
    const scope = { organizationId: SYNTHETIC_COMPANY.organizationId, legalEntityId: SYNTHETIC_COMPANY.entityId, environment: "sandbox" as const, realmId: "4620816365001234567" };
    const posts: Record<string, unknown>[] = [];
    const saved = new Map<string, Record<string, unknown>>();
    const transport = async (request: QuickBooksTransportRequest): Promise<QuickBooksTransportResponse> => {
      const [, entity = "", id] = /\/company\/\d+\/(\w+)(?:\/(\w+))?/.exec(new URL(request.url).pathname) ?? [];
      const name = entity.charAt(0).toUpperCase() + entity.slice(1);
      if (request.method === "POST") {
        const body = JSON.parse(request.body ?? "{}") as Record<string, unknown>;
        posts.push(body);
        saved.set(String(40 + posts.length), { Id: String(40 + posts.length), SyncToken: "0", ...body });
        return { status: 200, body: JSON.stringify({ [name]: saved.get(String(40 + posts.length)) }), headers: { intuit_tid: "tid" } };
      }
      const found = id ? saved.get(id) : undefined;
      return found ? { status: 200, body: JSON.stringify({ [name]: found }), headers: {} } : { status: 400, body: JSON.stringify({ Fault: { Error: [{ code: "610" }] } }), headers: {} };
    };
    const client = createQuickBooksAccountingClient({ scope, getAccessToken: async () => "access-token", transport });
    const writer = createQboWriteService({ executor, clientFor: () => client, policy: qboWritePolicyFromEnv({ QBO_WRITES_ENABLED: "on", QBO_WRITE_TYPES: "Customer:create,Bill:create" }) });
    const customer = await writer.execute({ scope, operationKey: "cmd:customer-1", entity: "Customer", operation: "create", fields: { DisplayName: "Ada Example · Oak Court 1A · RM4411" } });
    assert.equal(customer.status, "confirmed");
    assert.equal(posts[0]!.Notes, "5CO:cmd:customer-1");
    const bill = await writer.execute({ scope, operationKey: "cmd:bill-1", entity: "Bill", operation: "create", fields: { PrivateNote: "Roof repair", VendorRef: { value: "70" } } });
    assert.equal(bill.status, "confirmed");
    assert.equal(posts[1]!.PrivateNote, "Roof repair\n5CO:cmd:bill-1");
    assert.equal(hasQboSourceTag("Bill", posts[1] as never, "cmd:bill-1"), true);
    // The same envelope replays as confirmed: the tag is deterministic, so the request hash matches.
    assert.equal((await writer.execute({ scope, operationKey: "cmd:bill-1", entity: "Bill", operation: "create", fields: { PrivateNote: "Roof repair", VendorRef: { value: "70" } } })).status, "confirmed");
    assert.equal(posts.length, 2);
  } finally {
    await synthetic.close();
  }
});
