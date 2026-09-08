import {createHash} from 'node:crypto';
import {rentOpsMigrationDefinitions} from '../server/rent-ops/persistence';
import type {RentOpsQueryExecutor} from '../server/rent-ops/repositories/postgres';
export const PROVISIONING_SCHEMA_VERSION=26;
export const PROVISIONING_SCHEMA26_CHECKSUM='f6a2872ffc21150351d441759886fd778c076981e96435847a7f82f32dea0a96';
export const PROVISIONING_CHAIN_SHA256='a6be5d43fd6db0e46c56fde4acd2fbd3f31ece5608c3edd5ccf600ceab8a35ad';
export const PROVISIONING_APPROVAL='two-imports-audited-schema26-approved';
/** This is a reviewed release gate, not a minimum supported version check. */
export function validateProvisioningSchema(rows:ReadonlyArray<{version:number;checksum_sha256:string}>):void {
 const expected=rentOpsMigrationDefinitions().map(row=>({version:row.version,checksum:row.checksum}));
 const digest=createHash('sha256').update(JSON.stringify(expected)).digest('hex');
 if(expected.length!==PROVISIONING_SCHEMA_VERSION||expected.at(-1)?.checksum!==PROVISIONING_SCHEMA26_CHECKSUM||digest!==PROVISIONING_CHAIN_SHA256)throw Error('Local provisioning release differs from reviewed schema26 chain');
 if(rows.length!==expected.length||rows.some((row,index)=>row.version!==expected[index].version||row.checksum_sha256!==expected[index].checksum))throw Error('Exact reviewed schema26 version/checksum chain required; this operator applies no migrations');
}
export async function verifyProvisioningSchema(db:RentOpsQueryExecutor):Promise<void>{
 const result=await db.query<{version:number;checksum_sha256:string}>('SELECT version,checksum_sha256 FROM rent_ops_schema_migrations ORDER BY version');
 validateProvisioningSchema(result.rows);
}
