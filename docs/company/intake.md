# MRA and company document intake

MRA owner packets enter R-ops through the server-attested Codex ingestion port. The web and Mac company surfaces are read-only for MRA results: they list verified packets, normalized lines, reconciliation totals, outcomes, and source evidence. They do not expose upload, mapping, preview, or apply controls.

The ingestion lifecycle is durable and resumable:

1. `stage` verifies the immutable source bytes, checksum, object version, and private document binding, then stores the packet and normalized observations.
2. `map` records reviewed local identities while retaining the source identities and evidence.
3. `preview` calculates duplicate, overlap, correction, held, and ready outcomes without changing tenant accounts.
4. `apply` runs the approved account commands inside the transaction supplied by the company command runner. Account groups use savepoints, deterministic source line identities, and replay-safe record IDs.

The transport must be created by the server Codex adapter with `channel: codex_mcp` and capability `mra_ingestion`. Body fields cannot grant that capability. The service rechecks the command envelope, organization scope, and authenticated principal before each operation. A missing or malformed attestation fails closed.

Every source line retains its provider transaction identity when supplied, or a content fingerprint when the content is unique within the packet. Identical rows without a provider identity are held as ambiguous. A global row number is never used as the durable identity. Corrections must name the earlier source line; a later packet is not allowed to append a second receipt silently.

Amounts are integer cents at the normalized boundary. Explicit `amountCents` values are parsed as exact integer cents. `amount` values are parsed as exact dollar decimals, including currency symbols and parentheses; more than two decimal places, unsafe numeric values, and malformed values are rejected. Spreadsheet numeric cells are accepted only through the explicit legacy-dollar adapter and are bounded by safe cent precision.

The source semantic is separate from the accounting category. A line must explicitly identify an incoming `payment` with `inflow` direction before it can be considered for a tenant account command. Charges, balance observations, credits, refunds, adjustments, property-management remittances, unknown semantics, and HAP receipts without a compatible subsidy allocation command remain visible as held review outcomes. A deposit receipt uses the typed security-deposit ledger path and is never converted to rent. The adapter does not infer receipt status from a positive amount or a category label.

The PDF adapter accepts only the constrained synthetic itemized-row format used by source-controlled tests. It preserves row evidence and rejects malformed or unreadable PDFs; it does not scrape PDF literals or claim validation against a genuine MRA packet. Unsupported layouts require a server-provided structured Codex extraction with page and row evidence. A genuine complete itemized MRA fixture remains a separate acceptance prerequisite.

Project cost intake uses the same verified source object and deterministic line identity. It produces a duplicate-aware draft command for the existing project command service and never creates a second posted accounting record. Posting remains behind the accounting capability gate.

Ordinary company files use the company document service. The service requires per-request authorization, verifies immutable object bytes before metadata is written, reloads relationship grants inside each read or write transaction, validates every company/entity/property/project/contract link, and exposes authorized downloads only. Documents can be linked to an investor contract through a relational binding; callers never enter an unverified raw document identifier. Metadata updates and archive operations use revision checks, while source bytes and object version remain immutable.

This implementation uses synthetic data only. No real tenant account, owner packet, investor contract, or production object is included in source-controlled tests.
