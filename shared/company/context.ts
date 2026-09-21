import type { CommandRole } from './commands';

export interface CompanyContextUnit { id: string; unitNumber: string; }
export interface CompanyContextProperty { id: string; name: string; units: CompanyContextUnit[]; }
export interface CompanyContextEntity { id: string; name: string; currency: string; properties: CompanyContextProperty[]; }
export interface CompanyContextOrganization { id: string; name: string; role: CommandRole; entities: CompanyContextEntity[]; }
export interface CompanyContext { organizations: CompanyContextOrganization[]; }
