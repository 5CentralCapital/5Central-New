import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRentManagerExport } from './normalizer';
import type { ExportPayload } from './types';
const normalize = (payload: ExportPayload) => normalizeRentManagerExport(payload, { asOfDate:'2026-09-07', artifactObservationOn:'2026-09-07', artifactSha256:'a'.repeat(64) }).input;
test('property metadata retains explicit type and manager and separates street from formatted postal address', () => {
 const input = normalize({properties:[{PropertyID:30,Name:'Test',PropertyType:'MultiFamily',ManagerName:'Source manager',Addresses:[{IsPrimary:true,Street:'123 Main St',Address:'123 Main St\nTampa FL 33610',City:'Tampa',State:'FL',PostalCode:'33610'}]}]} as ExportPayload);
 assert.equal(input.properties![0].propertyType,'MultiFamily');
 assert.equal(input.properties![0].operatingContact,'Source manager');
 assert.equal(input.properties![0].addressLine1,'123 Main St');
 assert.equal((input.properties![0].Addresses as any[])[0].Address,'123 Main St\nTampa FL 33610');
});
test('explicit unit bedrooms win over type defaults and exact type joins recover missing numeric metadata', () => {
 const input = normalize({properties:[{PropertyID:30,Name:'Test'}],unitTypeRecords:[{UnitTypeID:2,Name:'1B/1B',Bedrooms:1,Bathrooms:1}],units:[{UnitID:1,PropertyID:30,Name:'A',Bedrooms:0,UnitType:{Name:'1B/1B',Bedrooms:1,Bathrooms:1}},{UnitID:2,PropertyID:30,Name:'B',UnitTypeID:2},{UnitID:3,PropertyID:30,Name:'C',UnitType:{Name:'3B/1B'}}]} as ExportPayload);
 assert.equal(input.units![0].bedrooms,0);
 assert.equal(input.units![1].bedrooms,1);
 assert.equal(input.units![1].bathrooms,1);
 assert.equal(input.units![2].bedrooms,undefined);
 assert.equal(input.units![2].bathrooms,undefined);
});
test('source-empty address and absent deposits remain unknown rather than invented from name or rent', () => {
 const input = normalize({properties:[{PropertyID:31,Name:'123 Main St',Addresses:[{IsPrimary:true,Street:'',City:'',State:'',PostalCode:''}]}],units:[{UnitID:1,PropertyID:31,Name:'A',MarketRent:1000,Amenities:[]}]} as ExportPayload);
 assert.equal(input.properties![0].addressLine1,undefined);
 assert.equal(input.properties![0].propertyType,undefined);
 assert.equal(input.units![0].defaultDepositCents,undefined);
 assert.deepEqual(input.units![0].amenities,[]);
});
test('unit-owned embedded amenities normalize raw compatibility objects without sharing another unit list', () => {
 const first = [{AmenityID:18,Name:'Central AC'},{AmenityID:19,Name:'Mini-Split'}];
 const second = [{AmenityID:4,Name:'Dishwasher'}];
 const input = normalize({properties:[{PropertyID:30,Name:'Test'}],units:[{UnitID:1,PropertyID:30,Name:'A',Amenities:first,amenities:first},{UnitID:2,PropertyID:30,Name:'B',Amenities:second,amenities:second},{UnitID:3,PropertyID:30,Name:'C'}]} as ExportPayload);
 assert.deepEqual(input.units![0].amenities,['Central AC','Mini-Split']);
 assert.deepEqual(input.units![1].amenities,['Dishwasher']);
 assert.equal(input.units![2].amenities,undefined);
 assert.deepEqual(input.units![0].Amenities,first);
});
test('only explicit tenant archive flag is retained; contact active and tenancy Past do not create archive facts', () => {
 const input = normalize({tenants:[{TenantID:1,Status:'Past',Contacts:[{ContactID:2,IsPrimary:true,IsActive:true}]},{TenantID:3,IsArchived:false},{TenantID:4,IsArchived:true}]} as ExportPayload);
 assert.equal(input.tenants![0].archived,undefined);
 assert.equal(input.tenants![1].archived,false);
 assert.equal(input.tenants![2].archived,true);
});
