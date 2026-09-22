import { PGlite } from '@electric-sql/pglite';
import { ensureRentOpsSchema } from '../../rent-ops/persistence';
import type { RentOpsQueryExecutor } from '../../rent-ops/repositories/postgres';
import { createRentOpsSecurityManifest, renderRentOpsSecuritySql } from '../../rent-ops/security/deployment-security';
import { rentOpsMigrationDefinitions } from '../../rent-ops/persistence';

export const SYNTHETIC_COMPANY = {
  organizationId: '10000000-0000-4000-8000-000000000001',
  entityId: '20000000-0000-4000-8000-000000000001',
  actorId: 'demo-admin',
  propertyId: 'demo-property-a',
  unitId: 'demo-unit-a-1',
} as const;

export function pgliteExecutor(connection: Pick<PGlite, 'query' | 'transaction'>): RentOpsQueryExecutor {
  return {
    query: (text, values) => connection.query(text, values),
    transaction: work => connection.transaction(tx => work({ query: (text, values) => tx.query(text, values) })),
  };
}

/** Exercise the real runtime grants against this disposable, in-memory database. */
export async function createSyntheticRuntimeExecutor(db: PGlite): Promise<RentOpsQueryExecutor> {
  if (process.env.NODE_ENV === 'production') throw new Error('Synthetic runtime roles are unavailable in production');
  const manifest = createRentOpsSecurityManifest('staging', {
    gates: {
      backupVerified: true, backupAttestation: 'disposable-in-memory-fixture',
      independentAuditVerified: true, independentAuditAttestation: 'disposable-in-memory-fixture',
      schemaChecksumSha256: rentOpsMigrationDefinitions().at(-1)!.checksum,
    },
    roleAttestation: {
      runtimeRoleIsNotRestrictedTableOwner: true, runtimeRoleNoInherit: true,
      importerRoleIsDistinct: true, auditorRoleIsDistinct: true, auditorRoleNoInherit: true,
    },
  });
  for (const role of [manifest.target.runtimeRole, manifest.target.importerRole, manifest.target.auditorRole]) {
    await db.exec(`CREATE ROLE "${role}" NOLOGIN NOINHERIT`);
  }
  await db.exec(renderRentOpsSecuritySql(manifest, { mode: 'apply' }).sql);
  const inRuntime = <T>(work: (executor: RentOpsQueryExecutor) => Promise<T>) => db.transaction(async transaction => {
    await transaction.exec(`SET LOCAL ROLE "${manifest.target.runtimeRole}"`);
    return work({ query: (sql, values) => transaction.query(sql, values) });
  });
  return {
    query: (sql, values) => inRuntime(executor => executor.query(sql, values)),
    transaction: work => inRuntime(work),
  };
}

/** Explicit memory-only synthetic fixture. Never imported by production routes. */
export async function createSyntheticCompanyDatabase() {
  if (process.env.NODE_ENV === 'production') throw new Error('Synthetic company data is unavailable in production');
  const db = new PGlite();
  try {
    await ensureRentOpsSchema({ apply: true, executor: async sql => { await db.exec(sql); } });
    const { organizationId, entityId, actorId, propertyId, unitId } = SYNTHETIC_COMPANY;
    await db.query("INSERT INTO company_organizations(id,name) VALUES ($1,'Example Company')", [organizationId]);
    await db.query("INSERT INTO company_legal_entities(id,organization_id,name,entity_type,currency) VALUES ($1,$2,'Example Property LLC','llc','USD')", [entityId, organizationId]);
    await db.query("INSERT INTO rent_ops_properties(id,name,slug) VALUES ($1,'Demo property A','demo-property-a')", [propertyId]);
    await db.query("INSERT INTO rent_ops_units(id,property_id,unit_number) VALUES ($1,$2,'1A')", [unitId, propertyId]);
    await db.query("INSERT INTO company_property_entity_periods(id,organization_id,legal_entity_id,property_id,effective_from) VALUES ('30000000-0000-4000-8000-000000000001',$1,$2,$3,'2020-01-01')", [organizationId, entityId, propertyId]);
    await db.query("INSERT INTO company_access_grants(id,organization_id,actor_id,role) VALUES ('40000000-0000-4000-8000-000000000001',$1,$2,'admin')", [organizationId, actorId]);
    return { db, executor: pgliteExecutor(db), close: () => db.close() };
  } catch (error) {
    await db.close(); throw error;
  }
}
