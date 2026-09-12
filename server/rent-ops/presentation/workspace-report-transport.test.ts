import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import express from "express";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";
import { SyntheticRentOpsRepository } from "../repositories/synthetic";
import { registerRentOpsRoutes } from "../routes";

test("report JSON negotiates equivalent gzip/identity with unchanged auth, filters and headers", async () => {
  const fixture = structuredClone(syntheticRentOpsSnapshot());
  fixture.ledgerTransactions.push(...Array.from({length: 400}, (_, index) => ({...fixture.ledgerTransactions[0], id: `synthetic-charge-${index}`, amountCents: 1})));
  const app = express();
  registerRentOpsRoutes(app, {
    repository: new SyntheticRentOpsRepository(fixture),
    requireAdmin: (req, res, next) => {if (req.headers["x-test-admin"] !== "yes") {res.sendStatus(401); return;} next();},
    now: () => new Date("2026-08-15T12:00:00.000Z"),
  });
  const server = await new Promise<http.Server>(resolve => {const listener = app.listen(0, "127.0.0.1", () => resolve(listener));});
  const request = (path: string, encoding?: string, authorized = true) => new Promise<{body: Buffer; headers: http.IncomingHttpHeaders; status: number}>((resolve, reject) => {
    http.get({host: "127.0.0.1", port: (server.address() as AddressInfo).port, path: `/api/rent-ops${path}`, headers: {...(encoding ? {"accept-encoding": encoding} : {}), ...(authorized ? {"x-test-admin": "yes"} : {})}}, response => {
      const chunks: Buffer[] = [];
      response.on("error", reject);
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({body: Buffer.concat(chunks), headers: response.headers, status: response.statusCode!}));
    }).on("error", reject);
  });
  try {
    for (const path of ["/reports/tenant-ledger?propertyId=demo-property-a&asOfDate=2026-08-15", "/ledger/demo-tenancy-1?asOfDate=2026-08-15"]) {
      assert.equal((await request(path, "gzip", false)).status, 401);
      const plain = await request(path);
      const compressed = await request(path, "gzip");
      const refused = await request(path, "gzip;q=0, identity;q=1");
      assert.equal(plain.status, 200);
      assert.equal(compressed.status, 200);
      assert.equal(plain.headers["content-encoding"], undefined);
      assert.equal(compressed.headers["content-encoding"], "gzip");
      for (const response of [plain, compressed, refused]) {
        assert.equal(response.headers["cache-control"], "no-store");
        assert.match(String(response.headers.vary), /Accept-Encoding/);
        assert.match(String(response.headers["content-type"]), /application\/json/);
        assert.equal(Number(response.headers["content-length"]), response.body.length);
      }
      assert.match(String(compressed.headers.vary), /Accept-Encoding/);
      assert.match(String(compressed.headers["content-type"]), /application\/json/);
      assert.deepEqual(gunzipSync(compressed.body), plain.body);
      assert.deepEqual(refused.body, plain.body);
      assert.equal(refused.headers["content-encoding"], undefined);
      assert.ok(compressed.body.length < plain.body.length / 4);
      const parsed = JSON.parse(plain.body.toString());
      if (!Array.isArray(parsed)) assert.equal(parsed.filters.propertyId, "demo-property-a");
      const rows = Array.isArray(parsed) ? parsed : parsed.rows;
      assert.ok(rows.length > 400);
      for (const row of rows) {
        assert.equal(row.transaction.propertyId, "demo-property-a");
        if (Array.isArray(parsed)) assert.equal(row.transaction.tenancyId, "demo-tenancy-1");
      }
    }
    const invalid = await request("/reports/tenant-ledger?asOfDate=invalid", "gzip");
    assert.equal(invalid.status, 400);
    const csv = await request("/reports/tenant-ledger/csv?asOfDate=2026-08-15", "gzip");
    assert.equal(csv.status, 200);
    assert.match(String(csv.headers["content-type"]), /text\/csv/);
    assert.equal(csv.headers["content-encoding"], undefined);
  } finally {await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));}
});
