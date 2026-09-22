import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyManagedStorageReadiness } from './managed-storage-readiness';
const report = {profile:'replit-managed-gcs',identityModel:'single-replit-managed-identity',providerPermissions:{'storage.objects.get':true,'storage.objects.create':true,'storage.objects.delete':true},anonymousStatus:403,generationGuard:'ifGenerationMatch=0-and-pinned-read',nativeVersionRetentionVerified:false,applicationExposesListDeleteUpdate:false};
test('managed profile admits truthful single identity without claiming native retention or denying actual provider permissions',async()=>{
 await verifyManagedStorageReadiness({profile:'replit-managed-gcs',probe:async()=>report});
});
test('managed profile fails closed for absent private access, generation guard, write capability or dishonest retention claims',async()=>{
 for(const patch of [{anonymousStatus:200},{generationGuard:'none'},{providerPermissions:{'storage.objects.get':true}},{nativeVersionRetentionVerified:true},{applicationExposesListDeleteUpdate:true},{profile:'s3'},{identityModel:'three-distinct-identities'}]){
  await assert.rejects(verifyManagedStorageReadiness({profile:'replit-managed-gcs',probe:async()=>({...report,...patch})}));
 }
 await assert.rejects(verifyManagedStorageReadiness({profile:'replit-managed-gcs',probe:async()=>null}));
});
