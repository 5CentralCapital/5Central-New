import assert from "node:assert/strict";
import test from "node:test";

// routes.ts imports the database singleton, but this test never queries it.
process.env.DATABASE_URL ??= "postgresql://synthetic:synthetic@localhost/synthetic";
const { err } = await import("./routes");

test("module route failures do not echo database error text to the client", () => {
  const sent: Array<{ status: number; body: unknown }> = [];
  const res = { status(code: number) { return { json(body: unknown) { sent.push({ status: code, body }); } }; } } as never;
  const originalError = console.error;
  console.error = () => undefined;
  try {
    err(res, new Error('duplicate key value violates unique constraint "investor_leads_email_key": Key (email)=(someone@example.test) already exists.'));
  } finally { console.error = originalError; }
  assert.deepEqual(sent, [{ status: 500, body: { error: "Internal error" } }]);
});
