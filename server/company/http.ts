import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { CompanyCommandError } from './commands/errors';
import { RentOpsRetryableConflict } from '../rent-ops/runtime-database';

/** Keep storage errors and provider credentials out of public error responses. */
export function companyHttpError(error: unknown, res: Response): void {
  if (error instanceof RentOpsRetryableConflict) {
    res.status(409).json({ code: 'company_retryable_conflict', message: 'Records changed during this save. Reload the project before trying again.' });
  } else if (error instanceof CompanyCommandError) {
    res.status(error.status).json({ code: `company_${error.code}`, message: error.message });
  } else if (error instanceof ZodError) {
    res.status(400).json({ code: 'company_validation', message: 'Check the supplied fields and try again.',
      fields: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
  } else {
    res.status(503).json({ code: 'company_unavailable', message: 'Company records are temporarily unavailable.' });
  }
}

export const companyReadHandler = (handler: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, _next: NextFunction) => {
    res.set('Cache-Control', 'no-store');
    void handler(req, res).catch(error => companyHttpError(error, res));
  };

/** Only the existing session middleware may establish the web actor. */
export function companyWebActor(req: Request): string {
  if (!req.rentOpsAdminUser || req.rentOpsAdminUser.role !== 'admin') {
    throw new CompanyCommandError('forbidden', 'A current administrator session is required.', 403);
  }
  return req.rentOpsAdminUser.id;
}
