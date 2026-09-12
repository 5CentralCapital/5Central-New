import assert from "node:assert/strict";
import test from "node:test";
import { emptyRentOpsSnapshot, type RentOpsSnapshot, type RentOpsRepository } from "../../../shared/rent-ops-contracts";
import { TenantAccountAdminService } from "./admin-service";
import { eligibleTenantTenancies } from "./presentation";
import { InMemoryTenantAccountStore } from "./test-store";
import { SyntheticRentOpsRepository } from "../repositories/synthetic";
import { syntheticRentOpsSnapshot } from "../fixtures/synthetic";

function directory(source: RentOpsSnapshot): RentOpsSnapshot {
  const snapshot=emptyRentOpsSnapshot();
  snapshot.modelVersion=source.modelVersion;
  for(const key of ["properties","units","people","tenancies","householdMemberships","leaseTerms","chargeDefinitions"] as const) Object.assign(snapshot,{[key]:structuredClone(source[key])});
  return snapshot;
}

for(const modelVersion of [2,3] as const) {
  test(`account list preserves exact eligibility with model ${modelVersion} with safe directory selection`,async()=>{
    const source=syntheticRentOpsSnapshot();
    source.modelVersion=modelVersion;
    const primary=source.tenancies[0];
    // Exercise known/unknown status, uncertain links, and cancelled/former records.
    const base={...primary,propertyLinkKnowledge:"manual" as const,unitLinkKnowledge:"manual" as const,primaryPersonLinkKnowledge:"manual" as const,statusKnowledge:"manual" as const};
    source.units=source.units.map(row=>({...row,propertyLinkKnowledge:"manual"}));
    source.tenancies=[
      {...base,id:"eligible-current",status:"current"},
      {...base,id:"eligible-future",status:"future"},
      {...base,id:"eligible-notice",status:"notice"},
      {...base,id:"reject-former",status:"former"},
      {...base,id:"reject-cancelled",status:"cancelled"},
      {...base,id:"reject-link",status:"current",primaryPersonLinkKnowledge:"ambiguous"},
      {...base,id:"reject-status",status:"current",statusKnowledge:"unknown"},
      {...base,id:"legacy-knowledge",status:"current",statusKnowledge:undefined,primaryPersonLinkKnowledge:undefined},
      {...base,id:"reject-missing-person",status:"current",primaryPersonId:"missing"},
      {...base,id:"reject-missing-unit",status:"current",unitId:"missing"},
    ];
    const expected=eligibleTenantTenancies(source);
    assert.deepEqual(expected.map(row=>row.tenancyId),["eligible-current","eligible-future","eligible-notice",...(modelVersion===2?["legacy-knowledge"]:[])]);
    let narrowReads=0,fullReads=0;
    const repository:RentOpsRepository=new SyntheticRentOpsRepository(syntheticRentOpsSnapshot());
    repository.getWorkspaceSnapshot=async()=>{narrowReads++;return directory(source);};
    repository.getSnapshot=async()=>{fullReads++;if(modelVersion===3)throw new Error("full snapshot must not be loaded for model 3 account list");return structuredClone(source);};
    const result=await new TenantAccountAdminService({repository,store:new InMemoryTenantAccountStore()}).list();
    assert.deepEqual(result,{deliveryAvailable:false,accounts:[],eligibleTenancies:expected});
    assert.equal(narrowReads,1);
    assert.equal(fullReads,modelVersion===2?1:0);
  });
}

test("account list falls back for repositories without directory reads",async()=>{
  const source=syntheticRentOpsSnapshot();
  const repository=new SyntheticRentOpsRepository(source);
  let reads=0;
  repository.getSnapshot=async()=>{reads++;return structuredClone(source);};
  const result=await new TenantAccountAdminService({repository,store:new InMemoryTenantAccountStore(),notifier:async()=>{throw new Error("list must not send");}}).list();
  assert.deepEqual(result,{deliveryAvailable:true,accounts:[],eligibleTenancies:eligibleTenantTenancies(source)});
  assert.equal(reads,1);
});

test("directory failures propagate without silently retrying a full snapshot",async()=>{
  const repository:RentOpsRepository=new SyntheticRentOpsRepository(syntheticRentOpsSnapshot());
  repository.getWorkspaceSnapshot=async()=>{throw new Error("directory unavailable");};
  repository.getSnapshot=async()=>{throw new Error("unexpected full snapshot");};
  await assert.rejects(new TenantAccountAdminService({repository,store:new InMemoryTenantAccountStore()}).list(),/directory unavailable/);
});

test("a legacy-mode directory cannot relax a strict full snapshot's binding checks",async()=>{
  const full=syntheticRentOpsSnapshot();
  full.modelVersion=3;
  const projected=directory(full);
  projected.modelVersion=2;
  assert.ok(eligibleTenantTenancies(projected).length>eligibleTenantTenancies(full).length,"fixture demonstrates missing-knowledge eligibility differs by mode");
  let reads=0;
  const repository:RentOpsRepository=new SyntheticRentOpsRepository(syntheticRentOpsSnapshot());
  repository.getWorkspaceSnapshot=async()=>projected;
  repository.getSnapshot=async()=>{reads++;return full;};
  const result=await new TenantAccountAdminService({repository,store:new InMemoryTenantAccountStore()}).list();
  assert.deepEqual(result.eligibleTenancies,eligibleTenantTenancies(full));
  assert.equal(reads,1);
});
