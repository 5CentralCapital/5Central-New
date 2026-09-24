/**
 * QuickBooks customer plan (read-only). Prints JSON: per legal entity, one
 * proposed QuickBooks Customer per tenancy with its status, counts and a
 * planSha256. It never calls QuickBooks and never writes; the plan is for
 * review while QuickBooks writes stay off.
 *
 * Usage:
 *   npm run company:qbo-customer-plan -- [--organization <uuid>] [--legal-entity <uuid>] [--environment production|sandbox] [--as-of YYYY-MM-DD]
 *
 * Uses RENT_OPS_RUNTIME_DATABASE_URL (its value is never printed). The
 * organization defaults to the only one in the database.
 */
import { pathToFileURL } from "node:url";
import { isoDateSchema, legalEntityIdSchema, organizationIdSchema } from "../../shared/company";
import type { RentOpsQueryExecutor } from "../../server/rent-ops/repositories/postgres";
import { readQboCustomerPlan } from "../../server/accounting/qbo-customer-plan-service";
import type { QboCustomerPlan } from "../../server/accounting/qbo-customer-plan";

export interface CustomerPlanArgs {
  readonly organizationId: string | null;
  readonly legalEntityId: string | null;
  readonly environment: "sandbox" | "production";
  readonly asOf: string | null;
}

const FLAGS = new Set(["organization", "legal-entity", "environment", "as-of"]);

export class CustomerPlanCliError extends Error {}

export function parseCustomerPlanArgs(argv: readonly string[]): CustomerPlanArgs {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]!;
    const value = argv[index + 1];
    const name = flag.startsWith("--") ? flag.slice(2) : "";
    if (!FLAGS.has(name) || value === undefined || value.startsWith("--")) throw new CustomerPlanCliError(`Unexpected argument: ${flag}`);
    values[name] = value;
  }
  const environment = values.environment ?? "production";
  if (environment !== "production" && environment !== "sandbox") throw new CustomerPlanCliError("--environment must be production or sandbox");
  const valid = (label: string, value: string | undefined, ok: (text: string) => boolean): string | null => {
    if (value === undefined) return null;
    if (!ok(value)) throw new CustomerPlanCliError(`${label} is invalid`);
    return value;
  };
  return {
    organizationId: valid("--organization", values.organization, text => organizationIdSchema.safeParse(text).success),
    legalEntityId: valid("--legal-entity", values["legal-entity"], text => legalEntityIdSchema.safeParse(text).success),
    environment,
    asOf: valid("--as-of", values["as-of"], text => isoDateSchema.safeParse(text).success),
  };
}

export async function runCustomerPlanCli(argv: readonly string[], executor: RentOpsQueryExecutor, today: string): Promise<QboCustomerPlan> {
  const args = parseCustomerPlanArgs(argv);
  const read = async (transaction: RentOpsQueryExecutor) => {
    let organizationId = args.organizationId;
    if (!organizationId) {
      const organizations = await transaction.query<{ id: unknown }>("SELECT id FROM company_organizations ORDER BY id LIMIT 2");
      if (organizations.rows.length !== 1) throw new CustomerPlanCliError("Pass --organization <uuid>; the database does not hold exactly one organization");
      organizationId = String(organizations.rows[0]!.id);
    }
    return readQboCustomerPlan(transaction, { organizationId, environment: args.environment, asOf: args.asOf ?? today, ...(args.legalEntityId ? { legalEntityId: args.legalEntityId } : {}) });
  };
  return executor.transaction ? executor.transaction(read, { readOnly: true }) : read(executor);
}

async function main(): Promise<void> {
  const { createRentOpsRuntimeDatabase } = await import("../../server/rent-ops/runtime-database");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const database = await createRentOpsRuntimeDatabase();
  try {
    console.log(JSON.stringify(await runCustomerPlanCli(process.argv.slice(2), database, today), null, 2));
  } finally {
    await database.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(error => {
    // Driver errors can echo connection details; print only our own messages.
    const message = error instanceof CustomerPlanCliError ? error.message : "The customer plan could not be read (check RENT_OPS_RUNTIME_DATABASE_URL and the arguments)";
    console.error(JSON.stringify({ ok: false, message }));
    process.exitCode = 1;
  });
}
