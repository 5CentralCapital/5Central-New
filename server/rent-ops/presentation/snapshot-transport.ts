import type {Request,Response} from 'express';
import {gzip} from 'node:zlib';
import {promisify} from 'node:util';
import type {AdminDashboardView} from './dashboard';
const compress=promisify(gzip);
export const SNAPSHOT_GZIP_THRESHOLD=64*1024;
/** Only positive presentation fields enter this wire envelope. Duplicate aliases
 * are reconstructed by the browser from the reports map and snapshot arrays. */
export function compactAdminSnapshot(bundle:AdminDashboardView){
 return {transportVersion:1 as const,generatedAt:bundle.generatedAt,summary:bundle.summary,snapshot:bundle.snapshot,reports:bundle.reports,tenants:bundle.tenants,applicants:bundle.applicants};
}
export async function sendAdminSnapshot(req:Request,res:Response,bundle:AdminDashboardView):Promise<void>{
 const bytes=Buffer.from(JSON.stringify(compactAdminSnapshot(bundle)));
 res.set('Cache-Control','no-store');res.vary('Accept-Encoding');res.type('application/json');
 // An absent header requests the ordinary identity representation; explicit
 // gzip;q=0 is respected by Express's standard quality-value negotiation.
 if(bytes.length>=SNAPSHOT_GZIP_THRESHOLD&&req.headers['accept-encoding']&&req.acceptsEncodings('gzip','identity')==='gzip'){
  const encoded=await compress(bytes,{level:4});res.set('Content-Encoding','gzip');res.send(encoded);
 }else res.send(bytes);
}
