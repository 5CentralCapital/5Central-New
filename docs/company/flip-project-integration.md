# Flip project integration

QuickBooks remains the accounting authority. R-ops holds project scope, lender budget versions, operational progress, and links to exact posted source lines. A linked inventory journal is still a capitalized asset; it is not converted to an expense merely to populate a QuickBooks project profit panel.

| Information | System and handling |
| --- | --- |
| Legal entity and acquired property | R-ops scoped entity/property setup; legal mapping uses the verified effective date |
| Property under contract | Separate planned association; no legal accounting period or financial execution until explicit conversion |
| Native QuickBooks project | Distinct native Project ID and associated Customer ID, linked to a verified company realm |
| Lender rehab budget | Approved R-ops scope/budget version; retain the lender baseline when an owner forecast changes |
| Acquisition, reserves, deposits, intercompany funding | Preserve their QuickBooks classifications and distinguish them from rehab costs |
| Posted costs and corrections | Exact QBO object, line, revision, legal entity and available allocation; credits reduce actuals |
| Bank settlement | Separate evidence; a posted journal does not establish settlement |
| Tasks, commitments, draws and inspections | Existing R-ops execution commands, with legal-scope and source-eligibility checks |

## Cost boundaries

The general accounting mirror now includes JournalEntry. Its debit and credit lines preserve their signs and source identity; the receivables mirror continues independently to classify A/R effects. Journal credits can be linked as cost reductions, but cannot fund draw requests. The project picker explicitly opts into credit lines and fences every search to a linked, verified QuickBooks environment and realm; payroll and work-order defaults remain unchanged. Eligible Purchase refunds keep coverage partial only while an unallocated balance remains. Incomplete amounts display as known subtotals, since missing refunds can lower a positive balance.

An asset account does not qualify as a project cost merely because it is named inventory or relates to a project. A scoped review of the exact provider Account revision must establish a capitalized-cost purpose from evidence. Deposits, lender reserves and intercompany receivables must not be reviewed as costs merely because they relate to a flip.

A lender rehab variance must include only the matching rehab scope. Acquisition and carrying costs belong in separate all-in reporting. Unknown allocation, outstanding refundable deposits and untraced canceled payments remain visible uncertainties rather than invented scope allocations or duplicate manual costs.

## Whole-deal view

The Deal costs tab adds acquisition, rehab, financing, holding, selling and needs-allocation categories. Each keeps budget, incurred amount, remaining forecast and settlement evidence separate. A prepaid row represents an asset balance, excluded from incurred costs; recognized expenses are separate source lines. The approved lender rehab budget and remaining cost forecast flow from the existing scope and cost-report workflows once, including an explicit zero remaining-cost override at completion. Those derived rows are read-only in the deal view.

Funding has separate groups for deposits, loan principal, reserves, contributions, intercompany movements, sale proceeds and settlement clearing. Linked funding must resolve to a supported non-cost account classification; expense and capitalized-cost lines cannot be relabeled as funding. These groups are not added to project costs or presented as available cash. An applied deposit and its closing application must not be entered as two costs.

Sale price and remaining selling costs are forecasts. Projected profit is withheld while cost coverage or allocation remains incomplete. A zero estimate is an explicit assumption, while a blank remains unknown. Original payments and subsequent noncash reclassifications must be traced before population; a unique journal line alone does not prove a unique economic cost.

Existing actuals assigned to active rehab scope appear under rehab; unassigned actuals remain in needs allocation. The shared read and command surfaces expose the same scoped ledger to the browser and MCP. Saving an operational record does not post a QuickBooks journal. Production population must preserve current source revisions, evidence references and the owning legal entity. A parent-company advance may support the property's operational reconciliation without becoming an expense in the parent's books.

## Release and population

1. Pass the repository checks and approving review on the current production base.
2. Complete a fresh production backup/restore rehearsal and the reviewed migration/grants workflow for the new ordered migrations. Startup must not migrate.
3. Deploy the reviewed revision and verify readiness, worker health and scoped command behavior.
4. Create missing legal entities, properties and planned associations through shared commands, then read them back.
5. Create each project, scope lines and the supported budget version. Keep proposed budgets unapproved.
6. Refresh QuickBooks, review exact account purposes, and link current source revisions once. Never import manual copies of the same posted actuals.
7. Audit the saved budget totals, source allocation balances, negative corrections, entity boundaries, project status and source coverage.

Native QuickBooks project CRUD uses Intuit's Projects GraphQL API and its separate project permission. An Accounting-only connection is not evidence that this permission exists. This change stores verified project identities; it does not grant OAuth scopes, upgrade the QuickBooks subscription, or pretend that Customer CRUD creates a native project.
