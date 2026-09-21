import type { RequestHandler } from 'express';
import type { User } from '../../shared/schema';
import { createRentOpsDemoApp, type RentOpsDemoServerOptions } from '../rent-ops/demo-server';
import { createSyntheticCompanyDatabase, SYNTHETIC_COMPANY } from './testing/synthetic-database';
import { registerCompanyRoutes } from './routes';
import { createCompanyProjectPort } from './project-port';

/** Disposable local browser/test app; all company data is in memory. */
export async function createCompanyDemoApp(options: Pick<RentOpsDemoServerOptions, 'publicDir'> = {}) {
  const database = await createSyntheticCompanyDatabase();
  const requireSyntheticAdmin: RequestHandler = (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-rent-ops-csrf') !== 'rent-ops-demo-csrf-token-local-only-20260817') {
      res.status(403).json({ code: 'csrf_required' }); return;
    }
    req.rentOpsAdminUser = { id: SYNTHETIC_COMPANY.actorId, role: 'admin', email: 'demo-admin@example.test' } as User;
    next();
  };
  const app = createRentOpsDemoApp({ ...options, configureSyntheticRoutes: app => registerCompanyRoutes(app, {
    executor: database.executor, requireAdmin: requireSyntheticAdmin, projects: createCompanyProjectPort(database.executor),
  }) });
  return { app, database, close: database.close };
}
