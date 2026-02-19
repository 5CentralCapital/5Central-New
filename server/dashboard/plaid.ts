import { Configuration, PlaidApi, PlaidEnvironments, Products, CountryCode } from "plaid";

/**
 * Plaid client configuration.
 *
 * Required environment variables:
 *   PLAID_CLIENT_ID   – from https://dashboard.plaid.com/team/keys
 *   PLAID_SECRET      – sandbox or development secret
 *   PLAID_ENV         – "sandbox" | "development" | "production"
 *
 * Optional:
 *   PLAID_REDIRECT_URI – for OAuth redirects (mobile/web)
 */

const PLAID_ENV = (process.env.PLAID_ENV || "sandbox") as keyof typeof PlaidEnvironments;

const configuration = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID || "",
      "PLAID-SECRET": process.env.PLAID_SECRET || "",
      "Plaid-Version": "2020-09-14",
    },
  },
});

export const plaidClient = new PlaidApi(configuration);

/** Products we request from Plaid Link */
export const PLAID_PRODUCTS: Products[] = [
  Products.Transactions,
  Products.Auth,
];

export const PLAID_COUNTRY_CODES: CountryCode[] = [CountryCode.Us];

export const PLAID_REDIRECT_URI = process.env.PLAID_REDIRECT_URI || "";

/** Check if Plaid credentials are configured */
export function isPlaidConfigured(): boolean {
  return !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}
