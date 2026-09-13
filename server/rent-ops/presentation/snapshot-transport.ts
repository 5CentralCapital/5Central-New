import type {Request,Response} from 'express';
import {gzip,brotliCompress,constants} from 'node:zlib';
import {promisify} from 'node:util';
import type {AdminDashboardView} from './dashboard';
const compress=promisify(gzip);
const compressBrotli=promisify(brotliCompress);
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
 // refused encodings are respected by Express's quality-value negotiation.
 const encoding=req.headers['accept-encoding']?req.acceptsEncodings('br','gzip','identity'):'identity';
 if(bytes.length>=SNAPSHOT_GZIP_THRESHOLD&&encoding==='br'){
  const encoded=await compressBrotli(bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:4}});res.set('Content-Encoding','br');res.send(encoded);
 }else if(bytes.length>=SNAPSHOT_GZIP_THRESHOLD&&encoding==='gzip'){
  const encoded=await compress(bytes,{level:4});res.set('Content-Encoding','gzip');res.send(encoded);
 }else res.send(bytes);
}
