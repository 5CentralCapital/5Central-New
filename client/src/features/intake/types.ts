import type { IntakePage, MraPacketReadModel } from "@shared/intake";

export interface IntakeListFilter {
  readonly legalEntityId?: string;
  readonly propertyId?: string;
}

export interface IntakeApi {
  listPackets(organizationId: string, scope?: IntakeListFilter, cursor?: string, signal?: AbortSignal): Promise<IntakePage>;
  getPacket(organizationId: string, packetId: string, signal?: AbortSignal): Promise<MraPacketReadModel>;
}

export interface IntakeResultsProps {
  readonly organizationId: string;
  readonly organizationName?: string;
  readonly legalEntityId?: string;
  readonly propertyId?: string;
  readonly api?: IntakeApi;
  readonly initialPacketId?: string;
}
