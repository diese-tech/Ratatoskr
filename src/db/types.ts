// 'emoji' is widened in now (#31 Defect/§7) because this migration already
// rebuilds the table for the status widening below -- adding it now avoids
// a second full-table rebuild later for a change already agreed to. No
// code writes emoji-typed rows yet; that lands with the future emoji/asset
// system. 'forum_channel' is deliberately not added: no current or
// approved YSL use case, and speculative enum expansion is exactly what
// #31 §34 rules out.
export type ManagedResourceType = 'role' | 'category' | 'text_channel' | 'voice_channel' | 'emoji';

export type ManagedResourceScaffoldDomain = 'server' | 'season' | 'division';

// 'archived' / 'purged' are widened in now (#31 Decision 1) but unused by
// any code yet -- they land with archive (#7) and a future purge command
// respectively. 'missing' is deliberately not a stored state: it describes
// Discord's current state, not Ratatoskr's intent, and would go stale the
// moment it's written -- it stays a runtime diagnostic instead.
export type ManagedResourceStatus = 'active' | 'obsolete' | 'archived' | 'purged';

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
