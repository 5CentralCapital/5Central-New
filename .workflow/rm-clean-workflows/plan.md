# RM workflow implementation

Implement the approved property-grouped rent roll, vacancy and all-account balance views, consistent tenant and recurring-charge navigation, contextual tenant charge forms, shared manager/resident transaction history and RM history coverage verification.

Design: simple, clean Apple-quality interaction and typography using 5Central charcoal, cream and sparse gold. No decorative subtitles, helper paragraphs, developer language or unnecessary cards. Preserve material financial uncertainty next to the affected value.

Base: 8332707, isolated from concurrent reconciliation edits. Preserve existing MVP, current-rent repairs, append-only posted history, integer cents, explicit allocations, tenant portal isolation and classic fallback. No real test charges, payments, outbound communication or destructive data changes.

Orchestration: Astra Max; workers Astra Medium. Disjoint ownership: reports UI; navigation and workspace shell; tenant forms and profile; shared transactions domain; resident transactions UI; history coverage/import audit. Root owns shared contract integration, domain report integration, design review and release QA. Workers report targeted tests and no worker deploys.

Integrate contracts first, then parallel UI and read models. Validate former/current/future account identity, no monetary double counting, missing-data preservation, archive replay identity, manager/resident statement parity, authorization, filtering/export parity, UI navigation and new charge context. Run typecheck, affected tests, build and browser checks. Refresh deployment branch before release to preserve concurrent commits. Verify actual deployed build before reporting live.
