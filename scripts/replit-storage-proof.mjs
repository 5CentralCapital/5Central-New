/** Run only inside the selected Replit app after its private bucket is created.
 * Writes one synthetic PDF under a content-addressed proof prefix. No tenant data.
 * Prints no credentials, bucket policy members, or object contents. */
import { createHash } from 'node:crypto';
import { Client } from '@replit/object-storage';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
const content = 'BT /F1 16 Tf 72 720 Td (5Central private storage proof - synthetic only) Tj ET';
objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
let pdf='%PDF-1.4\n'; const offsets=[0];
objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;});
const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
pdf+=offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('');
pdf+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
const bytes=Buffer.from(pdf);
const checksum = sha(bytes);
const key = `rent-ops/proof/sha256/${checksum}.pdf`;
try {
  // getBucket is documented by Replit's SDK reference. It returns the official
  // Google Cloud Storage Bucket, supporting immutable generation selectors.
  const bucket = await new Client().getBucket();
  const file = bucket.file(key);
  try { await file.save(bytes,{resumable:false,preconditionOpts:{ifGenerationMatch:0},metadata:{contentType:'application/pdf',cacheControl:'private, no-store',metadata:{sha256:checksum}}}); }
  catch(error) { if(Number(error?.code)!==412) throw error; }
  const [metadata] = await file.getMetadata();
  if(!/^\d+$/.test(String(metadata.generation))) throw new Error('generation_missing');
  const [read] = await bucket.file(key,{generation:metadata.generation}).download();
  if(sha(read)!==checksum || read.length!==bytes.length || Number(metadata.size)!==bytes.length) throw new Error('verification_failed');
  const publicResponse = await fetch(`https://storage.googleapis.com/${encodeURIComponent(bucket.name)}/${key}`,{signal:AbortSignal.timeout(10000)});
  if(![401,403,404].includes(publicResponse.status)) throw new Error('anonymous_access_not_denied');
  let versioning=null, uniformAccess=null, publicAccessPrevention=null;
  try {const [meta]=await bucket.getMetadata();versioning=meta.versioning?.enabled===true;uniformAccess=meta.iamConfiguration?.uniformBucketLevelAccess?.enabled===true;publicAccessPrevention=meta.iamConfiguration?.publicAccessPrevention??null;}catch{}
  console.log(JSON.stringify({synthetic:true,bucket:bucket.name,key,checksumSha256:checksum,sizeBytes:bytes.length,immutableGeneration:String(metadata.generation),authenticatedReadVerified:true,anonymousReadStatus:publicResponse.status,versioning,uniformAccess,publicAccessPrevention}));
}catch(error){ console.error(JSON.stringify({verified:false,status:Number.isInteger(Number(error?.code))?Number(error.code):null}));process.exitCode=1; }
