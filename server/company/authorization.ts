import { z } from "zod";
import {
  authenticatedPrincipalIdSchema,
  commandRoleSchema,
  companyScopeSchema,
  legalEntityIdSchema,
  organizationIdSchema,
  propertyReferenceIdSchema,
  type AuthenticatedPrincipalId,
  type CommandEnvelope,
  type CommandRole,
  type CompanyScope,
  type LegalEntityId,
  type OrganizationId,
  type PropertyReferenceId,
} from "../../shared/company";
import type { RentOpsQueryExecutor } from "../rent-ops/repositories/postgres";
import { CompanyCommandError, ForbiddenCommandError, ValidationCommandError } from "./commands/errors";

/** These values are also constrained by company_command_receipts.channel. */
export const COMPANY_COMMAND_CHANNELS = ["web", "mac", "codex_mcp"] as const;
export type CompanyCommandChannel = (typeof COMPANY_COMMAND_CHANNELS)[number];
export const companyCommandChannelSchema = z.enum(COMPANY_COMMAND_CHANNELS);

const principalScopeIds = <T extends z.ZodTypeAny>(item: T) => z.union([
  z.literal("all"),
  z.array(item).max(10_000).superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Authorized scope IDs must be unique" });
    }
  }),
]);

const capabilitySchema = z.string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9_.:-]*$/, "Capability must be a stable machine name");

/**
 * One grant is represented as a pair. Keeping the entity and property on the
 * same item prevents two independent ID lists from accidentally authorizing a
 * property under the wrong legal entity.
 */
export const principalScopeSchema = z.object({
  legalEntityId: legalEntityIdSchema.optional(),
  propertyId: propertyReferenceIdSchema.optional(),
}).strict().superRefine((scope, context) => {
  if (scope.propertyId !== undefined && scope.legalEntityId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["legalEntityId"],
      message: "A property grant must include its legal entity",
    });
  }
});

export type PrincipalScope = z.infer<typeof principalScopeSchema>;

const principalScopesSchema = z.array(principalScopeSchema).max(10_000).superRefine((values, context) => {
  const keys = values.map((scope) => `${scope.legalEntityId ?? "*"}\u0000${scope.propertyId ?? "*"}`);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Authorized grant scopes must be unique" });
  }
});

/**
 * This is created by an authenticated server adapter. It is deliberately a
 * separate type from the user-facing command envelope and from rental people.
 * The scope projections remain for callers migrating from the F01 shape; all
 * authorization decisions use authorizedScopes.
 */
export const authenticatedPrincipalSchema = z.object({
  actorId: authenticatedPrincipalIdSchema,
  organizationId: organizationIdSchema,
  role: commandRoleSchema,
  authorizedScopes: principalScopesSchema,
  authorizedLegalEntityIds: principalScopeIds(legalEntityIdSchema),
  authorizedPropertyIds: principalScopeIds(propertyReferenceIdSchema),
  capabilities: z.array(capabilitySchema).max(100),
}).strict();

export type AuthenticatedPrincipal = z.infer<typeof authenticatedPrincipalSchema>;
const trustedPrincipals = new WeakSet<object>();

export interface PrincipalScopeInput {
  readonly legalEntityId?: LegalEntityId | string;
  readonly propertyId?: PropertyReferenceId | string;
}

export interface AuthenticatedPrincipalInput {
  readonly actorId: AuthenticatedPrincipalId | string;
  readonly organizationId: OrganizationId | string;
  readonly role: CommandRole;
  /** Prefer this paired representation for grants loaded from the database. */
  readonly authorizedScopes?: readonly PrincipalScopeInput[];
  /** F01 compatibility projection. Ambiguous unequal arrays are rejected. */
  readonly authorizedLegalEntityIds?: "all" | readonly (LegalEntityId | string)[];
  /** F01 compatibility projection. Ambiguous unequal arrays are rejected. */
  readonly authorizedPropertyIds?: "all" | readonly (PropertyReferenceId | string)[];
  readonly capabilities?: readonly string[];
}

function uniqueStrings<T extends string>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

function deriveScopesFromLegacyIds(input: AuthenticatedPrincipalInput): PrincipalScope[] {
  const legal = input.authorizedLegalEntityIds ?? [];
  const property = input.authorizedPropertyIds ?? [];
  if (legal === "all") {
    if (property === "all" || property.length === 0) return [{}];
    throw new ValidationCommandError("Property IDs cannot be paired with an all-entity grant", { reason: "ambiguous_grant_scope" });
  }
  const legalIds = legal.map((value) => legalEntityIdSchema.parse(value));
  if (property === "all") {
    if (legalIds.length === 0) {
      throw new ValidationCommandError("An all-property grant must name its legal entity", { reason: "ambiguous_grant_scope" });
    }
    return legalIds.map((legalEntityId) => ({ legalEntityId }));
  }
  const propertyIds = property.map((value) => propertyReferenceIdSchema.parse(value));
  if (legalIds.length === 0 && propertyIds.length !== 0) {
    throw new ValidationCommandError("Property grants must name a legal entity", { reason: "ambiguous_grant_scope" });
  }
  if (propertyIds.length === 0) return legalIds.map((legalEntityId) => ({ legalEntityId }));
  if (legalIds.length !== 1 || propertyIds.length !== 1) {
    throw new ValidationCommandError("Multiple property grants require explicit paired scope objects", { reason: "ambiguous_grant_scope" });
  }
  return [{ legalEntityId: legalIds[0], propertyId: propertyIds[0] }];
}

function scopeProjections(scopes: readonly PrincipalScope[]): Pick<AuthenticatedPrincipal, "authorizedLegalEntityIds" | "authorizedPropertyIds"> {
  if (scopes.some((scope) => scope.legalEntityId === undefined && scope.propertyId === undefined)) {
    return { authorizedLegalEntityIds: "all", authorizedPropertyIds: "all" };
  }
  return {
    authorizedLegalEntityIds: uniqueStrings(scopes.flatMap((scope) => scope.legalEntityId ? [scope.legalEntityId] : [])),
    authorizedPropertyIds: uniqueStrings(scopes.flatMap((scope) => scope.propertyId ? [scope.propertyId] : [])),
  };
}

function freezePrincipal(parsed: AuthenticatedPrincipal): AuthenticatedPrincipal {
  const scopes = Object.freeze(parsed.authorizedScopes.map((scope) => Object.freeze({ ...scope })));
  const legalEntityIds = parsed.authorizedLegalEntityIds === "all"
    ? "all"
    : Object.freeze([...parsed.authorizedLegalEntityIds]);
  const propertyIds = parsed.authorizedPropertyIds === "all"
    ? "all"
    : Object.freeze([...parsed.authorizedPropertyIds]);
  const capabilities = Object.freeze([...parsed.capabilities]);
  const principal = Object.freeze({
    ...parsed,
    authorizedScopes: scopes,
    authorizedLegalEntityIds: legalEntityIds,
    authorizedPropertyIds: propertyIds,
    capabilities,
  });
  trustedPrincipals.add(principal);
  return principal as unknown as AuthenticatedPrincipal;
}

export function createAuthenticatedPrincipal(input: AuthenticatedPrincipalInput): AuthenticatedPrincipal {
  if (input.authorizedScopes !== undefined && (input.authorizedLegalEntityIds !== undefined || input.authorizedPropertyIds !== undefined)) {
    throw new ValidationCommandError("Use paired grant scopes instead of mixing scope representations", { reason: "ambiguous_grant_scope" });
  }
  const scopes = input.authorizedScopes === undefined
    ? deriveScopesFromLegacyIds(input)
    : input.authorizedScopes.map((scope) => principalScopeSchema.parse(scope));
  const projections = scopeProjections(scopes);
  const principal = authenticatedPrincipalSchema.parse({
    actorId: input.actorId,
    organizationId: input.organizationId,
    role: input.role,
    authorizedScopes: scopes,
    ...projections,
    capabilities: input.capabilities ?? [],
  });
  return freezePrincipal(principal);
}

export const attestAuthenticatedPrincipal = createAuthenticatedPrincipal;

export const transportCapabilitySchema = capabilitySchema;

export interface TransportAttestation {
  readonly attested: true;
  readonly channel: CompanyCommandChannel;
  readonly capabilities: readonly string[];
}

const trustedTransports = new WeakSet<object>();

/** Construct this only from the already-authenticated server transport. */
export function attestTransport(
  channel: CompanyCommandChannel,
  capabilities: readonly string[] = [],
): TransportAttestation {
  const parsed = z.object({
    channel: companyCommandChannelSchema,
    capabilities: z.array(capabilitySchema).max(100),
  }).strict().parse({ channel, capabilities: [...capabilities] });
  const transport = Object.freeze({
    attested: true as const,
    channel: parsed.channel,
    capabilities: Object.freeze(parsed.capabilities),
  });
  trustedTransports.add(transport);
  return transport;
}

export type CommandScopeLevel = "organization" | "legal_entity" | "property";

export interface CommandAuthorizationPolicy {
  readonly commandKind: string;
  readonly allowedRoles: readonly CommandRole[];
  readonly requiredChannel?: CompanyCommandChannel;
  readonly requiredCapability?: string;
  /** If set, the command must be sent at exactly this scope level. */
  readonly requiredScope?: CommandScopeLevel;
}

const commandKindSchema = z.string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9_.-]*$/, "Command kind must be a stable machine name");

function assertPolicy(policy: CommandAuthorizationPolicy): void {
  try {
    commandKindSchema.parse(policy.commandKind);
    if (policy.allowedRoles.length === 0) {
      throw new ValidationCommandError("Command policy must name at least one role", { reason: "empty_role_policy" });
    }
    for (const role of policy.allowedRoles) commandRoleSchema.parse(role);
    if (policy.requiredChannel !== undefined) companyCommandChannelSchema.parse(policy.requiredChannel);
    if (policy.requiredCapability !== undefined) capabilitySchema.parse(policy.requiredCapability);
    if (policy.requiredScope !== undefined && !["organization", "legal_entity", "property"].includes(policy.requiredScope)) {
      throw new ValidationCommandError("Command policy has an unsupported scope level", { reason: "invalid_scope_policy" });
    }
  } catch (error) {
    if (error instanceof CompanyCommandError) throw error;
    if (error instanceof z.ZodError) {
      throw new ValidationCommandError("Command policy is invalid", { reason: "invalid_command_policy" });
    }
    throw error;
  }
}

function assertTransport(transport: TransportAttestation): void {
  if (!transport || typeof transport !== "object" || transport.attested !== true || !trustedTransports.has(transport)) {
    throw new ValidationCommandError("A server transport attestation is required", { reason: "transport_unattested" });
  }
  try {
    z.object({
      attested: z.literal(true),
      channel: companyCommandChannelSchema,
      capabilities: z.array(capabilitySchema).max(100),
    }).strict().parse(transport);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationCommandError("Transport attestation is invalid", { reason: "invalid_transport_attestation" });
    }
    throw error;
  }
}

function requestedScopeLevel(scope: CompanyScope): CommandScopeLevel {
  if (scope.propertyId !== undefined) return "property";
  if (scope.legalEntityId !== undefined) return "legal_entity";
  return "organization";
}

function grantMatchesScope(grant: PrincipalScope, requested: CompanyScope): boolean {
  // An organization grant covers every descendant scope.
  if (grant.legalEntityId === undefined) return true;
  // A restricted grant cannot be promoted to an organization operation.
  if (requested.legalEntityId === undefined || requested.legalEntityId !== grant.legalEntityId) return false;
  // An entity grant covers properties within that entity. A property grant is exact.
  return grant.propertyId === undefined || requested.propertyId === grant.propertyId;
}

function assertPrincipalScope(parsedPrincipal: AuthenticatedPrincipal, scope: CompanyScope): void {
  if (scope.propertyId !== undefined && scope.legalEntityId === undefined) {
    throw new ValidationCommandError("Property scope requires a legal entity", { reason: "property_scope_without_entity" });
  }
  if (!parsedPrincipal.authorizedScopes.some((grant) => grantMatchesScope(grant, scope))) {
    throw new ForbiddenCommandError("Requested company scope is not authorized", { reason: "scope_grant" });
  }
}

/**
 * Recheck all principal and transport restrictions at the command boundary.
 * The command body has no channel or actor field; both values come from these
 * trusted server-side arguments.
 */
export function authorizeCommand<TPayload>(
  principal: AuthenticatedPrincipal,
  transport: TransportAttestation,
  policy: CommandAuthorizationPolicy,
  envelope: CommandEnvelope<TPayload>,
): void {
  if (!principal || typeof principal !== "object" || !trustedPrincipals.has(principal)) {
    throw new ForbiddenCommandError("A trusted authenticated principal is required", { reason: "principal_untrusted" });
  }
  let parsedPrincipal: AuthenticatedPrincipal;
  try {
    parsedPrincipal = authenticatedPrincipalSchema.parse(principal);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationCommandError("Authenticated principal is invalid", { reason: "invalid_principal" });
    }
    throw error;
  }
  assertPolicy(policy);
  assertTransport(transport);
  let scope: CompanyScope;
  try {
    scope = companyScopeSchema.parse(envelope.scope) as CompanyScope;
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new ValidationCommandError("Command scope is invalid", { reason: "invalid_command_scope" });
    }
    throw error;
  }

  if (parsedPrincipal.organizationId !== scope.organizationId) {
    throw new ForbiddenCommandError("Command organization is outside the authenticated principal scope", { reason: "organization_scope" });
  }
  if (!policy.allowedRoles.includes(parsedPrincipal.role)) {
    throw new ForbiddenCommandError("Authenticated role cannot execute this command", { reason: "role", commandKind: policy.commandKind });
  }
  assertPrincipalScope(parsedPrincipal, scope);
  if (policy.requiredScope !== undefined && requestedScopeLevel(scope) !== policy.requiredScope) {
    throw new ForbiddenCommandError("Command scope level is not authorized by its policy", { reason: "scope_level", commandKind: policy.commandKind });
  }
  if (policy.requiredChannel !== undefined && transport.channel !== policy.requiredChannel) {
    throw new ForbiddenCommandError("Command is restricted to its attested transport", { reason: "channel", commandKind: policy.commandKind });
  }
  if (policy.requiredCapability !== undefined && !transport.capabilities.includes(policy.requiredCapability)) {
    throw new ForbiddenCommandError("Required transport capability is absent", { reason: "capability", commandKind: policy.commandKind });
  }
}

export interface LoadAuthenticatedPrincipalInput {
  readonly actorId: AuthenticatedPrincipalId | string;
  readonly organizationId: OrganizationId | string;
  /** The role is supplied by the trusted server session, never the command body. */
  readonly role: CommandRole;
  readonly capabilities?: readonly string[];
}

interface AccessGrantRow {
  readonly actor_id: unknown;
  readonly organization_id: unknown;
  readonly role: unknown;
  readonly legal_entity_id: unknown;
  readonly property_id: unknown;
}

/** Load active grants inside the command transaction for revocation-safe replay. */
export async function loadAuthenticatedPrincipal(
  executor: RentOpsQueryExecutor,
  input: LoadAuthenticatedPrincipalInput,
): Promise<AuthenticatedPrincipal> {
  const actorId = authenticatedPrincipalIdSchema.parse(input.actorId);
  const organizationId = organizationIdSchema.parse(input.organizationId);
  const role = commandRoleSchema.parse(input.role);
  const result = await executor.query<AccessGrantRow>(
    `SELECT actor_id, organization_id, role, legal_entity_id, property_id
       FROM company_access_grants
      WHERE actor_id = $1 AND organization_id = $2 AND role = $3 AND revoked_at IS NULL
      ORDER BY legal_entity_id NULLS FIRST, property_id NULLS FIRST`,
    [actorId, organizationId, role],
  );
  if (result.rows.length === 0) {
    throw new ForbiddenCommandError("Authenticated principal has no active company grant", { reason: "grant_missing" });
  }
  const scopes: PrincipalScopeInput[] = [];
  for (const row of result.rows) {
    if (row.actor_id !== actorId || row.organization_id !== organizationId || row.role !== role) {
      throw new ValidationCommandError("Company access storage returned a mismatched grant", { reason: "invalid_grant_row" });
    }
    const legalEntityId = row.legal_entity_id === null || row.legal_entity_id === undefined
      ? undefined
      : legalEntityIdSchema.parse(row.legal_entity_id);
    const propertyId = row.property_id === null || row.property_id === undefined
      ? undefined
      : propertyReferenceIdSchema.parse(row.property_id);
    if (propertyId !== undefined && legalEntityId === undefined) {
      throw new ValidationCommandError("Company access storage returned an unpaired property grant", { reason: "invalid_grant_row" });
    }
    scopes.push({ legalEntityId, propertyId });
  }
  return createAuthenticatedPrincipal({
    actorId,
    organizationId,
    role,
    authorizedScopes: scopes,
    capabilities: input.capabilities ?? [],
  });
}

export const MRA_INGESTION_POLICY: CommandAuthorizationPolicy = Object.freeze({
  commandKind: "mra_ingestion",
  allowedRoles: ["owner", "admin", "operations_pm"] as const,
  requiredChannel: "codex_mcp",
  requiredCapability: "mra_ingestion",
});

export function assertAuthorizedCommand<TPayload>(
  principal: AuthenticatedPrincipal,
  transport: TransportAttestation,
  policy: CommandAuthorizationPolicy,
  envelope: CommandEnvelope<TPayload>,
): void {
  authorizeCommand(principal, transport, policy, envelope);
}
