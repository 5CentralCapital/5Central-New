# Integration contracts

Root owns workspace/rm-workspace.tsx, workspace/workspace-api.ts, workspace/use-workspace-data.ts, client/src/pages/rent-ops.tsx, client/src/App.tsx and types.ts. Original rent-ops-workspace.tsx remains classic fallback; editor agent may only extract editor-related code to owned new files and request root exports, never rewrite original.

All new files under client/src/features/rent-ops/workspace/. Every component uses existing ../types and ../form-payload browser types; never import server/domain persistence types. Money integer cents, dates untouched, no false zeros for unknown values. Preserve revision fields in mutations.

Shared UI CSS classes: rm-workspace root, rm-ribbon, rm-nav-group, rm-open-tabs, rm-open-tab, rm-body, rm-sidebar, rm-main, rm-record-layout, rm-record-list, rm-record-summary, rm-tabs, rm-toolbar, rm-panel, rm-panel-title, rm-form-grid, rm-field, rm-table-wrap, rm-table, rm-empty, rm-status, rm-warning, rm-error, rm-button, rm-button-primary, rm-button-danger, rm-muted, rm-pagination, rm-amount, rm-dashboard-grid, rm-stat, rm-dialog-backdrop, rm-dialog, rm-dialog-footer. Component-specific CSS allowed in owned file and imported there.

Common callback EditAction = (action: QuickAction, values?: FormValues)=>void. Root opens central editor and refreshes affected data. Data props use existing AdminSnapshot/TenantView/ReportDefinition etc. No component mutates providers directly except reuse existing approved UI widgets in response to user actions.

Tenant component export TenantRecord({tenant:TenantView, snapshot:AdminSnapshot, tab:TenantTab, onTab:(tab:TenantTab)=>void, onEdit:EditAction, onChanged:()=>void}). Root owns tenant selection and fetching. Tenant agent owns all record tabs and may reuse TenantPortalAccountsPanel, PhoneMethodsEditor, ManagerLeaseUpload.

Property component export PropertyUnitRecords({snapshot:AdminSnapshot, filters:ViewFilters, selectedPropertyId?:string, selectedUnitId?:string, onSelect:(kind:'property'|'unit',id:string)=>void, onEdit:EditAction}). Root owns URL/open records. Display one property or one unit record with tabs and searchable list. Default selection is first matched property. No shared editor changes.

Reports export ReportsWorkspace({snapshot:AdminSnapshot, filters:ViewFilters, selected:ReportKey, onSelect:(key:ReportKey)=>void, onOpenTenant?:(personId:string)=>void, onOpenUnit?:(unitId:string)=>void}) and DashboardWorkspace({snapshot,filters,onReport:(report:ReportKey)=>void,onOpenTenant?,onOpenUnit?}). Reports must lazy-load actual selected report through loadRentOpsReport API, never accept empty bootstrap report as factual absence.

Leasing export ApplicationsWorkspace({snapshot:AdminSnapshot,filters:ViewFilters,onChanged:()=>void,onEdit:EditAction}) and DocumentsWorkspace({snapshot,filters,onEdit,onChanged}). Ensure paged compact tables, current explicit manual status changes, no auto sends or decisions. Root supplies loaded apps/docs context on entry.

Grid export generic DataGrid<T extends Record<string, unknown>> props {rows:T[],columns:GridColumn<T>[],getRowKey?:(row:T,index:number)=>string,onRow?:(row:T)=>void,emptyMessage?:string,pageSize?:number,search?:string,caption?:string,initialSort?:{key:string,direction:'asc'|'desc'},storageKey?:string}. GridColumn {key:string,label:string,render?:(row:T)=>ReactNode,sortValue?:(row:T)=>string|number|null|undefined,align?:'left'|'right',width?:number|string,hidden?:boolean}. Export formatMoney/formatDate/formatLabel helpers from workspace/display.ts, unknown currency => 'Needs review'. Grid agent owns grid.tsx/grid-model.ts/grid.test.ts/display.ts only.

Editor export WorkspaceEditor({action:QuickAction,snapshot:AdminSnapshot,initialValues?:FormValues,onClose:()=>void,onSaved:(message:string)=>void,onConflict?:()=>void}). Preserve all existing actions/endpoints validation and revision guards; scoped human selectors; better grouping, accessible focus, unsaved guard. Own workspace/editor.tsx/editor-model.ts/editor.test.ts/editor.css only.

New API bootstrap must not affect original /snapshot. Backend agent agrees narrow endpoint shapes with root before final. Root handles browser decoding/auth adapter. Backend excludes large legacy history unless specifically requested; all money calculations still use complete appropriate financial inputs, not page slices.
