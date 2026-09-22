import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { ensureRentOpsSchema, RENT_OPS_RUNTIME_REQUIRED_TABLES } from '../persistence';
import { PostgresRentOpsRepository } from '../repositories/postgres';
import { RentOpsService } from './service';
import { serializePublicListings } from '../presentation/public';

test('public inventory reads only three tables and preserves fail-closed listing DTO', async () => {
    const db = new PGlite();
    const queries: string[] = [];
    try {
        await ensureRentOpsSchema({ apply: true, executor: async (sql) => { await db.exec(sql); } });
        await db.exec("INSERT INTO rent_ops_properties(id,name,slug,address_line1,city,state,postal_code,property_type,state_knowledge) VALUES('p','QA','qa','1 QA','QA','FL','00000','multifamily','manual'); INSERT INTO rent_ops_units(id,property_id,unit_number,property_link_knowledge,readiness,listing) VALUES('u','p','1','manual','ready','listed')");
        await db.exec('CREATE ROLE public_inventory_test;GRANT USAGE ON SCHEMA public TO public_inventory_test');
        for (const table of RENT_OPS_RUNTIME_REQUIRED_TABLES.filter(t => t !== 'rent_ops_schema_migrations'))
            await db.exec(`GRANT SELECT,INSERT,UPDATE ON ${table} TO public_inventory_test`);
        await db.exec('GRANT SELECT ON rent_ops_schema_migrations TO public_inventory_test');
        await db.exec('SET ROLE public_inventory_test');
        const adapt = (connection: any): any => ({
            query: (sql: string, args: any[]) => {
                queries.push(sql);
                return connection.query(sql, args);
            },
            transaction: (work: any, options: any) => {
                assert.equal(options.readOnly, true);
                return connection.transaction((transaction: any) => work({
                    query: (sql: string, args: any[]) => {
                        queries.push(sql);
                        return transaction.query(sql, args);
                    },
                }));
            },
        });
        const repository = new PostgresRentOpsRepository(adapt(db));
        await repository.assertReady();
        queries.length = 0;
        const full = await repository.getPublicInventory();
        assert.deepEqual(queries.filter(q => q.startsWith('SELECT *')).sort(), ['SELECT * FROM rent_ops_properties', 'SELECT * FROM rent_ops_tenancies', 'SELECT * FROM rent_ops_units']);
        repository.getSnapshot = async () => { throw Error('full snapshot forbidden'); };
        queries.length = 0;
        const service = new RentOpsService(repository, () => new Date('2026-09-08T12:00:00Z'));
        const result = await service.publicApplicationListings();
        const expected = serializePublicListings(full.properties.map(p => ({ ...p, trustedNative: true, units: full.units.map(u => ({ ...u, trustedNative: true })) })));
        assert.deepEqual(result, expected);
        assert.equal(result.length, 1);
        assert.equal(result[0].units?.length, 1);
        assert.equal(queries.filter(q => q.startsWith('SELECT *')).length, 3);
        assert.equal(JSON.stringify(result).includes('source'), false);
        repository.getPublicInventory = async () => ({
            ...full,
            tenancies: [{
                id: 'unknown',
                propertyId: 'p',
                unitId: 'u',
                propertyLinkKnowledge: 'manual',
                unitLinkKnowledge: 'manual',
                status: null,
                statusKnowledge: 'unknown',
            } as any],
        });
        const blocked = await service.publicApplicationListings();
        assert.equal(blocked[0].units?.length, 0);
    } finally {
        await db.close();
    }
});
