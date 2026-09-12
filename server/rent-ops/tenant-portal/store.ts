import type { TenantAccountStatus } from "../../../shared/tenant-portal-contracts";
import type { RentOpsQueryExecutor } from "../repositories/postgres";

export interface TenantAccountRecord {
  id: string;
  email: string;
  personId: string;
  tenancyId: string;
  status: TenantAccountStatus;
  passwordHash: string | null;
  sessionVersion: number;
  activationTokenHash: string | null;
  invitationExpiresAt: string | null;
  createdAt: string;
  activatedAt: string | null;
}

export interface AuditedAccountMutation {
  action: "grant" | "reissue" | "revoke"; id: string; actorSubject: string; now: string;
  expectedCredentialRevision?: number; email?: string; personId?: string; tenancyId?: string; tokenHash?: string; expiresAt?: string;
}

export type AccountDeliveryOutcome = "accepted" | "failed" | "indeterminate";
export interface TenantAccountStore {
  issueAuditedDelivery?(input: {commandId:string;accountId:string;actorSubject:string;tokenHash:string;expiresAt:string;now:string}): Promise<TenantAccountRecord | undefined>;
  auditedDeliveryOutcome?(commandId:string): Promise<AccountDeliveryOutcome>;
  finishAuditedDelivery?(input:{commandId:string;accountId:string;actorSubject:string;outcome:AccountDeliveryOutcome;now:string}): Promise<void>;
  auditedMutation?(input: AuditedAccountMutation): Promise<TenantAccountRecord | undefined>;
  list(): Promise<TenantAccountRecord[]>;
  getById(id: string): Promise<TenantAccountRecord | undefined>;
  getByEmail(email: string): Promise<TenantAccountRecord | undefined>;
  create(input: { id: string; email: string; personId: string; tenancyId: string; tokenHash: string; expiresAt: string; now: string }): Promise<TenantAccountRecord | undefined>;
  rotateActivation(id: string, tokenHash: string, expiresAt: string, now: string): Promise<TenantAccountRecord | undefined>;
  issueRecovery(id: string, tokenHash: string, expiresAt: string, now: string): Promise<TenantAccountRecord | undefined>;
  invalidateToken(id: string, tokenHash: string): Promise<void>;
  consumeActivation(tokenHash: string, passwordHash: string, now: string): Promise<TenantAccountRecord | undefined>;
  changePassword(id: string, expectedVersion: number, passwordHash: string, now: string): Promise<TenantAccountRecord | undefined>;
  recordLogin(id: string, expectedVersion: number, now: string): Promise<TenantAccountRecord | undefined>;
  revoke(id: string, now: string): Promise<TenantAccountRecord | undefined>;
  consumeRateLimit(keyHash: string, limit: number, windowMs: number, now: string): Promise<boolean>;
}

const columns = `id, email, person_id AS "personId", tenancy_id AS "tenancyId", status,
  password_hash AS "passwordHash", session_version AS "sessionVersion",
  activation_token_hash AS "activationTokenHash", invitation_expires_at AS "invitationExpiresAt",
  created_at AS "createdAt", activated_at AS "activatedAt"`;

function record(row: Record<string, unknown> | undefined): TenantAccountRecord | undefined {
  if (!row) return undefined;
  const timestamp = (key: string): string | null => row[key] == null ? null : new Date(row[key] as string | Date).toISOString();
  return {
    id: String(row.id), email: String(row.email), personId: String(row.personId), tenancyId: String(row.tenancyId),
    status: row.status as TenantAccountStatus, passwordHash: row.passwordHash == null ? null : String(row.passwordHash),
    sessionVersion: Number(row.sessionVersion), activationTokenHash: row.activationTokenHash == null ? null : String(row.activationTokenHash),
    invitationExpiresAt: timestamp("invitationExpiresAt"), createdAt: timestamp("createdAt")!, activatedAt: timestamp("activatedAt"),
  };
}

/** Every credential transition uses one conditional SQL statement. A token
 * can be consumed once even when two requests arrive on different workers. */
export class PostgresTenantAccountStore implements TenantAccountStore {
  constructor(private readonly database: RentOpsQueryExecutor) {}

  private async one(sql: string, values: unknown[]): Promise<TenantAccountRecord | undefined> {
    return record((await this.database.query(sql, values)).rows[0]);
  }

  async issueAuditedDelivery(input:{commandId:string;accountId:string;actorSubject:string;tokenHash:string;expiresAt:string;now:string}) {
    return this.one(`WITH command AS (
      INSERT INTO rent_ops_activity_events (id,person_id,tenancy_id,type,occurred_at,actor,summary,metadata,
        person_link_knowledge,tenancy_link_knowledge,type_knowledge,occurred_at_knowledge,actor_knowledge,summary_knowledge)
      SELECT $1,person_id,tenancy_id,'system',$6,$3,'Tenant account access delivery requested',jsonb_build_object('accountId',id,'delivery','indeterminate'),
        'exact','exact','manual','manual','manual','manual' FROM rent_ops_tenant_accounts WHERE id=$2 AND status IN ('pending','active')
      ON CONFLICT(id) DO NOTHING RETURNING id), changed AS (
      UPDATE rent_ops_tenant_accounts SET activation_token_hash=$4,invitation_expires_at=$5,updated_at=$6
      WHERE id=$2 AND status IN ('pending','active') AND EXISTS(SELECT 1 FROM command) RETURNING ${columns})
      SELECT * FROM changed`,[input.commandId,input.accountId,input.actorSubject,input.tokenHash,input.expiresAt,input.now]);
  }
  async auditedDeliveryOutcome(commandId:string):Promise<AccountDeliveryOutcome> {
    const result=await this.database.query<{metadata:{delivery?:unknown}}>("SELECT metadata FROM rent_ops_activity_events WHERE id=$1",[commandId+"-outcome"]);
    const outcome=result.rows[0]?.metadata?.delivery;
    return outcome==="accepted"||outcome==="failed"?outcome:"indeterminate";
  }
  async finishAuditedDelivery(input:{commandId:string;accountId:string;actorSubject:string;outcome:AccountDeliveryOutcome;now:string}) {
    await this.database.query(`INSERT INTO rent_ops_activity_events (id,person_id,tenancy_id,type,occurred_at,actor,summary,metadata,
      person_link_knowledge,tenancy_link_knowledge,type_knowledge,occurred_at_knowledge,actor_knowledge,summary_knowledge)
      SELECT $1,person_id,tenancy_id,'system',$5,$3,'Tenant account access delivery outcome',jsonb_build_object('accountId',id,'delivery',$4::text),
      'exact','exact','manual','manual','manual','manual' FROM rent_ops_tenant_accounts WHERE id=$2 ON CONFLICT(id) DO NOTHING`,
      [input.commandId+"-outcome",input.accountId,input.actorSubject,input.outcome,input.now]);
  }

  async auditedMutation(input: AuditedAccountMutation): Promise<TenantAccountRecord | undefined> {
    const values: unknown[] = [input.id,input.actorSubject,input.now];
    let binding = "";
    let mutation: string;
    if(input.action === "grant") {
      if (!input.email || !input.personId || !input.tenancyId || !input.tokenHash || !input.expiresAt) return undefined;
      values.push(input.email,input.personId,input.tenancyId,input.tokenHash,input.expiresAt);
      binding = `binding AS MATERIALIZED (
        SELECT t.id AS tenancy_id, t.primary_person_id AS person_id
        FROM rent_ops_tenancies t
        JOIN rent_ops_people p ON p.id=t.primary_person_id
        JOIN rent_ops_properties pr ON pr.id=t.property_id
        JOIN rent_ops_units u ON u.id=t.unit_id AND u.property_id=t.property_id
        WHERE t.id=$6 AND t.primary_person_id=$5
          AND t.status IN ('current','notice','future')
          AND (t.operational_end_confirmed_on IS NULL OR t.operational_end_confirmed_on > ($3::timestamptz AT TIME ZONE 'America/New_York')::date)
          AND p.archived IS NOT TRUE
          AND (t.status_knowledge IN ('source','manual','confirmed') OR (t.source_system IS NULL AND t.status_knowledge IS NULL))
          AND (t.primary_person_link_knowledge IN ('exact','manual') OR (t.source_system IS NULL AND t.primary_person_link_knowledge IS NULL))
          AND (t.property_link_knowledge IN ('exact','manual') OR (t.source_system IS NULL AND t.property_link_knowledge IS NULL))
          AND (t.unit_link_knowledge IN ('exact','manual') OR (t.source_system IS NULL AND t.unit_link_knowledge IS NULL))
          AND (u.property_link_knowledge IN ('exact','manual') OR (u.source_system IS NULL AND u.property_link_knowledge IS NULL))
        FOR UPDATE OF t,p,pr,u
      )`;
      mutation = `INSERT INTO rent_ops_tenant_accounts (id,email,person_id,tenancy_id,status,activation_token_hash,invitation_expires_at,created_at,updated_at)
        SELECT $1,$4,binding.person_id,binding.tenancy_id,'pending',$7,$8,$3,$3 FROM binding
        ON CONFLICT DO NOTHING RETURNING ${columns}`;
    } else {
      if (input.action === "reissue" && (!input.personId || !input.tenancyId)) return undefined;
      values.push(input.expectedCredentialRevision,input.tokenHash??null,input.expiresAt??null);
      if (input.personId && input.tenancyId) {
        values.push(input.personId,input.tenancyId);
        binding = input.action === "reissue" ? `binding AS MATERIALIZED (
          SELECT a.id AS account_id
          FROM rent_ops_tenant_accounts a
          JOIN rent_ops_tenancies t ON t.id=a.tenancy_id AND t.id=$8 AND t.primary_person_id=$7
          JOIN rent_ops_people p ON p.id=t.primary_person_id
          JOIN rent_ops_properties pr ON pr.id=t.property_id
          JOIN rent_ops_units u ON u.id=t.unit_id AND u.property_id=t.property_id
          WHERE a.id=$1 AND a.person_id=$7 AND a.tenancy_id=$8
            AND t.status IS DISTINCT FROM 'cancelled'
            AND p.archived IS NOT TRUE
            AND (t.primary_person_link_knowledge IN ('exact','manual') OR (t.source_system IS NULL AND t.primary_person_link_knowledge IS NULL))
            AND (t.property_link_knowledge IN ('exact','manual') OR (t.source_system IS NULL AND t.property_link_knowledge IS NULL))
            AND (t.unit_link_knowledge IN ('exact','manual') OR (t.source_system IS NULL AND t.unit_link_knowledge IS NULL))
            AND (u.property_link_knowledge IN ('exact','manual') OR (u.source_system IS NULL AND u.property_link_knowledge IS NULL))
          FOR UPDATE OF a,t,p,pr,u
        )` : `binding AS MATERIALIZED (
          SELECT a.id AS account_id
          FROM rent_ops_tenant_accounts a
          JOIN rent_ops_tenancies t ON t.id=a.tenancy_id
          JOIN rent_ops_people p ON p.id=a.person_id
          WHERE a.id=$1 AND a.person_id=$7 AND a.tenancy_id=$8
          FOR UPDATE OF a,t,p
        )`;
        mutation = `UPDATE rent_ops_tenant_accounts a SET password_hash=NULL,status='${input.action === "revoke" ? "revoked" : "pending"}',
          activation_token_hash=$5,invitation_expires_at=$6,session_version=session_version+1,updated_at=$3
          FROM binding WHERE a.id=binding.account_id AND a.session_version=$4 RETURNING ${columns}`;
      } else {
        mutation = `UPDATE rent_ops_tenant_accounts SET password_hash=NULL,status='${input.action === "revoke" ? "revoked" : "pending"}',
          activation_token_hash=$5,invitation_expires_at=$6,session_version=session_version+1,updated_at=$3
          WHERE id=$1 AND session_version=$4 RETURNING ${columns}`;
      }
    }
    // One statement is atomic even for pooled executors: audit errors roll back
    // the credential mutation, and stale revisions produce neither mutation nor audit.
    return this.one(`WITH ${binding ? `${binding},` : ""} changed AS (${mutation}), audit AS (
      INSERT INTO rent_ops_activity_events (id,person_id,tenancy_id,type,occurred_at,actor,summary,metadata,
        person_link_knowledge,tenancy_link_knowledge,type_knowledge,occurred_at_knowledge,actor_knowledge,summary_knowledge)
      SELECT 'account-audit-' || md5(id || ':' || "sessionVersion"::text || ':${input.action}'), "personId", "tenancyId", 'system',$3,$2,
        'Tenant account ${input.action}',jsonb_build_object('accountId',id,'credentialRevision',"sessionVersion"),
        'exact','exact','manual','manual','manual','manual' FROM changed RETURNING id)
      SELECT changed.* FROM changed JOIN audit ON true`,values);
  }

  async list(): Promise<TenantAccountRecord[]> {
    return (await this.database.query(`SELECT ${columns} FROM rent_ops_tenant_accounts ORDER BY created_at DESC, id`)).rows.map((row) => record(row)!);
  }

  getById(id: string) { return this.one(`SELECT ${columns} FROM rent_ops_tenant_accounts WHERE id = $1`, [id]); }
  getByEmail(email: string) { return this.one(`SELECT ${columns} FROM rent_ops_tenant_accounts WHERE email = $1`, [email]); }

  create(input: { id: string; email: string; personId: string; tenancyId: string; tokenHash: string; expiresAt: string; now: string }) {
    return this.one(`INSERT INTO rent_ops_tenant_accounts
      (id, email, person_id, tenancy_id, status, activation_token_hash, invitation_expires_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $7) ON CONFLICT DO NOTHING RETURNING ${columns}`,
      [input.id, input.email, input.personId, input.tenancyId, input.tokenHash, input.expiresAt, input.now]);
  }

  rotateActivation(id: string, tokenHash: string, expiresAt: string, now: string) {
    return this.one(`UPDATE rent_ops_tenant_accounts SET
      password_hash = NULL, status = 'pending',
      activation_token_hash = $2, invitation_expires_at = $3, session_version = session_version + 1, updated_at = $4
      WHERE id = $1 RETURNING ${columns}`, [id, tokenHash, expiresAt, now]);
  }

  issueRecovery(id: string, tokenHash: string, expiresAt: string, now: string) {
    return this.one(`UPDATE rent_ops_tenant_accounts SET activation_token_hash = $2,
      invitation_expires_at = $3, updated_at = $4 WHERE id = $1 AND status IN ('pending', 'active') RETURNING ${columns}`,
      [id, tokenHash, expiresAt, now]);
  }

  async invalidateToken(id: string, tokenHash: string): Promise<void> {
    await this.database.query(`UPDATE rent_ops_tenant_accounts SET activation_token_hash = NULL, invitation_expires_at = NULL
      WHERE id = $1 AND activation_token_hash = $2`, [id, tokenHash]);
  }

  consumeActivation(tokenHash: string, passwordHash: string, now: string) {
    return this.one(`UPDATE rent_ops_tenant_accounts SET password_hash = $2, status = 'active',
      activation_token_hash = NULL, invitation_expires_at = NULL, session_version = session_version + 1,
      activated_at = COALESCE(activated_at, $3::timestamptz), updated_at = $3
      WHERE activation_token_hash = $1 AND invitation_expires_at > $3::timestamptz AND status IN ('pending', 'active')
      RETURNING ${columns}`, [tokenHash, passwordHash, now]);
  }

  changePassword(id: string, expectedVersion: number, passwordHash: string, now: string) {
    return this.one(`UPDATE rent_ops_tenant_accounts SET password_hash = $3, session_version = session_version + 1,
      activation_token_hash = NULL, invitation_expires_at = NULL, updated_at = $4
      WHERE id = $1 AND session_version = $2 AND status = 'active' RETURNING ${columns}`, [id, expectedVersion, passwordHash, now]);
  }

  recordLogin(id: string, expectedVersion: number, now: string) {
    return this.one(`UPDATE rent_ops_tenant_accounts SET last_login_at = $3
      WHERE id = $1 AND session_version = $2 AND status = 'active' RETURNING ${columns}`, [id, expectedVersion, now]);
  }

  revoke(id: string, now: string) {
    return this.one(`UPDATE rent_ops_tenant_accounts SET status = 'revoked', password_hash = NULL,
      activation_token_hash = NULL, invitation_expires_at = NULL, session_version = session_version + 1, updated_at = $2
      WHERE id = $1 RETURNING ${columns}`, [id, now]);
  }

  async consumeRateLimit(keyHash: string, limit: number, windowMs: number, now: string): Promise<boolean> {
    const cutoff = new Date(new Date(now).getTime() - windowMs).toISOString();
    const result = await this.database.query<{ attempts: number }>(`INSERT INTO rent_ops_tenant_auth_limits (key_hash, window_started_at, attempts)
      VALUES ($1, $2, 1) ON CONFLICT (key_hash) DO UPDATE SET
      attempts = CASE WHEN rent_ops_tenant_auth_limits.window_started_at <= $3::timestamptz THEN 1 ELSE LEAST(rent_ops_tenant_auth_limits.attempts + 1, 1000000) END,
      window_started_at = CASE WHEN rent_ops_tenant_auth_limits.window_started_at <= $3::timestamptz THEN $2::timestamptz ELSE rent_ops_tenant_auth_limits.window_started_at END
      RETURNING attempts`, [keyHash, now, cutoff]);
    // Bound stale limiter storage without exposing any address or email.
    await this.database.query(`DELETE FROM rent_ops_tenant_auth_limits WHERE key_hash IN
      (SELECT key_hash FROM rent_ops_tenant_auth_limits WHERE window_started_at < $1::timestamptz LIMIT 100)`,
      [new Date(new Date(now).getTime() - 24 * 60 * 60 * 1000).toISOString()]);
    return Number(result.rows[0]?.attempts ?? limit + 1) <= limit;
  }
}
