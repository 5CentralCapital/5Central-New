import { Client } from '@replit/object-storage';
import { createProductionRentOpsWebObjectStoresFromEnv } from './object-store';
import { createReplitManagedGcsObjectStores, type ManagedBucket } from './replit-managed-gcs';
import { storageError } from './errors';

/** Explicit profile selection: the managed profile never claims S3 role separation. */
export async function createConfiguredRentOpsWebObjectStores(env: Readonly<Record<string,string|undefined>> = process.env) {
  if (env.RENT_OPS_DATABASE_URL || env.RENT_OPS_OBJECT_STORE_IMPORTER_TOKEN) throw storageError('storage_privilege_probe_failed');
  if (env.RENT_OPS_OBJECT_STORE_BACKEND !== 'replit-managed-gcs') return createProductionRentOpsWebObjectStoresFromEnv({env});
  const bucketId=env.RENT_OPS_OBJECT_STORE_BUCKET;
  const prefix=env.RENT_OPS_OBJECT_STORE_PREFIX;
  if (!bucketId || !/^replit-objstore-[a-f0-9-]{36}$/.test(bucketId) || !prefix) throw storageError('storage_privilege_probe_failed');
  // Replit documents getBucket; its bundled declaration marks it private.
  // This narrow structural boundary exposes only the bucket operations used by the adapter.
  const client=new Client({bucketId}) as unknown as {getBucket():Promise<ManagedBucket>};
  const bucket=await client.getBucket();
  if(bucket.name!==bucketId)throw storageError('storage_privilege_probe_failed');
  const {documentStorage,documentUploadStorage,managedHostingReport}=await createReplitManagedGcsObjectStores({bucket,prefix});
  return {documentStorage,documentUploadStorage,managedHostingReport};
}
