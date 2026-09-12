import assert from 'node:assert/strict';
import test from 'node:test';
import { syntheticRentOpsSnapshot } from '../../../../../server/rent-ops/fixtures/synthetic';
import { serializeWorkspaceBootstrap } from '../../../../../server/rent-ops/presentation/workspace-read';
import { decodeRentOpsWorkspaceBootstrap } from '../api';
import type { ViewFilters } from '../types';
import { composeWorkspaceSnapshot, filterTenantDirectory, indexTenantViews, parseWorkspaceRoute, workspaceApiFilters, workspaceRouteSearch, workspaceRecordInScope, workspaceFiltersForRecord } from './workspace-state';

const filters: ViewFilters = {propertyScope:'all',propertyId:'all',asOfDate:'2026-08-15',status:'all',search:''};
function bootstrap() { return decodeRentOpsWorkspaceBootstrap(serializeWorkspaceBootstrap(syntheticRentOpsSnapshot(),{asOfDate:filters.asOfDate})); }

test('workspace links round-trip scoped records and tenant detail tabs without losing opaque IDs',()=>{
  const tenant=parseWorkspaceRoute('?section=tenants&record=person%3Aimport_123&tab=ledger');
  assert.equal(tenant.recordId,'person:import_123');
  assert.deepEqual(parseWorkspaceRoute(workspaceRouteSearch(tenant)),tenant);
  const unit=parseWorkspaceRoute('?section=properties&kind=unit&record=unit-12');
  assert.deepEqual(parseWorkspaceRoute(workspaceRouteSearch(unit)),unit);
  const report=parseWorkspaceRoute('?section=reports&report=scheduled-vs-collected');
  assert.deepEqual(parseWorkspaceRoute(workspaceRouteSearch(report)),report);
});

test('untrusted route values fall back safely and reject path-like or overlong record identities',()=>{
  for(const record of ['../tenant','<script>', 'x'.repeat(161)]) {
    const parsed=parseWorkspaceRoute(`?section=__proto__&tab=bad&report=bad&record=${encodeURIComponent(record)}`);
    assert.equal(parsed.section,'dashboard'); assert.equal(parsed.tab,'summary'); assert.equal(parsed.report,'rent-roll'); assert.equal(parsed.recordId,undefined);
  }
});

test('API scope preserves property and business date while excluding display search and status',()=>{
  assert.deepEqual(workspaceApiFilters({...filters,propertyScope:'active',propertyId:'property:12',search:'Smith',status:'former'}),{propertyScope:'active',propertyId:'property:12',asOfDate:filters.asOfDate});
  assert.equal(Object.hasOwn(workspaceApiFilters(filters),'propertyId'),false);
});

test('bootstrap navigation never substitutes a tenancy when the selected identity is missing',()=>{
  const source=bootstrap();
  source.tenantIndex[0].selectedTenancyId='missing-tenancy';
  const view=indexTenantViews(source)[0];
  assert.equal(view.tenancy,undefined); assert.equal(view.property,undefined); assert.equal(view.unit,undefined);
  assert.ok(view.tenancies!.length>0);
});

test('unloaded financial summary stays unavailable rather than becoming zero',()=>{
  const view=composeWorkspaceSnapshot(bootstrap(),filters.asOfDate);
  assert.equal(view.summary.balanceComplete,false); assert.equal(view.summary.scheduledRentComplete,false);
  assert.equal(view.summary.rentOnlyDelinquencyCents,null); assert.equal(view.summary.securityDepositLiabilityCents,null);
  assert.ok(Number.isNaN(view.summary.collectedRentCents)); assert.ok(Number.isNaN(view.summary.physicalOccupancyPercent));
});

test('property-scoped directory preserves linked account-only contacts without inventing a tenancy',()=>{
  const source=structuredClone(syntheticRentOpsSnapshot());
  source.people.push({id:'account-a',firstName:'Account',lastName:'A'},{id:'account-b',firstName:'Account',lastName:'B'});
  source.householdMemberships.push(
    {id:'account-link-a',personId:source.people[0].id,accountPersonId:'account-a',tenancyId:source.tenancies[0].id},
    {id:'account-link-b',personId:source.people[2].id,accountPersonId:'account-b',tenancyId:source.tenancies[2].id},
  );
  const scoped={...filters,propertyId:source.properties[0].id};
  const data=decodeRentOpsWorkspaceBootstrap(serializeWorkspaceBootstrap(source,workspaceApiFilters(scoped)));
  assert.ok(data.tenantIndex.some(row=>row.person.id==='account-a'));
  assert.ok(!data.tenantIndex.some(row=>row.person.id==='account-b'));
  const result=filterTenantDirectory(data,scoped);
  const contact=result.find(row=>row.person.id==='account-a');
  assert.ok(contact,'server-scoped related account contact must remain visible');
  assert.equal(contact.tenancy,undefined); assert.deepEqual(contact.tenancies,[]);
  assert.ok(!result.some(row=>row.person.id==='account-b'));
});

test('directory search combines full names and preserves unknown categories under explicit filters',()=>{
  const data=bootstrap();
  data.tenantIndex[0].category=undefined;
  const person=data.tenantIndex[0].person;
  const found=filterTenantDirectory(data,{...filters,status:'unknown',search:` ${person.firstName} ${person.lastName} `});
  assert.deepEqual(found.map(row=>row.person.id),[person.id]);
  assert.ok(!filterTenantDirectory(data,{...filters,status:'current'}).some(row=>row.person.id===person.id));
});

test('record scope uses scoped tenant identities including contacts independent of display filters',()=>{
  const source=structuredClone(syntheticRentOpsSnapshot());
  source.people.push({id:'scope-contact-a',firstName:'Account',lastName:'Contact'});
  source.householdMemberships.push({id:'scope-contact-link',personId:source.people[0].id,accountPersonId:'scope-contact-a',tenancyId:source.tenancies[0].id});
  const scopeA={...filters,propertyId:source.properties[0].id,status:'former',search:'no matching name'};
  const scopeB={...scopeA,propertyId:source.properties[1].id};
  const dataA=decodeRentOpsWorkspaceBootstrap(serializeWorkspaceBootstrap(source,workspaceApiFilters(scopeA)));
  const dataB=decodeRentOpsWorkspaceBootstrap(serializeWorkspaceBootstrap(source,workspaceApiFilters(scopeB)));
  const contact=parseWorkspaceRoute('?section=tenants&record=scope-contact-a&tab=ledger');
  assert.equal(workspaceRecordInScope(contact,dataA,scopeA),true);
  assert.equal(workspaceRecordInScope(contact,dataB,scopeB),false);
  const aOnly=dataA.tenantIndex.find(entry=>!dataB.tenantIndex.some(other=>other.person.id===entry.person.id))!;
  const tenant=parseWorkspaceRoute(`?section=tenants&record=${aOnly.person.id}`);
  assert.equal(workspaceRecordInScope(tenant,dataA,scopeA),true);
  assert.equal(workspaceRecordInScope(tenant,dataB,scopeB),false);
  assert.equal(workspaceFiltersForRecord(contact,dataA,scopeA),scopeA);
  assert.deepEqual(workspaceFiltersForRecord(contact,dataB,scopeB),{...scopeB,propertyId:'all',propertyScope:'all'});
});

test('property and unit membership requires an existing property matching selected scope',()=>{
  const data=bootstrap();
  const first=data.snapshot.properties[0];
  const second=data.snapshot.properties[1];
  first.state='active'; second.state='inactive';
  data.snapshot.units.push({id:'scope-unit-active',propertyId:first.id},{id:'scope-unit-inactive',propertyId:second.id},{id:'scope-unit-orphan',propertyId:'missing-property'});
  const active={...filters,propertyScope:'active' as const};
  const property=(id:string)=>parseWorkspaceRoute(`?section=properties&kind=property&record=${id}`);
  const unit=(id:string)=>parseWorkspaceRoute(`?section=properties&kind=unit&record=${id}`);
  assert.equal(workspaceRecordInScope(property(first.id!),data,active),true);
  assert.equal(workspaceRecordInScope(property(second.id!),data,active),false);
  assert.equal(workspaceRecordInScope(property(second.id!),data,filters),true);
  assert.equal(workspaceRecordInScope(property(first.id!),data,{...filters,propertyId:second.id!}),false);
  assert.equal(workspaceRecordInScope(unit('scope-unit-active'),data,active),true);
  assert.equal(workspaceRecordInScope(unit('scope-unit-inactive'),data,active),false);
  assert.equal(workspaceRecordInScope(unit('scope-unit-inactive'),data,filters),true);
  assert.equal(workspaceRecordInScope(unit('scope-unit-active'),data,{...filters,propertyId:second.id!}),false);
  assert.equal(workspaceRecordInScope(unit('scope-unit-orphan'),data,filters),false);
  assert.equal(workspaceRecordInScope(unit('missing-unit'),data,filters),false);
  assert.equal(workspaceRecordInScope(property('missing-property'),data,filters),false);
});

test('scope reconciliation preserves all-scope and non-record navigation and handles absent bootstrap',()=>{
  const route=parseWorkspaceRoute('?section=tenants&record=unknown&tab=ledger');
  const narrow={...filters,propertyScope:'active' as const,propertyId:'property-a',status:'current',search:'Smith'};
  assert.equal(workspaceRecordInScope(route,undefined,narrow),false);
  assert.deepEqual(workspaceFiltersForRecord(route,undefined,narrow),{...narrow,propertyScope:'all',propertyId:'all'});
  assert.equal(workspaceFiltersForRecord(route,undefined,filters),filters,'already all/all must not cause another transition');
  const data=bootstrap();
  const existing=parseWorkspaceRoute(`?section=tenants&record=${data.tenantIndex[0].person.id}`);
  assert.equal(workspaceRecordInScope(existing,data,filters),true);
  assert.equal(workspaceFiltersForRecord(existing,data,filters),filters);
  for(const search of ['?section=tenants','?section=properties','?section=dashboard&record=unknown','?section=reports&record=unknown']) {
    const nonRecord=parseWorkspaceRoute(search);
    assert.equal(workspaceRecordInScope(nonRecord,undefined,narrow),true);
    assert.equal(workspaceFiltersForRecord(nonRecord,undefined,narrow),narrow);
  }
});
