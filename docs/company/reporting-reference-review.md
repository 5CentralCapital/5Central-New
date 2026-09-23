# Reporting reference review

**Date:** September 21, 2026
**Source:** read-only review of the live Buildium reporting interface
**Purpose:** record useful reporting patterns for 5Central Ops without treating the reference product as a requirements boundary.

This review captures interface patterns that may improve 5Central Ops reporting. It does not authorize a Buildium connection, copy Buildium’s visual language, or expand the current report delivery into an exhaustive feature commitment. 5Central Ops keeps its charcoal, gold and cream interface, report-specific setup, shared filter contract, and company authorization model. The owner portal was a limited reference; it is neither a requirement to reproduce every option nor a ceiling on future product scope.

## Observed reference patterns

The report library groups reports, supports categories and favorites, and exposes custom and batch report paths. A rent-roll setup offered property, unit, as-of date, lease status/type, and balance choices for due, zero and credit. Under Add filters, optional filters included account, bed, bath, rent amount, and tenant name. The available extra columns included eviction, lease number, lease type, market rent, next rent amount and date, previous rent, and square footage. A column customization path allowed columns to be chosen and ordered; negative-number format and color were also available.

The saved-report flow asked for a title and description and exposed edit permissions. The flow was inspected and cancelled before saving, so saved-report persistence, sharing, and permission behavior were not verified.

An income statement setup exposed properties, accounts, date presets (year to date, current/last month, quarter, year, rolling 30/365 days, and custom), interval choices (month, quarter, year, or none), and cash/accrual basis. A balance sheet exposed properties, company, as-of date, and cash/accrual basis. A general-ledger setup exposed property, company, unit, date range, and cash/accrual basis, with optional account, debit/credit/amount, fund type, and type fields. The default general-ledger run returned no results, so its drilldown behavior was not verified.

The export menu offered PDF, XLSX, and CSV. No download was generated during the review, so file contents, applied-filter parity, and export permissions were not verified.

A work-order setup exposed property, status, assignee, category, vendor, vendor status, and created-date filters. Optional filters included bill status, project, due date, and priority. A batch wizard presented entities, reports, filters, optional attachments, review, and export. The wizard was cancelled at its first step, so batch generation and export behavior were not verified.

The review did not test downloads, report drilldowns, saved-report permissions, or batch generation. Those observations should remain separate from verified 5Central Ops behavior and live report rows.

## 5Central Ops adaptations worth carrying forward

1. Keep essential controls visible first and place additional filters behind progressive disclosure. The shared report definition remains the source for visible controls and wire values.
2. Add named saved presets when that workflow is implemented. A preset should preserve report key, definition version, canonical scope, filters, columns, sort, and date values; descriptions should remain optional.
3. Support date presets only when they resolve to explicit dates before the request is sent. The API and Codex surfaces should receive the resolved range or as-of date, basis, scope, and all report filters.
4. Carry column selection and ordering into report preferences or named presets, preserving the existing report table and sort behavior.
5. Keep export and print on the exact applied run scope, date, filter set, column selection, and sort. A later export job must retain the same authorization checks and source snapshot.
6. Plan reusable owner and investor reporting packages as read-only generation workflows with explicit access boundaries. They are later work, not a change to the current rental report surface.

## Current 5Central Ops boundary

The current delivery supports the 11 available rental report engines through the report library, report-specific setup, shared filter metadata, the authenticated HTTP surface, and Codex/MCP discovery and execution mappings. Report setup runs only after an explicit Run report action. Planned financial, task, owner, investor, forecast, and batch entries remain disabled until their engines, filters, permissions, and parity checks exist.

The Buildium reference does not change 5Central Ops accounting authority. QBO remains the authority for posted company books, while 5Central Ops remains the authority for operational rental context and approved report joins. Future financial reports must declare entity, basis, currency, period, source watermark, completeness, and allocation behavior rather than infer them from a reference interface.

## Related canonical documents

- [Reporting contract](reporting-contract.md)
- [Report filter matrix](report-filter-matrix.md)
- `AI/Research/2026-09-20-r-ops-plan/5Central Ops Reporting Reference Review.md` (canonical-plan copy)
