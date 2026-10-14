import type { Guild, GuildMember } from 'discord.js';
import type { DivisionRecord, ScoutConfig, ScoutSetup } from '../db/types.js';

import type Database from 'better-sqlite3';
import { resolveFranchiseRepresentativeId } from './scoutRoleIdentity.js';
import { getDivisionByKey, getScoutConfig } from '../db/index.js';
import { getInhouseConfig } from '../db/repositories/inhouse.js';

export async function canHostInhouse(db: Database.Database, guild: Guild, userId: string): Promise<boolean> {
  const config = getInhouseConfig(db, guild.id);
  if (!config?.roleId || !config.channelId) return false;
  const member = await guild.members.fetch({ user: userId, force: true });
  return !member.user.bot && member.roles.cache.has(config.roleId);
}

export async function canManageScoutSetup(db: Database.Database, guild: Guild, userId: string,
  setup: ScoutSetup, requireActiveDivision = true): Promise<boolean> {
  if (setup.guildId !== guild.id) return false;
  if (setup.workflow === 'inhouse') {
    const config = getInhouseConfig(db, guild.id);
    return Boolean(config?.roleId && config.channelId && setup.createdBy === userId
      && setup.divisionId === null && setup.eligibilityRoleId === null
      && setup.divisionRoleId === config.roleId
      && [setup.signupChannelId, setup.resultsChannelId, setup.operationsChannelId].every(id => id === config.channelId)
      && await canHostInhouse(db, guild, userId));
  }
  const division = getDivisionByKey(db, setup.guildId, setup.divisionKey);
  if (!division || division.id !== setup.divisionId || (requireActiveDivision && division.status !== 'active')) return false;
  const member = await guild.members.fetch(userId);
  const { hasAccess } = await import('./authorization.js');
  return hasScoutDivisionManagementAccess(db, member, getScoutConfig(db, guild.id), division, hasAccess(member, 'OPERATIONS'));
}

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
