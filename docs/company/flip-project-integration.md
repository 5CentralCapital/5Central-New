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

## Release and population

1. Pass the repository checks and approving review on the current production base.
2. Complete a fresh production backup/restore rehearsal and the reviewed migration/grants workflow for the new ordered migrations. Startup must not migrate.
3. Deploy the reviewed revision and verify readiness, worker health and scoped command behavior.
4. Create missing legal entities, properties and planned associations through shared commands, then read them back.
5. Create each project, scope lines and the supported budget version. Keep proposed budgets unapproved.
6. Refresh QuickBooks, review exact account purposes, and link current source revisions once. Never import manual copies of the same posted actuals.
7. Audit the saved budget totals, source allocation balances, negative corrections, entity boundaries, project status and source coverage.

Native QuickBooks project CRUD uses Intuit's Projects GraphQL API and its separate project permission. An Accounting-only connection is not evidence that this permission exists. This change stores verified project identities; it does not grant OAuth scopes, upgrade the QuickBooks subscription, or pretend that Customer CRUD creates a native project.
