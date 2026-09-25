import {
  mraPacketRecordSchema,
  mraPacketReadModelSchema,
  mraPacketCandidateSchema,
  intakeLineRecordSchema,
  type IntakeLineRecord,
  type IntakePage,
  type IntakeSourceObject,
  type MraPacketRecord,
} from "../../shared/intake";
import { companyScopeSchema, documentReferenceIdSchema, isoTimestampSchema, type CompanyScope } from "../../shared/company";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";

export interface IntakeSourceLineMatch {
  readonly packetId: string;
  readonly checksumSha256: string;
  readonly outcome: string;
  readonly sourceRevision: string;
}

export interface IntakeStore {
  create(packet: MraPacketRecord, executor?: RentOpsQueryExecutor): Promise<void>;
  get(scope: CompanyScope, packetId: string, executor?: RentOpsQueryExecutor): Promise<MraPacketRecord | undefined>;
  findBySource(scope: CompanyScope, checksumSha256: string, executor?: RentOpsQueryExecutor): Promise<MraPacketRecord | undefined>;
  save(packet: MraPacketRecord, expectedRevision: number, executor?: RentOpsQueryExecutor): Promise<void>;
  recordLines(packet: MraPacketRecord, lines: readonly IntakeLineRecord[], executor?: RentOpsQueryExecutor): Promise<void>;
  /** Latest observation of a source line in another packet (the current packet is excluded). */
  findLine(scope: CompanyScope, sourceLineKey: string, executor?: RentOpsQueryExecutor, excludePacketId?: string): Promise<IntakeSourceLineMatch | undefined>;
  list(scope: CompanyScope, cursor: string | undefined, limit: number, executor?: RentOpsQueryExecutor): Promise<IntakePage>;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("intake_store_json_invalid");
  return value as Record<string, unknown>;
}

/** PostgreSQL drivers return timestamptz as Date objects; normalize to canonical UTC ISO text. */
function timestampText(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const text = String(value);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && !/Z$/.test(text) ? new Date(parsed).toISOString() : text;
}

function parsePacket(row: Record<string, unknown>): MraPacketRecord {
  const source: IntakeSourceObject = {
    documentId: documentReferenceIdSchema.parse(String(row.source_document_id)),
    fileName: String(row.source_file_name),
    declaredContentType: String(row.source_content_type),
    sizeBytes: typeof row.source_size_bytes === "number" ? row.source_size_bytes : Number(row.source_size_bytes),
    checksumSha256: String(row.source_checksum_sha256),
    backend: String(row.source_backend),
    logicalKey: String(row.source_logical_key),
    ...(row.source_immutable_generation ? { immutableGeneration: String(row.source_immutable_generation) } : {}),
    ...(row.source_immutable_version ? { immutableVersion: String(row.source_immutable_version) } : {}),
    verifiedAt: isoTimestampSchema.parse(timestampText(row.source_verified_at)),
  };
  const candidateJson = mraPacketCandidateSchema.parse(row.candidate_json);
  const linesJson = Array.isArray(row.lines_json) ? row.lines_json : [];
  const record = {
    id: String(row.id),
    scope: companyScopeSchema.parse({ organizationId: row.organization_id, ...(row.legal_entity_id ? { legalEntityId: row.legal_entity_id } : {}), ...(row.property_id ? { propertyId: row.property_id } : {}) }),
    state: row.state,
    source,
    candidate: candidateJson,
    lines: linesJson.map((line) => intakeLineRecordSchema.parse(line)),
    reconciliation: row.reconciliation_json ?? null,
    createdAt: isoTimestampSchema.parse(timestampText(row.created_at)),
    updatedAt: isoTimestampSchema.parse(timestampText(row.updated_at)),
    mappedAt: row.mapped_at ? isoTimestampSchema.parse(timestampText(row.mapped_at)) : null,
    previewedAt: row.previewed_at ? isoTimestampSchema.parse(timestampText(row.previewed_at)) : null,
    appliedAt: row.applied_at ? isoTimestampSchema.parse(timestampText(row.applied_at)) : null,
    revision: typeof row.record_revision === "number" ? row.record_revision : Number(row.record_revision),
  };
  return mraPacketRecordSchema.parse(record);
}

function parseJsonColumn(row: Record<string, unknown>, key: string): unknown {
  const value = row[key];
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { throw new Error(`intake_store_${key}_invalid`); }
}

function decodeCursor(value: string | undefined): { updatedAt: string; id: string } | undefined {
  if (!value) return undefined;
  try {
    const parsed = jsonRecord(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (typeof parsed.updatedAt !== "string" || typeof parsed.id !== "string") throw new Error();
    return { updatedAt: parsed.updatedAt, id: parsed.id };
  } catch { throw new Error("intake_cursor_invalid"); }
}

function encodeCursor(updatedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ updatedAt, id }), "utf8").toString("base64url");
}

export class SqlIntakeStore implements IntakeStore {
  constructor(private readonly executor: RentOpsQueryExecutor) {}

  private use(executor?: RentOpsQueryExecutor): RentOpsQueryExecutor { return executor ?? this.executor; }

  async create(packet: MraPacketRecord, executor?: RentOpsQueryExecutor): Promise<void> {
    const db = this.use(executor);
    await db.query(
      `INSERT INTO company_intake_packets
        (id, organization_id, legal_entity_id, property_id, state,
         source_document_id, source_file_name, source_content_type,
         source_size_bytes, source_checksum_sha256, source_backend,
         source_logical_key, source_immutable_generation, source_immutable_version,
         source_verified_at, candidate_json, lines_json, reconciliation_json,
         created_at, updated_at, mapped_at, previewed_at, applied_at, record_revision)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19,$20,$21,$22,$23,$24)`,
      [packet.id, packet.scope.organizationId, packet.scope.legalEntityId ?? null, packet.scope.propertyId ?? null, packet.state, packet.source.documentId, packet.source.fileName, packet.source.declaredContentType, packet.source.sizeBytes, packet.source.checksumSha256, packet.source.backend, packet.source.logicalKey, packet.source.immutableGeneration ?? null, packet.source.immutableVersion ?? null, packet.source.verifiedAt, JSON.stringify(packet.candidate), JSON.stringify(packet.lines), packet.reconciliation ? JSON.stringify(packet.reconciliation) : null, packet.createdAt, packet.updatedAt, packet.mappedAt, packet.previewedAt, packet.appliedAt, packet.revision],
    );
    await this.recordLines(packet, packet.lines, db);
  }

  async get(scope: CompanyScope, packetId: string, executor?: RentOpsQueryExecutor): Promise<MraPacketRecord | undefined> {
    const result = await this.use(executor).query<Record<string, unknown>>(
      `SELECT id, organization_id, legal_entity_id, property_id, state,
              source_document_id, source_file_name, source_content_type,
              source_size_bytes, source_checksum_sha256, source_backend,
              source_logical_key, source_immutable_generation, source_immutable_version,
              source_verified_at, candidate_json, lines_json, reconciliation_json,
              created_at, updated_at, mapped_at, previewed_at, applied_at, record_revision
         FROM company_intake_packets
        WHERE organization_id=$1 AND id=$2`,
      [scope.organizationId, packetId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    row.candidate_json = parseJsonColumn(row, "candidate_json");
    row.lines_json = parseJsonColumn(row, "lines_json");
    row.reconciliation_json = parseJsonColumn(row, "reconciliation_json");
    return parsePacket(row);
  }

  async findBySource(scope: CompanyScope, checksumSha256: string, executor?: RentOpsQueryExecutor): Promise<MraPacketRecord | undefined> {
    const result = await this.use(executor).query<Record<string, unknown>>(
      `SELECT id, organization_id, legal_entity_id, property_id, state,
              source_document_id, source_file_name, source_content_type,
              source_size_bytes, source_checksum_sha256, source_backend,
              source_logical_key, source_immutable_generation, source_immutable_version,
              source_verified_at, candidate_json, lines_json, reconciliation_json,
              created_at, updated_at, mapped_at, previewed_at, applied_at, record_revision
         FROM company_intake_packets
        WHERE organization_id=$1 AND source_checksum_sha256=$2
        ORDER BY created_at DESC LIMIT 1`,
      [scope.organizationId, checksumSha256],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    row.candidate_json = parseJsonColumn(row, "candidate_json");
    row.lines_json = parseJsonColumn(row, "lines_json");
    row.reconciliation_json = parseJsonColumn(row, "reconciliation_json");
    return parsePacket(row);
  }

  async save(packet: MraPacketRecord, expectedRevision: number, executor?: RentOpsQueryExecutor): Promise<void> {
    const db = this.use(executor);
    const result = await db.query(
      `UPDATE company_intake_packets
          SET state=$1, candidate_json=$2::jsonb, lines_json=$3::jsonb,
              reconciliation_json=$4::jsonb, updated_at=$5, mapped_at=$6,
              previewed_at=$7, applied_at=$8, record_revision=record_revision+1
        WHERE organization_id=$9 AND id=$10 AND record_revision=$11
        RETURNING id`,
      [packet.state, JSON.stringify(packet.candidate), JSON.stringify(packet.lines), packet.reconciliation ? JSON.stringify(packet.reconciliation) : null, packet.updatedAt, packet.mappedAt, packet.previewedAt, packet.appliedAt, packet.scope.organizationId, packet.id, expectedRevision],
    );
    if (result.rows.length !== 1) throw new Error("intake_revision_conflict");
    await this.recordLines(packet, packet.lines, db);
  }

  async recordLines(packet: MraPacketRecord, lines: readonly IntakeLineRecord[], executor?: RentOpsQueryExecutor): Promise<void> {
    const db = this.use(executor);
    for (const line of lines) {
      await db.query(
        `INSERT INTO company_intake_line_registry
          (organization_id, source_line_key, packet_id, source_checksum_sha256,
           source_revision, outcome, observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (organization_id, source_line_key, source_checksum_sha256)
         DO UPDATE SET outcome=EXCLUDED.outcome, observed_at=EXCLUDED.observed_at`,
        [packet.scope.organizationId, line.sourceLineKey, packet.id, packet.source.checksumSha256, line.sourceRevision, line.outcome ?? "matched", packet.updatedAt],
      );
    }
  }

  async findLine(scope: CompanyScope, sourceLineKey: string, executor?: RentOpsQueryExecutor, excludePacketId?: string): Promise<IntakeSourceLineMatch | undefined> {
    // Applied observations win over later held ones so a revision can never hide money already applied.
    const result = await this.use(executor).query<Record<string, unknown>>(
      `SELECT packet_id, source_checksum_sha256, outcome, source_revision
         FROM company_intake_line_registry
        WHERE organization_id=$1 AND source_line_key=$2 AND ($3::uuid IS NULL OR packet_id <> $3::uuid)
        ORDER BY (outcome = 'applied') DESC, observed_at DESC, packet_id DESC LIMIT 1`,
      [scope.organizationId, sourceLineKey, excludePacketId ?? null],
    );
    const row = result.rows[0];
    return row ? { packetId: String(row.packet_id), checksumSha256: String(row.source_checksum_sha256), outcome: String(row.outcome), sourceRevision: String(row.source_revision) } : undefined;
  }

  async list(scope: CompanyScope, cursorValue: string | undefined, limit: number, executor?: RentOpsQueryExecutor): Promise<IntakePage> {
    const db = this.use(executor);
    const pageCursor = decodeCursor(cursorValue);
    const values: unknown[] = [scope.organizationId];
    const clauses = ["organization_id=$1"];
    if (scope.legalEntityId) { values.push(scope.legalEntityId); clauses.push(`legal_entity_id=$${values.length}`); }
    if (scope.propertyId) { values.push(scope.propertyId); clauses.push(`property_id=$${values.length}`); }
    if (pageCursor) { values.push(pageCursor.updatedAt, pageCursor.id); clauses.push(`(updated_at,id)<($${values.length - 1},$${values.length})`); }
    values.push(Math.min(Math.max(limit, 1), 100) + 1);
    const rows = (await db.query<Record<string, unknown>>(
      `SELECT id, organization_id, legal_entity_id, property_id, state,
              source_document_id, source_file_name, source_content_type,
              source_size_bytes, source_checksum_sha256, source_backend,
              source_logical_key, source_immutable_generation, source_immutable_version,
              source_verified_at, candidate_json, lines_json, reconciliation_json,
              created_at, updated_at, mapped_at, previewed_at, applied_at, record_revision
         FROM company_intake_packets WHERE ${clauses.join(" AND ")}
         ORDER BY updated_at DESC, id DESC LIMIT $${values.length}`,
      values,
    )).rows;
    const pageRows = rows.slice(0, Math.min(Math.max(limit, 1), 100));
    const items: MraPacketRecord[] = [];
    for (const row of pageRows) {
      row.candidate_json = parseJsonColumn(row, "candidate_json");
      row.lines_json = parseJsonColumn(row, "lines_json");
      row.reconciliation_json = parseJsonColumn(row, "reconciliation_json");
      items.push(parsePacket(row));
    }
    const nextCursor = rows.length > pageRows.length && pageRows.length > 0 ? encodeCursor(timestampText(pageRows.at(-1)!.updated_at), String(pageRows.at(-1)!.id)) : null;
    return { items: items.map((item) => { const { candidate, ...rest } = item; return mraPacketReadModelSchema.parse({ ...rest, candidateWarnings: candidate.extractionWarnings }); }), nextCursor };
  }
}

export class MemoryIntakeStore implements IntakeStore {
  private readonly packets = new Map<string, MraPacketRecord>();
  private readonly observations = new Map<string, IntakeSourceLineMatch & { organizationId: string; sourceLineKey: string; sequence: number }>();
  private sequence = 0;

  async create(packet: MraPacketRecord): Promise<void> {
    if (this.packets.has(packet.id)) throw new Error("intake_duplicate_packet");
    this.packets.set(packet.id, structuredClone(packet));
    await this.recordLines(packet, packet.lines);
  }
  async get(scope: CompanyScope, packetId: string): Promise<MraPacketRecord | undefined> {
    const packet = this.packets.get(packetId);
    return packet && packet.scope.organizationId === scope.organizationId && (!scope.legalEntityId || packet.scope.legalEntityId === scope.legalEntityId) && (!scope.propertyId || packet.scope.propertyId === scope.propertyId) ? structuredClone(packet) : undefined;
  }
  async findBySource(scope: CompanyScope, checksumSha256: string): Promise<MraPacketRecord | undefined> {
    const values = Array.from(this.packets.values()).filter((packet) => packet.scope.organizationId === scope.organizationId && packet.source.checksumSha256 === checksumSha256).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return values[0] ? structuredClone(values[0]) : undefined;
  }
  async save(packet: MraPacketRecord, expectedRevision: number): Promise<void> {
    const current = this.packets.get(packet.id);
    if (!current || current.revision !== expectedRevision) throw new Error("intake_revision_conflict");
    this.packets.set(packet.id, structuredClone({ ...packet, revision: expectedRevision + 1 }));
    await this.recordLines(packet, packet.lines);
  }
  async recordLines(packet: MraPacketRecord, lines: readonly IntakeLineRecord[]): Promise<void> {
    for (const line of lines) {
      this.sequence += 1;
      this.observations.set(`${packet.scope.organizationId}\u0000${line.sourceLineKey}\u0000${packet.source.checksumSha256}`, {
        organizationId: packet.scope.organizationId, sourceLineKey: line.sourceLineKey, packetId: packet.id, checksumSha256: packet.source.checksumSha256,
        outcome: line.outcome ?? "matched", sourceRevision: line.sourceRevision, sequence: this.sequence,
      });
    }
  }
  async findLine(scope: CompanyScope, sourceLineKey: string, _executor?: RentOpsQueryExecutor, excludePacketId?: string): Promise<IntakeSourceLineMatch | undefined> {
    const matches = Array.from(this.observations.values()).filter(value => value.organizationId === scope.organizationId && value.sourceLineKey === sourceLineKey && value.packetId !== excludePacketId)
      .sort((left, right) => Number(right.outcome === "applied") - Number(left.outcome === "applied") || right.sequence - left.sequence);
    const value = matches[0];
    return value ? { packetId: value.packetId, checksumSha256: value.checksumSha256, outcome: value.outcome, sourceRevision: value.sourceRevision } : undefined;
  }
  async list(scope: CompanyScope, cursorValue: string | undefined, limit: number): Promise<IntakePage> {
    const cursor = decodeCursor(cursorValue);
    const all = Array.from(this.packets.values()).filter((packet) => packet.scope.organizationId === scope.organizationId && (!scope.legalEntityId || packet.scope.legalEntityId === scope.legalEntityId) && (!scope.propertyId || packet.scope.propertyId === scope.propertyId)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
    const after = cursor ? all.filter((packet) => packet.updatedAt < cursor.updatedAt || packet.updatedAt === cursor.updatedAt && packet.id < cursor.id) : all;
    const pageRows = after.slice(0, Math.min(Math.max(limit, 1), 100));
    const next = after.length > pageRows.length && pageRows.length > 0 ? pageRows.at(-1) : undefined;
    return { items: pageRows.map((item) => { const { candidate, ...rest } = structuredClone(item); return mraPacketReadModelSchema.parse({ ...rest, candidateWarnings: candidate.extractionWarnings }); }), nextCursor: next ? encodeCursor(next.updatedAt, next.id) : null };
  }
}
