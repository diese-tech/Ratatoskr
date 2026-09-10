import type {
  ManagedResource,
  ManagedResourceScaffoldDomain,
  ManagedResourceStatus,
  ManagedResourceType,
  Season,
} from '../db/types.js';

export type CreateSeasonInput = {
  guildId: string;
  seasonNumber: number;
  displayName?: string | null;
};

export type InsertManagedResourceInput = {
  discordResourceId: string;
  guildId: string;
  resourceType: ManagedResourceType;
  logicalKey: string;
  parentResourceId?: string | null;
  scaffoldDomain: ManagedResourceScaffoldDomain;
  scaffoldVersion?: string | null;
};

export class SeasonAlreadyActiveError extends Error {
  constructor(public readonly activeSeasonNumber: number) {
    super(`Season ${activeSeasonNumber} is already active for this guild`);
    this.name = 'SeasonAlreadyActiveError';
  }
}

// This is the first asynchronous vertical storage boundary in B5. It covers
// every database operation used by /season so the command is independent of
// better-sqlite3's synchronous connection and statement APIs. Later B5 slices
// will move the remaining command/service workflows behind equivalent stores.
export interface SeasonWorkspaceStore {
  createSeason(input: CreateSeasonInput): Promise<Season>;
  getSeasonByNumber(guildId: string, seasonNumber: number): Promise<Season | undefined>;
  getActiveSeason(guildId: string): Promise<Season | undefined>;
  archiveSeason(guildId: string, seasonId: number): Promise<Season | undefined>;
  listSeasons(guildId: string): Promise<Season[]>;
  activateSeasonIfNoneActive(guildId: string, seasonId: number): Promise<Season>;
  setSeasonDiscordCategoryId(seasonId: number, discordCategoryId: string): Promise<void>;
  getActiveManagedResourceByLogicalKey(guildId: string, logicalKey: string): Promise<ManagedResource | undefined>;
  listManagedResourcesByDomain(
    guildId: string,
    scaffoldDomain: ManagedResourceScaffoldDomain,
    status?: ManagedResourceStatus,
  ): Promise<ManagedResource[]>;
  insertManagedResource(input: InsertManagedResourceInput): Promise<ManagedResource>;
  markManagedResourceObsolete(id: number): Promise<void>;
}
