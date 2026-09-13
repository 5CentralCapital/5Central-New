import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import * as current from '../server/rent-ops/domain/reports';
import { validateSnapshot } from '../server/rent-ops/domain/invariants';
import { performanceFixture } from './performance-fixture';

// Frozen, pre-change bundles are local working evidence, never runtime inputs.
const baseline = await import(pathToFileURL(resolve('.workflow/performance/baseline/reports.mjs')).href);
const baselineInvariants = await import(pathToFileURL(resolve('.workflow/performance/baseline/invariants.mjs')).href);
const reports = ['rent-roll','occupancy','scheduled-income','collected-income','scheduled-vs-collected','delinquency','tenant-ledger','lease-expirations','deposits','hap','applicant-pipeline'] as const;
const scenarios = [performanceFixture(3,4), performanceFixture()];
for (let variant=0;variant<4;variant++) {
  const data = performanceFixture(3,4);
  const row = data.ledgerTransactions[variant];
  if (variant===0) Object.assign(row,{tenancyId:null,tenancyLinkKnowledge:'unknown',amountCents:null,amountKnowledge:'unknown'});
  if (variant===1) Object.assign(row,{tenancyId:data.tenancies.at(-1)!.id,personLinkKnowledge:'ambiguous'});
  if (variant===2) Object.assign(data.paymentAllocations[0],{chargeTransactionId:null,chargeLinkKnowledge:'unknown'});
  if (variant===3) Object.assign(row,{postedOn:'2026-02-30',postedOnKnowledge:'unknown',status:null,statusKnowledge:'unknown'});
  scenarios.push(data);
}
const outcome = (read:()=>unknown) => {
  try { return {value:read()}; } catch(error:any) { return {error:error.message,violations:error.violations}; }
};
let comparisons=0;
for (const [index,data] of scenarios.entries()) {
  assert.deepEqual(validateSnapshot(data),baselineInvariants.validateSnapshot(data),`invariants scenario ${index}`);comparisons++;
  for (const filters of [{asOfDate:'2026-08-15',month:'2026-08'},{asOfDate:'2026-08-15',month:'2026-08',propertyId:data.properties[0].id},{asOfDate:'2026-08-01',month:'2026-08'},{asOfDate:'2026-09-12',month:'2026-09',propertyScope:'active' as const}]) {
    for (const report of reports) {
      assert.deepEqual(outcome(()=>current.deriveFixedReport(data,report,filters)),outcome(()=>baseline.deriveFixedReport(data,report,filters)),`${index} ${report} ${JSON.stringify(filters)}`);comparisons++;
    }
    for (const name of ['deriveDashboardWorkspace','deriveOperationalScheduleRegister'] as const) {
      assert.deepEqual(outcome(()=>current[name](data,filters)),outcome(()=>baseline[name](data,filters)),`${index} ${name}`);comparisons++;
    }
    assert.deepEqual(outcome(()=>current.deriveTenantProfile(data,data.people[0].id,filters)),outcome(()=>baseline.deriveTenantProfile(data,data.people[0].id,filters)),`${index} tenant profile`);comparisons++;
  }
}
const data=scenarios[1], filters={asOfDate:'2026-08-15',month:'2026-08'};
const median=(values:number[])=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
const timings=[];
for (const name of ['validateSnapshot','deriveDashboardWorkspace','deriveRentRoll','deriveDelinquency','deriveTenantProfile'] as const) {
  const oldRead=()=>name==='validateSnapshot'?baselineInvariants.validateSnapshot(data):name==='deriveTenantProfile'?baseline[name](data,data.people[0].id,filters):baseline[name](data,filters);
  const newRead=()=>name==='validateSnapshot'?validateSnapshot(data):name==='deriveTenantProfile'?current[name](data,data.people[0].id,filters):current[name](data,filters);
  oldRead();newRead();const before=[],after=[];
  for(let trial=0;trial<5;trial++){let t=performance.now();oldRead();before.push(performance.now()-t);t=performance.now();newRead();after.push(performance.now()-t);}
  const oldMs=median(before),newMs=median(after);timings.push({name,beforeMs:+oldMs.toFixed(2),afterMs:+newMs.toFixed(2),improvementPercent:+((1-newMs/oldMs)*100).toFixed(1)});
}
console.log(JSON.stringify({comparisons,identical:true,synthetic:true,timings},null,2));
