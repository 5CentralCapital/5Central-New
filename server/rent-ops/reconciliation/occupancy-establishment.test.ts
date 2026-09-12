import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {emptyRentOpsSnapshot} from '../../../shared/rent-ops-contracts';
import {syntheticRentOpsSnapshot} from '../fixtures/synthetic';
import {SyntheticRentOpsRepository} from '../repositories/synthetic';
import {buildMaintenanceManifest,bytesHash,verifyMaintenanceReadback,type MaintenancePack} from './maintenance';
import {reconcileImportedRecords} from './operator';
import {deriveTenantProfile,deriveRentRoll} from '../domain/reports';

test('observed occupancy bundle creates known lease and charges without inventing actual move-in',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'occupancy-bundle-'));
 try {
  const fixture=syntheticRentOpsSnapshot(),source={...emptyRentOpsSnapshot(),properties:fixture.properties,units:fixture.units,chargeDefinitions:fixture.chargeDefinitions},property=source.properties[0];
  source.people.push({id:'new-person',firstName:'New',lastName:'Resident',source:{system:'rent_manager',entityType:'person',sourceId:'tenant:new'}});
  source.units.push({...source.units[0],id:'new-unit',unitNumber:'new'});
  const original=fixture.recurringSchedules.find(row=>row.category==='base_rent')!;
  const root={...original,id:'new-base',chargeDefinitionKey:null,lineageRootId:'new-base',tenancyId:'new-tenancy',personId:'new-person',scopeId:'new-person',propertyId:property.id,unitId:'new-unit',amountCents:155000,effectiveFrom:'2026-09-12',billingFrequency:'monthly'};
  const pack:MaintenancePack={version:1,initialBaselineSha256:'a'.repeat(64),counts:{},provenance:'owner',phases:[{id:'occupancy',operations:[{target:{collection:'people',sourceId:'tenant:new'},reference:'Owner confirmed occupancy September 8',values:{kind:'occupancy-establish',
   propertyGuard:{$guard:{collection:'properties',id:property.id}},unitGuard:{$guard:{collection:'units',id:'new-unit'}},
   tenancy:{id:'new-tenancy',primaryPersonId:'new-person',propertyId:property.id,unitId:'new-unit',status:'current',statusKnowledge:'manual',actualMoveInKnowledge:'unknown',occupancyConfirmedOn:'2026-09-08',occupancyConfirmationKnowledge:'manual'},
   schedules:[root],leaseTerms:[{id:'new-lease',tenancyId:'new-tenancy',status:'executed',contractStartOn:'2026-09-01',contractEndOn:'2027-08-31',monthToMonth:false}]
  }}]}]};
  const path=join(directory,'pack.json'),bytes=Buffer.from(JSON.stringify(pack));await writeFile(path,bytes);
  const repository=new SyntheticRentOpsRepository(source),before=await repository.getSnapshot();
  const {manifest}=buildMaintenanceManifest(before,pack,pack.phases[0],{actor:'owner',occurredAt:'2026-09-12T15:00:00.000Z',packPath:path,packSha256:bytesHash(bytes)});
  const plan=await reconcileImportedRecords(repository,manifest,{mode:'plan'});assert.deepEqual(await repository.getSnapshot(),before);
  const applied=await reconcileImportedRecords(repository,manifest,{mode:'apply',approvedPlanToken:plan.token}),after=await repository.getSnapshot();
  verifyMaintenanceReadback(before,after,manifest,applied);
  const profile=deriveTenantProfile(after,'new-person',{asOfDate:'2026-09-12'})!;
  assert.equal(profile.tenancy?.actualMoveInOn,undefined);assert.equal(profile.tenancy?.occupancyConfirmedOn,'2026-09-08');assert.equal(profile.operationalSchedulesComplete,true);
  assert.equal(profile.primaryLease?.contractStartOn,'2026-09-01');assert.equal(profile.primaryLease?.signedOn,undefined);
  assert.equal(deriveRentRoll(after,{asOfDate:'2026-09-12'}).find(row=>row.unitId==='new-unit')?.baseRentCents,155000);
  assert.notEqual(deriveRentRoll(after,{asOfDate:'2026-09-07'}).find(row=>row.unitId==='new-unit')?.occupancy,'current');
  assert.deepEqual(after.ledgerTransactions,before.ledgerTransactions);assert.deepEqual(after.paymentAllocations,before.paymentAllocations);
 }finally{await rm(directory,{recursive:true});}
});
