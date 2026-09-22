import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { RentOpsQueryExecutor } from "./rent-ops/repositories/postgres";

export async function bootstrapAdministrator(database: RentOpsQueryExecutor, input: { email: string; password: string }, hash: (password: string) => Promise<string>): Promise<void> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 240) throw new Error("A valid administrator email is required");
  if (input.password.length < 16 || input.password.length > 128 || Buffer.byteLength(input.password) > 512) throw new Error("Use a password of 16 to 128 characters");
  const passwordHash = await hash(input.password);
  const result = await database.query(`INSERT INTO users (id, email, password, role, first_name, last_name)
    VALUES ($1, $2, $3, 'admin', 'Administrator', '') ON CONFLICT DO NOTHING RETURNING id`, [randomUUID(), email, passwordHash]);
  if (!result.rows.length) throw new Error("Account already exists; no credentials or roles were changed");
}

async function main() {
  // Password enters over stdin, never argv, logs, or a checked-in default.
  if (process.stdin.isTTY) throw new Error("Provide the password over protected stdin; do not put it in command arguments");
  let password = "";
  for await (const chunk of process.stdin) {
    password += chunk.toString();
    if (Buffer.byteLength(password) > 514) throw new Error("Password input is too long");
  }
  password = password.replace(/\r?\n$/, "");
  const email = process.env.RENT_OPS_ADMIN_EMAIL ?? "";
  const { pool } = await import("./db");
  try {
    const { hashPassword } = await import("./auth");
    await bootstrapAdministrator(pool as unknown as RentOpsQueryExecutor, { email, password }, hashPassword);
    console.log("Administrator created. No existing account was changed.");
  } finally { await pool.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(() => { console.error("Administrator bootstrap failed. Verify configuration, password requirements, and whether the account already exists."); process.exitCode = 1; });
}
