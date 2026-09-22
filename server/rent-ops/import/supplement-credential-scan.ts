import { assertNoCredentialShapedFields } from "../export/collector";

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
/** Apply the existing depth/node limit to every source record, as the collector
 * does, without making archive size itself look like a credential field. */
export function scanSupplementCredentialBoundary(value: Record<string, unknown>): void {
  const skeleton = { ...value };
  for (const key of ["applicationAnswers", "hapSubsidies", "documentBinaries", "applicationHistoryStatusCrosswalk"]) {
    const rows = value[key];
    if (Array.isArray(rows)) { for (const row of rows) assertNoCredentialShapedFields(row); skeleton[key] = []; }
  }
  if (record(value.envelope) && record(value.envelope.payload)) {
    const payload = { ...value.envelope.payload };
    for (const [key, rows] of Object.entries(payload)) {
      if (Array.isArray(rows)) { for (const row of rows) assertNoCredentialShapedFields(row); payload[key] = []; }
    }
    skeleton.envelope = { ...value.envelope, payload };
  }
  // This also checks all collection/property names and all non-row metadata.
  assertNoCredentialShapedFields(skeleton);
}
