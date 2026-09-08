import { TenantApiError } from './api';
export const MAX_LEASE_BYTES = 50 * 1024 * 1024;
/** Only an opaque document ID enters the existing protected download route. */
export function leasePdfPath(id: string): string {
  if (!id || id.length > 160) throw new Error('Invalid lease document.');
  return `/api/tenant/lease-files/${encodeURIComponent(id)}/download`;
}
export async function fetchLeasePdf(id:string, signal:AbortSignal, fetchImpl:typeof fetch=fetch):Promise<Uint8Array> {
  const response=await fetchImpl(leasePdfPath(id),{credentials:'same-origin',cache:'no-store',redirect:'error',signal,headers:{Accept:'application/pdf'}});
  if(response.status===401)throw new TenantApiError(401,'Your session has ended. Please sign in again.');
  if(!response.ok)throw new Error('This lease is unavailable. Refresh your account or contact management.');
  if(response.headers.get('content-type')?.split(';')[0].trim()!=='application/pdf')throw new Error('The lease response could not be verified.');
  const length=Number(response.headers.get('content-length'));
  if(length>MAX_LEASE_BYTES)throw new Error('This lease is too large to preview. Use Download PDF.');
  const reader=response.body?.getReader();if(!reader)throw new Error('The lease could not be read.');
  const chunks:Uint8Array[]=[];let total=0;
  try {while(true){const next=await reader.read();if(next.done)break;total+=next.value.length;if(total>MAX_LEASE_BYTES)throw new Error('This lease is too large to preview. Use Download PDF.');chunks.push(next.value);}}catch(error){await reader.cancel();throw error;}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')throw new Error('The lease response could not be verified.');
  return bytes;
}
