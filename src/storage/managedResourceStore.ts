import type {
  ManagedResource,
  ManagedResourceScaffoldDomain,
  ManagedResourceStatus,
  ManagedResourceType,
} from '../db/types.js';

export type InsertManagedResourceInput = {
  discordResourceId: string;
  guildId: string;
  resourceType: ManagedResourceType;
  logicalKey: string;
  parentResourceId?: string | null;
  scaffoldDomain: ManagedResourceScaffoldDomain;
  scaffoldVersion?: string | null;
};

export interface ManagedResourceStore {
  getActiveManagedResourceByLogicalKey(guildId: string, logicalKey: string): Promise<ManagedResource | undefined>;
  listManagedResourcesByDomain(
    guildId: string,
    scaffoldDomain: ManagedResourceScaffoldDomain,
    status?: ManagedResourceStatus,
  ): Promise<ManagedResource[]>;
  insertManagedResource(input: InsertManagedResourceInput): Promise<ManagedResource>;
  markManagedResourceObsolete(id: number): Promise<void>;
}
