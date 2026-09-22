import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createRentOpsDemoApp } from "./demo-server";

test("synthetic demo exposes the dedicated Rent Ops session contract without credentials", async () => {
  const server = createRentOpsDemoApp({ publicDir: process.cwd() }).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const sessionResponse = await fetch(`${baseUrl}/api/rent-ops/auth/session`);
    const session = await sessionResponse.json() as Record<string, unknown>;
    const user = session.user as Record<string, unknown>;

    assert.equal(sessionResponse.status, 200);
    assert.equal(user.email, "demo-admin@example.test");
    assert.equal(user.role, "admin");
    assert.equal(typeof session.csrfToken, "string");
    assert.ok(String(session.csrfToken).length >= 32);

    const previewContextResponse = await fetch(`${baseUrl}/api/rent-ops/preview-context`);
    const previewContext = await previewContextResponse.json() as Record<string, unknown>;
    assert.equal(previewContextResponse.status, 200);
    assert.equal(previewContext.dataMode, "synthetic");

    const csrfResponse = await fetch(`${baseUrl}/api/rent-ops/auth/csrf`);
    const csrf = await csrfResponse.json() as Record<string, unknown>;
    assert.equal(csrf.csrfToken, session.csrfToken);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
