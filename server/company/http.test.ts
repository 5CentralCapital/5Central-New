import assert from 'node:assert/strict';
import test from 'node:test';
import type { Response } from 'express';
import { companyHttpError } from './http';
import { RentOpsRetryableConflict } from '../rent-ops/runtime-database';

test('database serialization conflicts permit a reload while unexpected failures stay redacted', () => {
  let status: number | undefined;
  let payload: unknown;
  const response = {
    status(value: number) { status = value; return this; },
    json(value: unknown) { payload = value; return this; },
  } as Response;
  companyHttpError(new RentOpsRetryableConflict(), response);
  assert.equal(status, 409);
  assert.equal((payload as { code: string }).code, 'company_retryable_conflict');
  companyHttpError(new Error('private database diagnostic'), response);
  assert.equal(status, 503);
  assert.equal(JSON.stringify(payload).includes('private database diagnostic'), false);
});
