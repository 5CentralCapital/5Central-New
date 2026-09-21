import assert from "node:assert/strict";
import test from "node:test";
import { createQuickBooksFetchTransport } from "./transport";
import { QuickBooksIntegrationError } from "./errors";

test("fetch transport enforces an injected timeout without making a real request", async () => {
  let called = false;
  const transport = createQuickBooksFetchTransport({
    timeoutMs: 5,
    fetchImpl: async (_url, init) => {
      called = true;
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
      throw new Error("unreachable");
    },
  });
  await assert.rejects(
    () => transport({ method: "GET", url: "https://sandbox-quickbooks.api.intuit.com", headers: {} }),
    (error: unknown) => {
      assert.ok(error instanceof QuickBooksIntegrationError);
      assert.equal(error.code, "quickbooks_timeout");
      return true;
    },
  );
  assert.equal(called, true);
});

test("fetch transport allowlists Intuit HTTPS origins and rejects redirects", async () => {
  let init: RequestInit | undefined;
  const transport = createQuickBooksFetchTransport({
    fetchImpl: async (_url, requestInit) => {
      init = requestInit;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await transport({ method: "GET", url: "https://sandbox-quickbooks.api.intuit.com/v3/company/123/Account/1", headers: {} });
  assert.equal(init?.redirect, "error");
  await assert.rejects(
    () => transport({ method: "GET", url: "https://example.test/v3/company/123/Account/1", headers: { Authorization: "Bearer secret" } }),
    /allowed Intuit HTTPS endpoint/,
  );
});

test("fetch transport does not send an already-cancelled request", async () => {
  let called = false;
  const controller = new AbortController();
  controller.abort();
  const transport = createQuickBooksFetchTransport({ fetchImpl: async () => { called = true; return new Response("{}"); } });
  await assert.rejects(
    () => transport({ method: "GET", url: "https://sandbox-quickbooks.api.intuit.com", headers: {}, signal: controller.signal }),
    /cancelled before sending/,
  );
  assert.equal(called, false);
});
