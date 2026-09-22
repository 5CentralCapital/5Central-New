import { AccountingError } from '../accounting/errors';
import { QuickBooksIntegrationError } from '../integrations/quickbooks/errors';

export interface PublicFinancialError {
  status: number;
  code: string;
  message: string;
  retryable: boolean;
  recovery: 'configure_connection' | 'reconnect' | 'review_capability' | 'correct_input' | 'refresh_record' | 'reconcile_operation' | 'retry_same_operation' | 'wait';
}

/** Transport-safe recovery information; provider messages and bodies stay private. */
export function publicFinancialError(error: unknown): PublicFinancialError | undefined {
  if (!(error instanceof AccountingError) && !(error instanceof QuickBooksIntegrationError)) return undefined;
  const code = error.code;
  if (error instanceof QuickBooksIntegrationError && error.ambiguous || code === 'quickbooks_ambiguous_write') {
    return { status: 409, code: 'quickbooks_ambiguous_write', message: 'Check the existing QuickBooks operation before trying another save.', retryable: false, recovery: 'reconcile_operation' };
  }
  if (error instanceof AccountingError && code === 'accounting_unavailable' && error.details.reason === 'qbo_disconnect_unconfirmed') {
    return { status: 503, code: 'accounting_disconnect_unconfirmed', message: 'QuickBooks did not confirm the disconnect. The connection was kept; try again.', retryable: true, recovery: 'retry_same_operation' };
  }
  if (code.endsWith('_configuration')) return { status: 503, code, message: 'QuickBooks connection setup is required.', retryable: false, recovery: 'configure_connection' };
  if (code === 'quickbooks_oauth' || code === 'quickbooks_unauthorized' || code === 'quickbooks_token_store') return { status: 503, code, message: 'Reconnect QuickBooks to continue.', retryable: false, recovery: 'reconnect' };
  if (code === 'accounting_capability_disabled' || code === 'quickbooks_unsupported_capability') return { status: 403, code, message: 'This QuickBooks feature is not enabled for the selected company.', retryable: false, recovery: 'review_capability' };
  if (code.endsWith('_validation')) return { status: 400, code, message: 'Check the accounting fields and selected company.', retryable: false, recovery: 'correct_input' };
  if (code === 'accounting_not_found') return { status: 404, code, message: 'The accounting record is unavailable in this company.', retryable: false, recovery: 'refresh_record' };
  if (code.endsWith('_conflict') || code === 'accounting_allocation_exceeded') return { status: 409, code, message: 'The accounting record or its available amount changed. Refresh it before editing.', retryable: false, recovery: 'refresh_record' };
  if (code === 'quickbooks_rate_limited') return { status: 429, code, message: 'QuickBooks is busy. Wait before checking again.', retryable: true, recovery: 'wait' };
  const retryable = error instanceof QuickBooksIntegrationError && error.retryable;
  return { status: 503, code, message: 'Accounting data is temporarily unavailable.', retryable, recovery: retryable ? 'retry_same_operation' : 'wait' };
}
