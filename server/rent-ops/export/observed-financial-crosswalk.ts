import type { ExportPayload } from './types';
import { createFinancialSemanticCrosswalkEntry, type FinancialSemanticKind, type RentManagerFinancialSemanticCrosswalk } from '../../../shared/rent-ops-contracts';
/** Build only exact source enum meanings; no financial label/prose classification. */
export function deriveObservedFinancialCrosswalk(payload: ExportPayload, artifactSha256: string): RentManagerFinancialSemanticCrosswalk {
 if (!/^[a-f0-9]{64}$/.test(artifactSha256)) throw new Error('artifact_digest_invalid');
 const entries: RentManagerFinancialSemanticCrosswalk['entries']=[];
 const add=(rows:readonly Record<string,unknown>[],sourceCollection:string,sourceField:string,semanticKind:FinancialSemanticKind,known:Readonly<Record<string,string>>)=>{
  const values=new Set(rows.map(row=>row[sourceField]).filter(v=>typeof v==='string'||typeof v==='boolean'));
  for(const rawValue of Array.from(values)){const targetValue=known[String(rawValue)];if(targetValue===undefined)continue;entries.push(createFinancialSemanticCrosswalkEntry({artifactSha256,sourceCollection,sourceField,semanticKind,normalization:'exact_v1',rawValue,targetValue})!);}
 };
 add(payload.tenants??[],'tenants','Status','tenancy_status',{Current:'current',Future:'future',Past:'past'});
 add(payload.recurringSchedules??[],'recurringSchedules','EntityType','recurring_scope',{Tenant:'tenant',Unit:'unit',Property:'property'});
 add(payload.chargeTypeRecords??[],'chargeTypes','IsActive','charge_definition_active',{true:'true',false:'false'});
 return {artifactSha256,normalization:'exact_v1',entries};
}
