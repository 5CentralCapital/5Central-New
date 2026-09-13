import { z } from "zod";
const cents = z.number().int().safe().nullable();
export const bankingSnapshotSchema = z.object({
  state: z.enum(["unconfigured", "ready", "partial", "unavailable"]),
  fetchedAt: z.string().datetime(), fromDate: z.string(), throughDate: z.string(),
  connections: z.array(z.object({
    id: z.string(), name: z.string(), balancesState: z.enum(["ready", "unavailable"]),
    transactionsLastSuccessfulUpdate: z.string().datetime().nullable(),
    transactionsLastFailedUpdate: z.string().datetime().nullable(),
    transactionsState: z.enum(["ready", "partial", "unavailable"]),
    accounts: z.array(z.object({ id: z.string(), name: z.string(), mask: z.string().nullable(), type: z.string(), currency: z.string().nullable(), currentCents: cents, availableCents: cents })),
    transactions: z.array(z.object({ id: z.string(), accountId: z.string(), date: z.string(), description: z.string(), amountCents: cents, currency: z.string().nullable(), pending: z.boolean() })),
  })),
}).strict();
export type BankingSnapshot = z.infer<typeof bankingSnapshotSchema>;
