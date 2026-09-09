import type { AuditedAccountMutation, TenantAccountRecord, TenantAccountStore } from "./store";

/** Test dependency only. Production account routes require PostgreSQL. */
export class InMemoryTenantAccountStore implements TenantAccountStore {
  private readonly accounts = new Map<string, TenantAccountRecord>();
  readonly limits = new Map<string, { startedAt: number; attempts: number }>();
  readonly audits: Array<{ action: AuditedAccountMutation["action"]; accountId: string; actorSubject: string; credentialRevision: number }> = [];

  private copy(record: TenantAccountRecord | undefined) { return record ? structuredClone(record) : undefined; }
  async list() { return Array.from(this.accounts.values(), (record) => structuredClone(record)); }
  async getById(id: string) { return this.copy(this.accounts.get(id)); }
  async getByEmail(email: string) { return this.copy(Array.from(this.accounts.values()).find((row) => row.email === email)); }

  async auditedMutation(input: AuditedAccountMutation) {
    if (!input.actorSubject.trim()) throw new Error("actor required");
    if (input.action === "grant") {
      if (!input.email || !input.personId || !input.tenancyId || !input.tokenHash || !input.expiresAt) return undefined;
      if (this.accounts.has(input.id) || Array.from(this.accounts.values()).some((row) => row.email === input.email || row.tenancyId === input.tenancyId)) return undefined;
      const record: TenantAccountRecord = {
        id: input.id, email: input.email, personId: input.personId, tenancyId: input.tenancyId,
        status: "pending", passwordHash: null, sessionVersion: 1, activationTokenHash: input.tokenHash,
        invitationExpiresAt: input.expiresAt, createdAt: input.now, activatedAt: null,
      };
      this.accounts.set(record.id, record);
      this.audits.push({ action: input.action, accountId: record.id, actorSubject: input.actorSubject, credentialRevision: record.sessionVersion });
      return this.copy(record);
    }
    const current = this.accounts.get(input.id);
    if (!current || current.sessionVersion !== input.expectedCredentialRevision) return undefined;
    if (input.personId && current.personId !== input.personId) return undefined;
    if (input.tenancyId && current.tenancyId !== input.tenancyId) return undefined;
    const record: TenantAccountRecord = {
      ...current,
      passwordHash: null,
      status: input.action === "revoke" ? "revoked" : "pending",
      activationTokenHash: input.tokenHash ?? null,
      invitationExpiresAt: input.expiresAt ?? null,
      sessionVersion: current.sessionVersion + 1,
    };
    this.accounts.set(record.id, record);
    this.audits.push({ action: input.action, accountId: record.id, actorSubject: input.actorSubject, credentialRevision: record.sessionVersion });
    return this.copy(record);
  }

  async create(input: Parameters<TenantAccountStore["create"]>[0]) {
    if (this.accounts.has(input.id) || Array.from(this.accounts.values()).some((row) => row.email === input.email || row.tenancyId === input.tenancyId)) return undefined;
    const record: TenantAccountRecord = {
      id: input.id, email: input.email, personId: input.personId, tenancyId: input.tenancyId,
      status: "pending", passwordHash: null, sessionVersion: 1, activationTokenHash: input.tokenHash,
      invitationExpiresAt: input.expiresAt, createdAt: input.now, activatedAt: null,
    };
    this.accounts.set(record.id, record);
    return this.copy(record);
  }

  async rotateActivation(id: string, tokenHash: string, expiresAt: string, _now: string) {
    const record = this.accounts.get(id);
    if (!record) return undefined;
    record.passwordHash = null; record.status = "pending";
    record.activationTokenHash = tokenHash;
    record.invitationExpiresAt = expiresAt;
    record.sessionVersion++;
    return this.copy(record);
  }

  async issueRecovery(id: string, tokenHash: string, expiresAt: string, _now: string) {
    const record = this.accounts.get(id);
    if (!record || record.status === "revoked") return undefined;
    record.activationTokenHash = tokenHash; record.invitationExpiresAt = expiresAt;
    return this.copy(record);
  }
  async invalidateToken(id: string, tokenHash: string) {
    const record = this.accounts.get(id);
    if (record?.activationTokenHash === tokenHash) { record.activationTokenHash = null; record.invitationExpiresAt = null; }
  }

  async consumeActivation(tokenHash: string, passwordHash: string, now: string) {
    const record = Array.from(this.accounts.values()).find((row) => row.activationTokenHash === tokenHash
      && !!row.invitationExpiresAt && new Date(row.invitationExpiresAt).getTime() > new Date(now).getTime()
      && ["pending", "active"].includes(row.status));
    if (!record) return undefined;
    record.passwordHash = passwordHash;
    record.status = "active";
    record.activationTokenHash = null;
    record.invitationExpiresAt = null;
    record.activatedAt ??= now;
    record.sessionVersion++;
    return this.copy(record);
  }

  async changePassword(id: string, expectedVersion: number, passwordHash: string, _now: string) {
    const record = this.accounts.get(id);
    if (!record || record.status !== "active" || record.sessionVersion !== expectedVersion) return undefined;
    record.passwordHash = passwordHash;
    record.activationTokenHash = null;
    record.invitationExpiresAt = null;
    record.sessionVersion++;
    return this.copy(record);
  }

  async recordLogin(id: string, expectedVersion: number, _now: string) {
    const record = this.accounts.get(id);
    return record?.status === "active" && record.sessionVersion === expectedVersion ? this.copy(record) : undefined;
  }

  async revoke(id: string, _now: string) {
    const record = this.accounts.get(id);
    if (!record) return undefined;
    record.status = "revoked";
    record.passwordHash = null;
    record.activationTokenHash = null;
    record.invitationExpiresAt = null;
    record.sessionVersion++;
    return this.copy(record);
  }

  async consumeRateLimit(keyHash: string, limit: number, windowMs: number, now: string) {
    const timestamp = new Date(now).getTime();
    const old = this.limits.get(keyHash);
    const value = !old || old.startedAt <= timestamp - windowMs
      ? { startedAt: timestamp, attempts: 1 } : { ...old, attempts: old.attempts + 1 };
    this.limits.set(keyHash, value);
    return value.attempts <= limit;
  }
}
