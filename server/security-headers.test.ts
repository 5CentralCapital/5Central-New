import assert from "node:assert/strict";
import express from "express";
import test from "node:test";
import { securityHeaders } from "./security-headers";

async function withServer(handler: express.RequestHandler, callback: (origin: string) => Promise<void>) {
  const app = express();
  app.disable("x-powered-by");
  app.use(handler);
  app.all("*", (_request, response) => response.status(200).send("ok"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test("security headers are consistent and HSTS is production-only", async () => {
  await withServer(securityHeaders({ production: false }), async origin => {
    const response = await fetch(origin);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.equal(response.headers.get("strict-transport-security"), null);
    assert.equal(response.headers.get("x-powered-by"), null);
  });

  await withServer(securityHeaders({ production: true }), async origin => {
    const response = await fetch(origin);
    assert.equal(response.headers.get("strict-transport-security"), "max-age=31536000");
  });
});

test("TRACE and TRACK are rejected before route handlers", () => {
  const middleware = securityHeaders({ production: false });
  for (const method of ["TRACE", "TRACK"]) {
    let status = 0;
    let nextCalled = false;
    middleware(
      { method } as Parameters<typeof middleware>[0],
      {
        setHeader() {},
        sendStatus(code: number) {
          status = code;
          return this;
        },
      } as unknown as Parameters<typeof middleware>[1],
      () => { nextCalled = true; },
    );
    assert.equal(status, 405, `${method} should be rejected`);
    assert.equal(nextCalled, false, `${method} should not reach route handlers`);
  }
});
