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
  "company_projects",
  "company_project_scope_items",
  "company_project_budget_versions",
  "company_project_budget_lines",
  "company_project_tasks",
  "company_project_task_dependencies",
  "company_project_draft_costs",
  "company_project_posted_actuals",
] as const;

/** Grants are provisioned by the operator, never by ordinary app mutations. */
export const COMPANY_ACCESS_TABLES = ["company_access_grants"] as const;
