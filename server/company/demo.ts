import type { RequestHandler } from 'express';
import type { User } from '../../shared/schema';
import { createRentOpsDemoApp, type RentOpsDemoServerOptions } from '../rent-ops/demo-server';
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY, createSyntheticRuntimeExecutor } from './testing/synthetic-database';
import { registerCompanyRoutes } from './routes';
import { createCompanyServices } from './services';
import { seedRentalDemo } from './testing/seed-rental-demo';
import { PostgresRentOpsRepository } from '../rent-ops/repositories/postgres';
import { seedWorkOrderDemo } from './testing/seed-work-orders';
import type { AccountingQboConfig } from '../accounting';

export interface CompanyDemoAppOptions extends Pick<RentOpsDemoServerOptions, 'publicDir'> {
  /** QBO_* variables for the accounting services. Defaults to `{}` so the
   * demo never reads credentials from the process environment. */
  readonly accountingEnvironment?: NodeJS.ProcessEnv;
  /** Test-only QBO overrides such as an offline transport. */
  readonly accountingQbo?: Partial<AccountingQboConfig>;
}

/** Fixed local-only CSRF value that the synthetic demo session hands the browser. */
export const COMPANY_DEMO_CSRF_TOKEN = 'rent-ops-demo-csrf-token-local-only-20260817';

/** Disposable local browser/test app; all company data is in memory. */
export async function createCompanyDemoApp(options: CompanyDemoAppOptions = {}) {
  const { accountingEnvironment = {}, accountingQbo, ...demoOptions } = options;
  const fixture = await createSyntheticCompanyDatabase();
  await seedRentalDemo({ executor: fixture.executor, actorId: SYNTHETIC_COMPANY.actorId, actorRole: 'owner' });
  const database = { ...fixture, executor: await createSyntheticRuntimeExecutor(fixture.db) };
  const requireSyntheticAdmin: RequestHandler = (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-rent-ops-csrf') !== COMPANY_DEMO_CSRF_TOKEN) {
      res.status(403).json({ code: 'csrf_required' }); return;
    }
    req.rentOpsAdminUser = { id: SYNTHETIC_COMPANY.actorId, role: 'admin', email: 'demo-admin@example.test' } as User;
    next();
  };
  const company = createCompanyServices(database.executor, { accounting: { environment: accountingEnvironment, ...(accountingQbo ? { qbo: accountingQbo } : {}) }, time: { env: {} } });
  await seedWorkOrderDemo(database.executor, company.workOrders);
  const app = createRentOpsDemoApp({ ...demoOptions,
    syntheticRepository: new PostgresRentOpsRepository(database.executor),
    configureSyntheticRoutes: app => registerCompanyRoutes(app, {
    ...company, requireAdmin: requireSyntheticAdmin,
  }) });
  return { app, database, services: company, close: database.close };
}
