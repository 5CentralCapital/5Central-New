/** Company tables share the existing ordered migration and role registry. */
export const COMPANY_APPLICATION_TABLES = [
  "company_organizations",
  "company_legal_entities",
  "company_contacts",
  "company_contact_roles",
  "company_property_entity_periods",
  "company_external_identities",
  "company_command_receipts",
  "company_outbox",
] as const;

/** Grants are provisioned by the operator, never by ordinary app mutations. */
export const COMPANY_ACCESS_TABLES = ["company_access_grants"] as const;
