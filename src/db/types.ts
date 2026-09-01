import type { ScoutRole, ScoutSignupRole } from '../domain/scoutRoles.js';
import type { ScoutTeam } from '../domain/scoutRoster.js';

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
  // Stable identity, authored once in config and never derived from the
  // division's display name -- see #31 Defect 1/Defect 2. displayName is
  // presentational only and may change without affecting this row's identity
  // or any managed_resources row that points at it.
  divisionKey: string;
  displayName: string;
  seasonId: number | null;
  roleId: string | null;
  captainAccessRoleId: string | null;
  categoryId: string | null;
  status: DivisionStatus;
  createdAt: string;
  updatedAt: string;
};

export type ScoutConfig = {
  guildId: string;
  authorizedRoleIds: string[];
  emojiByRole: Record<ScoutSignupRole, string | null>;
  timezone: string;
  createdAt: string;
  updatedAt: string;
};

export type ScoutSetupStatus = 'posting' | 'open' | 'roster_ready' | 'published' | 'cancelled' | 'posting_failed';

export type ScoutSetup = {
  id: number;
  guildId: string;
  divisionId: number;
  divisionKey: string;
  divisionDisplayName: string;
  createdBy: string;
  signupChannelId: string;
  resultsChannelId: string;
  divisionRoleId: string;
  emojiByRole: Record<ScoutRole, string> & { fill: string | null };
  signupMessageId: string | null;
  resultMessageId: string | null;
  startAt: number;
  roleLimit: number;
  note: string | null;
  status: ScoutSetupStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ScoutSignup = {
  id: number;
  setupId: number;
  userId: string;
  role: ScoutSignupRole;
  createdAt: string;
};

export type ScoutRosterSlotRecord = {
  id: number;
  setupId: number;
  team: ScoutTeam;
  role: ScoutRole;
  userId: string;
  staffAssigned: boolean;
  createdAt: string;
  updatedAt: string;
};
