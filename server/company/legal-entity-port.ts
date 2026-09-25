import type { OperationReceipt } from "../../shared/company";
import type { LegalEntityCommandKind } from "../../shared/company/legal-entity-contracts";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { executeLegalEntityCommand, type LegalEntityCommandExecutionOptions } from "./legal-entity-commands";

export interface CompanyLegalEntityPort {
  execute(kind: LegalEntityCommandKind, envelope: unknown, options: LegalEntityCommandExecutionOptions): Promise<OperationReceipt>;
}

export function createCompanyLegalEntityPort(executor: RentOpsQueryExecutor): CompanyLegalEntityPort {
  return {
    execute: (kind, envelope, options) => executeLegalEntityCommand(executor, kind, envelope, options),
  };
}
