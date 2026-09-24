import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { publicRequestError, startupFailureSummary } from "./request-errors";
import { RentOpsRuntimePrivilegeError, RentOpsTablesMissingError } from "./rent-ops/repositories/postgres";

test("malformed tenant and auth JSON never echoes submitted credentials", async () => {
  const app = express();
  app.use(express.json());
  app.post("*", (_req,res) => res.sendStatus(204));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const { status, message } = publicRequestError(error);
    res.status(status).json({ message });
  });
  const server = app.listen(0,"127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const address = server.address() as { port: number };
    for (const path of ["/api/tenant/auth/login", "/api/rent-ops/auth/login", "/api/tenant/auth/activate"]) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"password":"SubmittedSecret-2026","token":"ActivationSecret"' });
      assert.equal(response.status, 400);
      assert.equal(await response.text(), '{"message":"Invalid request"}');
    }
  } finally { await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); }
});

test("startup failures log their class and stable code, never free-text messages", () => {
  class StorageError extends Error { readonly code = "storage_privilege_probe_failed"; }
  assert.equal(startupFailureSummary(new StorageError("storage_privilege_probe_failed")), "StorageError:storage_privilege_probe_failed");
  assert.equal(startupFailureSummary(Object.assign(new Error("listen EADDRINUSE: address already in use 0.0.0.0:10000"), { code: "EADDRINUSE" })), "Error:EADDRINUSE");
  assert.equal(startupFailureSummary(new Error("public_database_limiter_configuration_required")), "Error:public_database_limiter_configuration_required");
  assert.equal(startupFailureSummary(new Error("connect failed for postgres://owner:Secret@db.example/app")), "Error");
  assert.equal(startupFailureSummary("postgres://owner:Secret@db.example/app"), "unclassified");
});

test("startup failures identify missing runtime schema and privilege probes without table names", () => {
  const missing = startupFailureSummary(new RentOpsTablesMissingError(["rent_ops_properties", "rent_ops_units"]));
  assert.equal(missing, "RentOpsTablesMissingError:rent_ops_runtime_tables_missing");
  assert.doesNotMatch(missing, /rent_ops_properties|rent_ops_units/);
  assert.equal(startupFailureSummary(new RentOpsRuntimePrivilegeError()), "RentOpsRuntimePrivilegeError:rent_ops_runtime_privilege_invalid");
});
