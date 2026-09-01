import type { DivisionRecord, ManagedResource } from '../db/types.js';
import { divisionChannelLogicalKey } from './divisionScaffold.js';

export type ScoutChannelPurpose = 'signups' | 'results';

export type ScoutChannelScope = {
  divisionId: number;
  divisionKey: string;
  purpose: ScoutChannelPurpose;
  channelId: string;
};

export type ScoutChannelGroup = {
  divisionId: number;
  divisionKey: string;
  signupChannelId: string;
  resultsChannelId: string;
};

export type ResolveScoutChannelScopeInput = {
  guildId: string;
  channelId: string;
  divisions: readonly DivisionRecord[];
  managedResources: readonly ManagedResource[];
  liveChannels: ReadonlyMap<
    string,
    { resourceType: Extract<ManagedResource['resourceType'], 'text_channel' | 'voice_channel'>; parentId: string | null }
  >;
};

export type ResolveScoutChannelGroupForDivisionInput = Omit<ResolveScoutChannelScopeInput, 'channelId'> & {
  divisionKey: string;
  operationsCategoryId: string;
};

const SCOUT_CHANNEL_KEYS: Readonly<Record<ScoutChannelPurpose, string>> = {
  signups: 'scout_signups',
  results: 'scout_results',
};

/** Resolve one live managed Discord channel to its active division scout scope. */
export function resolveScoutChannelScope(input: ResolveScoutChannelScopeInput): ScoutChannelScope | undefined {
  const liveChannel = input.liveChannels.get(input.channelId);
  if (!liveChannel || liveChannel.resourceType !== 'text_channel') return undefined;

  const matches: ScoutChannelScope[] = [];

  for (const division of input.divisions) {
    if (division.guildId !== input.guildId || division.status !== 'active' || !division.categoryId) continue;

    for (const purpose of Object.keys(SCOUT_CHANNEL_KEYS) as ScoutChannelPurpose[]) {
      const logicalKey = divisionChannelLogicalKey(division.divisionKey, SCOUT_CHANNEL_KEYS[purpose], 'text_channel');
      const resource = input.managedResources.find(
        (candidate) =>
          candidate.guildId === input.guildId &&
          candidate.discordResourceId === input.channelId &&
          candidate.resourceType === 'text_channel' &&
          candidate.scaffoldDomain === 'division' &&
          candidate.status === 'active' &&
          candidate.logicalKey === logicalKey &&
          candidate.parentResourceId === division.categoryId &&
          liveChannel.parentId === division.categoryId,
      );

      if (resource) {
        matches.push({
          divisionId: division.id,
          divisionKey: division.divisionKey,
          purpose,
          channelId: resource.discordResourceId,
        });
      }
    }
  }

  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveScoutChannelGroup(
  input: Omit<ResolveScoutChannelScopeInput, 'channelId'> & { sourceChannelId: string },
): ScoutChannelGroup | undefined {
  const source = resolveScoutChannelScope({ ...input, channelId: input.sourceChannelId });
  if (!source || source.purpose !== 'signups') return undefined;

  const division = input.divisions.find(
    (candidate) => candidate.id === source.divisionId && candidate.guildId === input.guildId && candidate.status === 'active',
  );
  if (!division?.categoryId) return undefined;

  const resultsLogicalKey = divisionChannelLogicalKey(source.divisionKey, SCOUT_CHANNEL_KEYS.results, 'text_channel');
  const results = input.managedResources.filter(
    (candidate) => {
      const liveChannel = input.liveChannels.get(candidate.discordResourceId);
      return (
        candidate.guildId === input.guildId &&
        candidate.resourceType === 'text_channel' &&
        candidate.scaffoldDomain === 'division' &&
        candidate.status === 'active' &&
        candidate.logicalKey === resultsLogicalKey &&
        candidate.parentResourceId === division.categoryId &&
        liveChannel?.resourceType === 'text_channel' &&
        liveChannel.parentId === division.categoryId
      );
    },
  );

  if (results.length !== 1) return undefined;

  return {
    divisionId: source.divisionId,
    divisionKey: source.divisionKey,
    signupChannelId: source.channelId,
    resultsChannelId: results[0]!.discordResourceId,
  };
}

export function resolveScoutChannelGroupForDivision(
  input: ResolveScoutChannelGroupForDivisionInput,
): ScoutChannelGroup | undefined {
  const division = input.divisions.find(
    (candidate) =>
      candidate.guildId === input.guildId &&
      candidate.divisionKey === input.divisionKey &&
      candidate.status === 'active',
  );
  if (!division) return undefined;

  const resolvePurpose = (purpose: ScoutChannelPurpose): ManagedResource | undefined => {
    const logicalKey = divisionChannelLogicalKey(
      division.divisionKey,
      SCOUT_CHANNEL_KEYS[purpose],
      'text_channel',
    );
    const matches = input.managedResources.filter((candidate) => {
      const liveChannel = input.liveChannels.get(candidate.discordResourceId);
      return (
        candidate.guildId === input.guildId &&
        candidate.resourceType === 'text_channel' &&
        candidate.scaffoldDomain === 'division' &&
        candidate.status === 'active' &&
        candidate.logicalKey === logicalKey &&
        candidate.parentResourceId === input.operationsCategoryId &&
        liveChannel?.resourceType === 'text_channel' &&
        liveChannel.parentId === input.operationsCategoryId
      );
    });
    return matches.length === 1 ? matches[0] : undefined;
  };

  const signups = resolvePurpose('signups');
  const results = resolvePurpose('results');
  if (!signups || !results) return undefined;

  return {
    divisionId: division.id,
    divisionKey: division.divisionKey,
    signupChannelId: signups.discordResourceId,
    resultsChannelId: results.discordResourceId,
  };
}
