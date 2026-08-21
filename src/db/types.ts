export type ManagedResourceType = 'role' | 'category' | 'text_channel' | 'voice_channel';

export type ManagedResourceScaffoldDomain = 'server' | 'season' | 'division';

export type ManagedResourceStatus = 'active' | 'obsolete';

export type ManagedResource = {
  id: number;
  discordResourceId: string;
  guildId: string;
  resourceType: ManagedResourceType;
  logicalKey: string;
  parentResourceId: string | null;
  scaffoldDomain: ManagedResourceScaffoldDomain;
  scaffoldVersion: string | null;
  status: ManagedResourceStatus;
  createdAt: string;
  updatedAt: string;
};

export type SeasonStatus = 'active' | 'inactive' | 'archived';

export type Season = {
  id: number;
  guildId: string;
  seasonNumber: number;
  displayName: string | null;
  categoryName: string;
  discordCategoryId: string | null;
  status: SeasonStatus;
  createdAt: string;
  archivedAt: string | null;
};

export type DivisionStatus = 'active' | 'archived';

export type DivisionRecord = {
  id: number;
  guildId: string;
  divisionName: string;
  seasonId: number | null;
  roleId: string | null;
  captainAccessRoleId: string | null;
  categoryId: string | null;
  status: DivisionStatus;
  createdAt: string;
  updatedAt: string;
};
