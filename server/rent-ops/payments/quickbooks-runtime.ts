import { z } from "zod";
import type { AccountingServices } from "../../accounting";
import type { RentOpsQueryExecutor } from "../repositories/postgres";
import type { TenantQuickBooksPayments } from "./quickbooks-routes";
import { createQboHostedPaymentService, qboHostedConfigFromEnv } from "./qbo-hosted";

/** Uses the existing entity-scoped OAuth client. It never receives write privileges. */
export function createTenantQuickBooksPayments(options: {
  executor: RentOpsQueryExecutor;
  accounting: AccountingServices;
  env: NodeJS.ProcessEnv;
}): TenantQuickBooksPayments {
  const organization = z.string().uuid().safeParse(options.env.RENT_OPS_QBO_TENANT_PAYMENTS_ORGANIZATION_ID);
  const qbo = options.accounting.qbo;
  const off: TenantQuickBooksPayments = {
    async list() { return { provider: "quickbooks", available: false, reasons: ["payments_not_configured"], invoices: [] }; },
    async link() { throw new Error("quickbooks_payments_unavailable"); },
  };
  if (!organization.success || qbo.status !== "configured") return off;
  const hosted = createQboHostedPaymentService({
    executor: options.executor,
    config: qboHostedConfigFromEnv(options.env),
    clientFor: scope => {
      const client = qbo.createAccountingClient(scope);
      return {
        read: (...args) => client.read(...args),
        query: (...args) => client.query(...args),
        readInvoiceWithLink: (...args) => client.readInvoiceWithLink(...args),
      };
    },
  });
  return {
    list: identity => hosted.getTenantView({ organizationId: organization.data, identity }),
    link: (identity, invoiceId) => hosted.getInvoiceLink({ organizationId: organization.data, identity, invoiceId }),
  };
}
