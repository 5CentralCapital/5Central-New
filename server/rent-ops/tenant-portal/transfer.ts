import type { RentOpsPortalAccountBinding, RentOpsPortalAccountTransfer } from "../../../shared/rent-ops-contracts";
import type { RentOpsQueryExecutor } from "../repositories/postgres";

const safeColumns = `id,person_id AS "personId",tenancy_id AS "tenancyId",status,session_version AS "sessionVersion"`;
export async function readPortalAccountBindings(executor: RentOpsQueryExecutor, personId: string): Promise<RentOpsPortalAccountBinding[]> {
  // Grants lock their tenancy before insertion. In the enclosing operator
  // transaction this also serializes the empty-account case with new grants.
  await executor.query(`SELECT id FROM rent_ops_tenancies WHERE primary_person_id=$1 ORDER BY id FOR UPDATE`, [personId]);
  return (await executor.query<RentOpsPortalAccountBinding>(`SELECT ${safeColumns} FROM rent_ops_tenant_accounts WHERE person_id=$1 ORDER BY id`, [personId])).rows;
}

/** Uses the caller's existing transaction. Never returns or modifies passwords,
 * tokens, email, access status, historical payments, lease or document bindings. */
export async function transferPortalAccountBinding(executor: RentOpsQueryExecutor, input: RentOpsPortalAccountTransfer): Promise<RentOpsPortalAccountBinding> {
  const { accountId, personId, oldTenancyId, newTenancyId, expectedSessionVersion, actorSubject, occurredAt, auditId } = input;
  if ([accountId, personId, oldTenancyId, newTenancyId, actorSubject, auditId].some(value => !value?.trim())
    || oldTenancyId === newTenancyId || !Number.isSafeInteger(expectedSessionVersion) || expectedSessionVersion < 1
    || !Number.isFinite(Date.parse(occurredAt))) throw new Error("Exact portal transfer identity, revision and audit context required");
  const tenancies = (await executor.query<{id:string;primary_person_id:string;property_id:string;unit_id:string;status:string;status_knowledge:string;operational_end_confirmed_on:string|null;operational_end_confirmation_knowledge:string|null;property_link_knowledge:string;unit_link_knowledge:string;primary_person_link_knowledge:string}>(
    `SELECT id,primary_person_id,property_id,unit_id,status,status_knowledge,operational_end_confirmed_on::text,operational_end_confirmation_knowledge,property_link_knowledge,unit_link_knowledge,primary_person_link_knowledge FROM rent_ops_tenancies WHERE id IN ($1,$2) ORDER BY id FOR UPDATE`, [oldTenancyId,newTenancyId])).rows;
  const old = tenancies.find(row => row.id === oldTenancyId), next = tenancies.find(row => row.id === newTenancyId);
  const exact = (value: string) => value === "manual" || value === "exact";
  if (!old || !next || old.primary_person_id !== personId || next.primary_person_id !== personId
    || old.property_id !== next.property_id || old.unit_id === next.unit_id || !old.operational_end_confirmed_on || old.operational_end_confirmed_on > occurredAt.slice(0,10) || old.operational_end_confirmation_knowledge !== "manual" || next.status !== "current"
    || next.status_knowledge !== "manual"
    || [old,next].some(row => !exact(row.property_link_knowledge) || !exact(row.unit_link_knowledge) || !exact(row.primary_person_link_knowledge))) {
    throw new Error("Portal transfer requires exact same-person ended/current manual tenancies in different units of the same property");
  }
  const accounts = (await executor.query<RentOpsPortalAccountBinding>(`SELECT ${safeColumns} FROM rent_ops_tenant_accounts WHERE person_id=$1 OR tenancy_id IN ($2,$3) ORDER BY id FOR UPDATE`, [personId,oldTenancyId,newTenancyId])).rows;
  const account = accounts[0];
  if (accounts.length !== 1 || account.id !== accountId || account.personId !== personId || account.tenancyId !== oldTenancyId || account.sessionVersion !== expectedSessionVersion) throw new Error("Portal transfer account binding changed or is ambiguous");
  await executor.query(`INSERT INTO rent_ops_activity_events(id,person_id,tenancy_id,type,occurred_at,actor,summary,metadata,person_link_knowledge,tenancy_link_knowledge,type_knowledge,occurred_at_knowledge,actor_knowledge,summary_knowledge)
    VALUES($1,$2,$3,'system',$4,$5,'Tenant portal account transferred to reviewed current tenancy',$6,'exact','exact','manual','manual','manual','manual')`,
    [auditId,personId,newTenancyId,occurredAt,actorSubject,JSON.stringify({action:"tenant_account_tenancy_transfer",accountId,oldTenancyId,newTenancyId,personId,expectedSessionVersion})]);
  const result = await executor.query<RentOpsPortalAccountBinding>(`UPDATE rent_ops_tenant_accounts SET tenancy_id=$4,session_version=session_version+1,updated_at=$6 WHERE id=$1 AND person_id=$2 AND tenancy_id=$3 AND session_version=$5 RETURNING ${safeColumns}`,
    [accountId,personId,oldTenancyId,newTenancyId,expectedSessionVersion,occurredAt]);
  if (result.rows.length !== 1) throw new Error("Portal transfer account revision changed");
  return result.rows[0];
}
