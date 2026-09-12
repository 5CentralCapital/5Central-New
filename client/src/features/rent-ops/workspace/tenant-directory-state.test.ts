import assert from 'node:assert/strict';
import test from 'node:test';
import { syntheticRentOpsSnapshot } from '../../../../../server/rent-ops/fixtures/synthetic';
import { serializeWorkspaceBootstrap } from '../../../../../server/rent-ops/presentation/workspace-read';
import { decodeRentOpsWorkspaceBootstrap } from '../api';
import type { ViewFilters } from '../types';
import { DEFAULT_TENANT_DIRECTORY_STATUS, tenantDirectoryFilters } from './tenant-directory-state';
import { filterTenantDirectory, parseWorkspaceRoute, workspaceRecordInScope, workspaceFiltersForRecord } from './workspace-state';
const filters: ViewFilters = { propertyScope:'all',propertyId:'all',asOfDate:'2026-09-12',status:'all',search:'' };
function fixture() {
  const data=decodeRentOpsWorkspaceBootstrap(serializeWorkspaceBootstrap(syntheticRentOpsSnapshot(),{asOfDate:filters.asOfDate}));
  const categories=['current','former','future','unknown'] as const;
  data.tenantIndex.forEach((row,index)=>row.category=categories[index%categories.length]);
  return data;
}
test('tenant list defaults to current and excludes former future and uncertain names',()=>{
  const data=fixture();
  assert.equal(DEFAULT_TENANT_DIRECTORY_STATUS,'current');
  const current=filterTenantDirectory(data,tenantDirectoryFilters(filters));
  assert.ok(current.length>0);
  assert.deepEqual(new Set(current.map(row=>data.tenantIndex.find(entry=>entry.person.id===row.person.id)!.category)),new Set(['current']));
  assert.equal(filters.status,'all','other sections retain their own global status');
});
test('explicit All Former and Future choices survive report status resets',()=>{
  const data=fixture();
  for(const selected of ['all','former','future']) {
    const expected=filterTenantDirectory(data,{...filters,status:selected}).map(row=>row.person.id);
    for(const globalStatus of ['all','current','vacant']) {
      assert.deepEqual(filterTenantDirectory(data,tenantDirectoryFilters({...filters,status:globalStatus},selected)).map(row=>row.person.id),expected);
    }
  }
});
test('direct historical record remains accessible with Current directory selected',()=>{
  const data=fixture();
  const former=data.tenantIndex.find(row=>row.category==='former')!;
  assert.ok(former);
  const selected=tenantDirectoryFilters(filters);
  assert.ok(!filterTenantDirectory(data,selected).some(row=>row.person.id===former.person.id));
  const route=parseWorkspaceRoute(`?section=tenants&record=${encodeURIComponent(former.person.id)}&tab=ledger`);
  assert.equal(workspaceRecordInScope(route,data,selected),true);
  assert.equal(workspaceFiltersForRecord(route,data,selected).status,'current');
  assert.equal(route.recordId,former.person.id);
  assert.equal(route.tab,'ledger');
});
