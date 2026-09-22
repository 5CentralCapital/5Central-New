import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { publicRequestError } from "./request-errors";

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
