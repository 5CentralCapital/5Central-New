import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { companyScopeSchema } from '../../shared/company';
import type { InvestorCommandKind } from '../../shared/investors';
import { attestTransport, loadAuthenticatedPrincipal } from './authorization';
import { createCompanyServices } from './services';
import { createSyntheticCompanyDatabase, createSyntheticRuntimeExecutor, SYNTHETIC_COMPANY } from './testing/synthetic-database';

test('shared services preserve a manual investor contribution and command replay without inventing QBO funding', async () => {
  const fixture = await createSyntheticCompanyDatabase();
  const database = { ...fixture, executor: await createSyntheticRuntimeExecutor(fixture.db) };
  try {
    const { organizationId, entityId, actorId, propertyId } = SYNTHETIC_COMPANY;
    const services = createCompanyServices(database.executor, { accounting: { environment: {} }, time: { env: {} } });
    assert.equal(services.accounting.qbo.status, 'unconfigured');
    assert.equal(services.time.qbt.status, 'unconfigured');
    const scope = companyScopeSchema.parse({ organizationId, legalEntityId: entityId });
    const resolvePrincipal = (executor = database.executor) => loadAuthenticatedPrincipal(executor, { actorId, organizationId, role: 'admin' });
    const access = { principal: await resolvePrincipal(), resolvePrincipal, transport: attestTransport('web') };
    const envelope = (payload: Record<string, unknown>, companyScope = scope) => {
      const operationId = randomUUID();
      return { operationId, idempotencyKey: `integration:${operationId}`, scope: companyScope, payload };
    };
    const execute = (kind: InvestorCommandKind, command: ReturnType<typeof envelope>) => services.investors.execute(kind, command, access);
    const accountCommand = envelope({ displayName: 'Example investor', newContact: { kind: 'person', displayName: 'Example person' } }, companyScopeSchema.parse({ organizationId }));
    const accountReceipt = await execute('investor.account.create', accountCommand);
    const accountId = accountReceipt.affectedRecordIds[0];
    assert.deepEqual(await execute('investor.account.create', accountCommand), accountReceipt);
    const instrumentReceipt = await execute('investor.instrument.create', envelope({
      accountId, name: 'Example note', kind: 'private_loan', legalEntityId: entityId,
      propertyIds: [propertyId], projectIds: [], currency: 'USD', committedCents: '1000000',
      facePrincipalCents: '1000000', effectiveFrom: '2026-01-01', maturityOn: '2027-01-01',
    }));
    const instrumentId = instrumentReceipt.affectedRecordIds[0];
    const paymentCommand = envelope({
      accountId, instrumentId, kind: 'contribution', method: 'manual', paymentOn: '2026-01-02', currency: 'USD',
      amounts: { principalCents: '250000', interestCents: '0', returnOfCapitalCents: '0', distributionCents: '0', feeCents: '0', balloonCents: '0' },
    });
    const paymentReceipt = await execute('investor.payment.record', paymentCommand);
    assert.deepEqual(await execute('investor.payment.record', paymentCommand), paymentReceipt);
    const detail = await services.investors.get(access.principal, { scope, accountId });
    assert.equal(detail.instruments.length, 1);
    assert.equal(detail.payments.length, 1);
    assert.equal(detail.payments[0].amountCents, '250000');
    assert.equal(detail.payments[0].status, 'manual_recorded');
    assert.equal(detail.payments[0].postedSource, null);
    assert.equal(detail.payments[0].settlementSource, null);
    assert.equal((await services.investors.list(access.principal, { scope, limit: 50 })).items.length, 1);
  } finally {
    await database.close();
  }
});
