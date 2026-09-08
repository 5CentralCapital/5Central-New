/** Explicit managed-hosting profile; never represents separate provider identities. */
export interface ManagedStorageReadiness {
  profile: "replit-managed-gcs";
  probe(): Promise<unknown>;
}
export async function verifyManagedStorageReadiness(readiness: ManagedStorageReadiness): Promise<void> {
  if (readiness.profile !== "replit-managed-gcs") throw new Error("managed_storage_profile_invalid");
  const report = await readiness.probe() as Record<string, unknown> | null;
  const permissions = report?.providerPermissions as Record<string, unknown> | undefined;
  if (!report || report.profile !== "replit-managed-gcs"
    || report.identityModel !== "single-replit-managed-identity"
    || permissions?.["storage.objects.get"] !== true
    || permissions?.["storage.objects.create"] !== true
    || ![401, 403].includes(report.anonymousStatus as number)
    || report.generationGuard !== "ifGenerationMatch=0-and-pinned-read"
    || report.nativeVersionRetentionVerified !== false
    || report.applicationExposesListDeleteUpdate !== false) {
    throw new Error("managed_storage_readiness_failed");
  }
}
