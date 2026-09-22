import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMraSource, parseStructuredMraPacket } from "./source-adapters";

function packetLine(overrides: Record<string, unknown> = {}) {
  return {
    sourceAccountId: "bank-1",
    postedOn: "2026-09-01",
    amount: "1.00",
    category: "rent",
    payer: "tenant",
    evidence: [{ sourcePath: "packet.json#1" }],
    ...overrides,
  };
}

function packet(lines: unknown[]) {
  return {
    format: "mra.owner_packet.v1",
    period: { from: "2026-09-01", through: "2026-09-30" },
    accounts: [{ sourceAccountId: "bank-1", lines }],
  };
}

describe("MRA source adapters", () => {
  it("converts dollar text exactly, including currency and parentheses", () => {
    const result = parseStructuredMraPacket(packet([
      packetLine({ amount: "$123.45", providerTransactionId: "tx-1" }),
      packetLine({ amount: "(1,000.00)", postedOn: "2026-09-02", providerTransactionId: "tx-2" }),
    ]));
    assert.deepEqual(result.accounts[0]!.lines.map((line) => line.amountCents), ["12345", "-100000"]);
  });

  it("keeps explicit cent inputs separate from dollar inputs", () => {
    const result = parseStructuredMraPacket(packet([
      packetLine({ amountCents: "12345", providerTransactionId: "cent-1" }),
      packetLine({ amount: 123.45, postedOn: "2026-09-02", providerTransactionId: "dollar-1" }),
    ]));
    assert.deepEqual(result.accounts[0]!.lines.map((line) => line.amountCents), ["12345", "12345"]);
    assert.throws(() => parseStructuredMraPacket(packet([packetLine({ amountCents: "123.456", providerTransactionId: "bad-1" })])), /intake_amount_cents_not_integer/);
    assert.throws(() => parseStructuredMraPacket(packet([packetLine({ amount: Number.MAX_SAFE_INTEGER, providerTransactionId: "bad-2" })])), /intake_amount_unsafe_number/);
  });

  it("uses provider transaction IDs and rejects indistinguishable duplicates", () => {
    const first = parseStructuredMraPacket(packet([packetLine({ providerTransactionId: "tx-a" }), packetLine({ postedOn: "2026-09-02", providerTransactionId: "tx-b" })]));
    const reordered = parseStructuredMraPacket(packet([packetLine({ postedOn: "2026-09-02", providerTransactionId: "tx-b" }), packetLine({ providerTransactionId: "tx-a" })]));
    assert.deepEqual(first.accounts[0]!.lines.map((line) => line.sourceLineKey).sort(), reordered.accounts[0]!.lines.map((line) => line.sourceLineKey).sort());
    assert.throws(() => parseStructuredMraPacket(packet([packetLine(), packetLine()])), /intake_source_line_identity_ambiguous/);
  });

  it("fails closed for malformed PDFs instead of parsing raw PDF literals", async () => {
    await assert.rejects(
      () => parseMraSource({ bytes: new TextEncoder().encode("%PDF-1.7 (bank-1|2026-09-01|100.00)"), fileName: "packet.pdf", declaredContentType: "application/pdf" }),
    );
  });
});
