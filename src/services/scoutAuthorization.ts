import type { GuildMember } from 'discord.js';
import type { DivisionRecord, ScoutConfig, ScoutSetup } from '../db/types.js';

import type Database from 'better-sqlite3';
import { resolveFranchiseRepresentativeId } from './scoutRoleIdentity.js';

export type ScoutManagementAccessInput = {
  isAdmin: boolean;
  memberRoleIds: ReadonlySet<string>;
  additionalAuthorizedRoleIds: readonly string[];
  divisionCaptainRoleId: string | null;
  divisionManagerRoleId: string | null;
  franchiseRepresentativeRoleId: string | null;
};

export function hasScoutManagementAccess(input: ScoutManagementAccessInput): boolean {
  if (input.isAdmin) return true;
  if (input.additionalAuthorizedRoleIds.some((roleId) => input.memberRoleIds.has(roleId))) return true;
  if (
    input.franchiseRepresentativeRoleId &&
    input.memberRoleIds.has(input.franchiseRepresentativeRoleId)
  ) return true;
  return Boolean(
    (input.divisionCaptainRoleId && input.memberRoleIds.has(input.divisionCaptainRoleId)) ||
      (input.divisionManagerRoleId && input.memberRoleIds.has(input.divisionManagerRoleId)),
  );
}

export function hasScoutDivisionManagementAccess(
  db: Database.Database,
  member: GuildMember,
  config: ScoutConfig | undefined,
  division: Pick<DivisionRecord, 'managerRoleId' | 'captainRoleId'>,
  isAdmin: boolean,
): boolean {
  return hasScoutManagementAccess({
    isAdmin,
    memberRoleIds: new Set(member.roles.cache.keys()),
    additionalAuthorizedRoleIds: config?.authorizedRoleIds ?? [],
    divisionCaptainRoleId: division.captainRoleId,
    divisionManagerRoleId: division.managerRoleId,
    franchiseRepresentativeRoleId:
      resolveFranchiseRepresentativeId(db, member.guild),
  });
}

export function isScoutOperationsChannel(
  setup: Pick<ScoutSetup, 'operationsChannelId'>,
  channelId: string | null,
): boolean {
  return Boolean(setup.operationsChannelId && channelId === setup.operationsChannelId);
}

export function isScoutResultsChannel(
  setup: Pick<ScoutSetup, 'resultsChannelId'>,
  channelId: string | null,
): boolean {
  return channelId === setup.resultsChannelId;
}
