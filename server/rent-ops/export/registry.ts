import type { CollectionDefinition } from "./types";

// The unprojected WebUsers resource can return a password-shaped field for a
// subset of historical users. Ask RM for the complete observed non-credential
// profile/audit field set so credential material never crosses into the raw
// archive. The collector still scans every returned record and aborts if RM
// ignores this projection or adds any credential-shaped field.
export const SAFE_WEB_USER_FIELDS = [
  "WebUserID", "ConcurrencyID", "CreateDate", "CreateUserID", "EmailAddress",
  "FailedLogins", "FirstName", "IsShowEmailAddressInDirectory",
  "IsShowNameAddressInDirectory", "IsShowPhoneNumberInDirectory",
  "IsVerifiedEmail", "LastFailedLogin", "LastLockout", "LastLogout",
  "LastName", "LastSuccessfulLogin", "Name", "UpdateDate", "UpdateUserID",
  "UserName", "UserNameIsVerified",
] as const;

/**
 * Canonical RM v3 resources used by the read-only export. Account-wide
 * Properties and Units are intentionally unfiltered so historical rows cannot
 * disappear because a server-side Status filter changed. Tenant partitions
 * and their per-parent resources are explicit so current/future/former rows
 * are all covered and independently auditable.
 */
export const RM_EXPORT_COLLECTIONS: readonly CollectionDefinition[] = [
  { name: "properties", path: "/Properties", query: { embeds: "Addresses" }, idFields: ["PropertyID"], entityType: "property", outputKey: "properties", partitionBy: "Status", clientSideValidation: "active_historical_classification", required: true },
  { name: "units", path: "/Units", query: { embeds: "UnitType,MarketRent,Amenities" }, idFields: ["UnitID"], entityType: "unit", outputKey: "units", partitionBy: "Status", clientSideValidation: "active_historical_classification;UnitTypeID_and_MarketRent_preserved_when_returned", required: true },

  { name: "tenants.current", path: "/Tenants", query: { filters: "Status,eq,Current", embeds: "Contacts,PrimaryContact" }, idFields: ["TenantID"], entityType: "person", outputKey: "tenants", partitionBy: "Status", required: true },
  { name: "tenants.future", path: "/Tenants", query: { filters: "Status,eq,Future", embeds: "Contacts,PrimaryContact" }, idFields: ["TenantID"], entityType: "person", outputKey: "tenants", partitionBy: "Status", required: true },
  { name: "tenants.former", path: "/Tenants", query: { filters: "Status,eq,Past", embeds: "Contacts,PrimaryContact" }, idFields: ["TenantID"], entityType: "person", outputKey: "tenants", partitionBy: "Status", required: true },
  { name: "contacts", path: "/Contacts", idFields: ["ContactID"], entityType: "contact", outputKey: "contacts", required: true },
  { name: "contactPhoneNumbers", pathTemplate: "/Contacts/{sourceId}/PhoneNumbers", parentCollection: "contacts", parentIdField: "ContactID", idFields: ["PhoneNumberID", "PhoneID"], entityType: "phone", outputKey: "phoneNumbers", kind: "per_parent", required: true },
  { name: "webUsers", path: "/WebUsers", query: { fields: SAFE_WEB_USER_FIELDS.join(",") }, idFields: ["WebUserID"], entityType: "web_user", sourceIdNamespace: "web_user", outputKey: "webUsers", clientSideValidation: "explicit_noncredential_field_projection;collector_recursively_rejects_credential_fields", required: true },
  { name: "webUserAccounts", path: "/WebUserAccounts", idFields: ["WebUserAccountID", "WebUserID", "AccountID"], entityType: "web_user_account", sourceIdNamespace: "web_user_account", outputKey: "webUserAccounts", required: true },
  { name: "households", outputKey: "households", kind: "known_unavailable", unsupportedReason: "RM_has_no_household_collection; tenant/contact source links are preserved", required: false },

  { name: "leases", path: "/Leases", idFields: ["LeaseID"], entityType: "tenancy", outputKey: "leases", required: true },
  { name: "leaseTermDefinitions", path: "/LeaseTerms", idFields: ["LeaseTermID"], entityType: "lease_term_definition", outputKey: "leaseTermDefinitions", required: true },
  { name: "unitTypes", path: "/UnitTypes", idFields: ["UnitTypeID"], entityType: "unit_type", outputKey: "unitTypeRecords", required: true },
  { name: "chargeTypes", path: "/ChargeTypes", idFields: ["ChargeTypeID"], entityType: "charge_type", outputKey: "chargeTypeRecords", required: true },
  { name: "securityDepositTypes", path: "/SecurityDepositTypes", idFields: ["SecurityDepositTypeID"], entityType: "security_deposit_type", outputKey: "securityDepositTypeRecords", required: true },
  { name: "leaseRenewals", path: "/LeaseRenewals", idFields: ["LeaseRenewalID"], entityType: "lease_term", outputKey: "leaseRenewals", clientSideValidation: "PropertyID_filter_unreliable;raw_paginated_rows_client_joined_to_ParentLeaseID", required: true },
  { name: "recurringSchedules", path: "/RecurringCharges", idFields: ["RecurringChargeID"], entityType: "recurring_schedule", outputKey: "recurringSchedules", clientSideValidation: "EntityKeyID_tenant_join", required: true },

  { name: "charges", path: "/Charges", idFields: ["ChargeID"], entityType: "ledger_transaction", sourceIdNamespace: "charge", outputKey: "charges", required: true },
  { name: "payments", path: "/Payments", query: { embeds: "Allocations" }, idFields: ["PaymentID"], entityType: "ledger_transaction", sourceIdNamespace: "payment", embeddedField: "Allocations", embeddedOutputKey: "allocations", embeddedEntityType: "payment_allocation", outputKey: "payments", required: true },
  { name: "credits", path: "/Credits", idFields: ["CreditID"], entityType: "ledger_transaction", sourceIdNamespace: "credit", outputKey: "credits", required: true },
  { name: "allocations", outputKey: "allocations", kind: "known_unavailable", unsupportedReason: "RM_embeds_Allocations_in_Payments; collector_extracts_and_hashes_each_embedded_row", required: false },

  { name: "tenantSecurityDeposits.current", pathTemplate: "/Tenants/{sourceId}/SecurityDepositSummaries", parentCollection: "tenants.current", parentIdField: "TenantID", idFields: ["SecurityDepositSummaryID", "DepositID"], entityType: "deposit", outputKey: "deposits", kind: "per_parent", required: true },
  { name: "tenantSecurityDeposits.future", pathTemplate: "/Tenants/{sourceId}/SecurityDepositSummaries", parentCollection: "tenants.future", parentIdField: "TenantID", idFields: ["SecurityDepositSummaryID", "DepositID"], entityType: "deposit", outputKey: "deposits", kind: "per_parent", required: true },
  { name: "tenantSecurityDeposits.former", pathTemplate: "/Tenants/{sourceId}/SecurityDepositSummaries", parentCollection: "tenants.former", parentIdField: "TenantID", idFields: ["SecurityDepositSummaryID", "DepositID"], entityType: "deposit", outputKey: "deposits", kind: "per_parent", required: true },

  { name: "subsidies", path: "/Subsidies", idFields: ["SubsidyID"], entityType: "subsidy", outputKey: "subsidies", clientSideValidation: "pull_all_then_join_tenant_property_unit;agency_and_tenant_obligations_required", required: true },
  { name: "subsidyTenants", path: "/SubsidyTenants", idFields: ["SubsidyTenantID", "TenantID"], entityType: "subsidy_tenant", sourceIdNamespace: "subsidy_tenant", outputKey: "subsidyTenants", clientSideValidation: "pull_all_then_join_by_exact_source_keys;retain_orphan_and_unknown_links", required: true },
  { name: "subsidyPayments", path: "/SubsidyPayments", idFields: ["SubsidyPaymentID", "PaymentID"], entityType: "subsidy_payment", sourceIdNamespace: "subsidy_payment", outputKey: "subsidyPayments", clientSideValidation: "pull_all_then_join_by_exact_source_keys;PaymentID_only_direct_ledger_link", required: true },

  { name: "prospects", path: "/Prospects", query: { embeds: "Contacts,InterestedUnits" }, idFields: ["ProspectID"], entityType: "prospect", outputKey: "prospects", required: true },
  { name: "prospectApplications", path: "/ProspectApplications", idFields: ["ProspectApplicationID", "ApplicationID"], entityType: "application", sourceIdNamespace: "prospect_application", outputKey: "applications", required: true },
  { name: "prospectApplicationTemplates", path: "/ProspectApplicationTemplates", idFields: ["ProspectApplicationTemplateID", "ApplicationTemplateID"], entityType: "application", sourceIdNamespace: "prospect_application_template", outputKey: "applicationTemplates", required: true },
  { name: "prospectApplicationTemplateFields", path: "/ProspectApplicationTemplateFields", idFields: ["ProspectApplicationTemplateFieldID", "ApplicationFieldID", "ApplicationTemplateFieldID", "FieldID"], entityType: "application", sourceIdNamespace: "prospect_application_field", outputKey: "applicationTemplates", required: true },
  { name: "prospectApplicationTemplateMajorSections", path: "/ProspectApplicationTemplateMajorSections", idFields: ["ApplicationMajorSectionID", "ProspectApplicationTemplateMajorSectionID", "ApplicationTemplateMajorSectionID", "MajorSectionID", "ID"], entityType: "application_template_major_section", sourceIdNamespace: "prospect_application_major_section", outputKey: "applicationTemplates", required: true },
  { name: "prospectApplicationTemplateMinorSections", path: "/ProspectApplicationTemplateMinorSections", idFields: ["ApplicationMinorSectionID", "ProspectApplicationTemplateMinorSectionID", "ApplicationTemplateMinorSectionID", "MinorSectionID", "ID"], entityType: "application_template_minor_section", sourceIdNamespace: "prospect_application_minor_section", outputKey: "applicationTemplates", required: true },
  { name: "applicationTemplates", path: "/ApplicationTemplates", idFields: ["ApplicationTemplateID", "TemplateID"], entityType: "application", sourceIdNamespace: "application_template", outputKey: "applicationTemplates", required: true },
  { name: "interestedRentals", path: "/InterestedRentals", idFields: ["InterestedRentalID", "InterestedRentID", "ID"], entityType: "interested_rental", sourceIdNamespace: "interested_rental", outputKey: "interestedRentals", clientSideValidation: "preserve_raw_link_rows;join_only_when_explicit_application_or_prospect_key_is_returned", required: true },
  { name: "applicationSettings", path: "/ApplicationSettings", idFields: ["ApplicationSettingsID", "ApplicationSettingID", "SettingID", "ID"], entityType: "application_setting", sourceIdNamespace: "application_setting", outputKey: "applicationSettings", required: true },
  { name: "prospectSubApplicantDetails", path: "/ProspectSubApplicantDetails", idFields: ["ProspectSubApplicantDetailID", "SubApplicantDetailID"], entityType: "application", sourceIdNamespace: "prospect_sub_applicant", outputKey: "applications", clientSideValidation: "verified_empty_snapshot;page_every_run", required: false },
  { name: "applicationSummaries", path: "/ApplicationSummaries", idFields: ["ApplicationSummaryID", "ApplicationID"], entityType: "application", sourceIdNamespace: "application_summary", outputKey: "applications", clientSideValidation: "verified_empty_snapshot;page_every_run", required: false },

  { name: "tenantHistory.current", pathTemplate: "/Tenants/{sourceId}/History", parentCollection: "tenants.current", parentIdField: "TenantID", idFields: ["HistoryID", "HistoryNoteID", "HistoryEmailID"], entityType: "activity", sourceIdNamespace: "history", outputKey: "histories", kind: "per_parent", required: true },
  { name: "tenantHistory.future", pathTemplate: "/Tenants/{sourceId}/History", parentCollection: "tenants.future", parentIdField: "TenantID", idFields: ["HistoryID", "HistoryNoteID", "HistoryEmailID"], entityType: "activity", sourceIdNamespace: "history", outputKey: "histories", kind: "per_parent", required: true },
  { name: "tenantHistory.former", pathTemplate: "/Tenants/{sourceId}/History", parentCollection: "tenants.former", parentIdField: "TenantID", idFields: ["HistoryID", "HistoryNoteID", "HistoryEmailID"], entityType: "activity", sourceIdNamespace: "history", outputKey: "histories", kind: "per_parent", required: true },
  { name: "historyNotes", path: "/HistoryNotes", idFields: ["HistoryNoteID", "HistoryID"], entityType: "activity", sourceIdNamespace: "history_note", outputKey: "notes", required: true },
  { name: "historyEmails", path: "/HistoryEmails", idFields: ["HistoryEmailID", "HistoryID"], entityType: "activity", sourceIdNamespace: "history_email", outputKey: "activities", required: true },
  { name: "emailSentItems", path: "/EmailSentItems", idFields: ["EmailSentItemID", "EmailID"], entityType: "activity", sourceIdNamespace: "email_sent_item", outputKey: "communications", required: true },
  { name: "emailChains", path: "/EmailChains", idFields: ["EmailChainID"], entityType: "activity", sourceIdNamespace: "email_chain", outputKey: "communications", required: true },
  { name: "textMessagingConversations", path: "/TextMessagingConversations", idFields: ["TextMessagingConversationID", "ConversationID"], entityType: "activity", sourceIdNamespace: "text_conversation", outputKey: "communications", required: true },
  { name: "outgoingTexts", path: "/OutgoingTexts", idFields: ["OutgoingTextID", "TextID"], entityType: "activity", sourceIdNamespace: "outgoing_text", outputKey: "communications", required: true },
  { name: "incomingTexts", path: "/IncomingTexts", idFields: ["IncomingTextID", "TextID"], entityType: "activity", sourceIdNamespace: "incoming_text", outputKey: "communications", required: true },

  { name: "documentPackets", path: "/DocumentPackets", idFields: ["DocumentPacketID", "DocumentID"], entityType: "document", sourceIdNamespace: "document_packet", outputKey: "documents", documentMode: "metadata", required: true },
  { name: "signableDocumentPackets", path: "/SignableDocumentPackets", idFields: ["SignableDocumentPacketID", "DocumentPacketID"], entityType: "document", sourceIdNamespace: "signable_document_packet", outputKey: "documents", documentMode: "metadata", required: true },
  { name: "signableDocuments", path: "/SignableDocuments", idFields: ["SignableDocumentID", "DocumentID"], entityType: "document", sourceIdNamespace: "signable_document", outputKey: "documentBinaryDescriptors", documentMode: "binary_descriptor", required: true },
  { name: "userDefinedFields", path: "/UserDefinedFields", idFields: ["UserDefinedFieldID", "ID"], entityType: "lookup", outputKey: "lookups", required: true },

  { name: "paymentTypes", outputKey: "paymentTypes", kind: "known_unavailable", unsupportedReason: "RM_build_does_not_expose_PaymentTypes_collection", required: false },
  { name: "creditTypes", outputKey: "creditTypes", kind: "known_unavailable", unsupportedReason: "RM_build_does_not_expose_CreditTypes_collection", required: false },
  { name: "tenantContacts", outputKey: "contacts", kind: "known_unavailable", unsupportedReason: "global_TenantContacts_returns_404;_Contacts_and_per_contact_PhoneNumbers_are_the_supported_path", required: false },
  { name: "fileAttachments", outputKey: "documents", kind: "known_unavailable", unsupportedReason: "global_FileAttachments_returns_404;metadata_and_signable_descriptors_are_preserved_without_fabricating_binary", required: false },
];

export const RM_COLLECTION_REGISTRY = RM_EXPORT_COLLECTIONS;
export const collectionRegistry = RM_EXPORT_COLLECTIONS;
