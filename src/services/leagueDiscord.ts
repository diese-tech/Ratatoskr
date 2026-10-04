import {
  ChannelType,
  EmbedBuilder,
  RESTJSONErrorCodes,
  type Guild,
  type GuildMember,
} from 'discord.js';
import { LeagueMutationValidationError, type DiscordLeagueMember, type DiscordRoleChange } from '../domain/leagueOperations.js';
import type { LeagueAnnouncement, LeagueDiscordPort, LeagueRoleState } from './leagueTransactions.js';

export class DiscordRoleReconciliationRequiredError extends Error {
  readonly reconciliationRequired = true;
}

type MemberReadOptions = {
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
};

const COMPLETE_MEMBER_CACHE_TTL_MS = 60_000;

function memberRateLimitDelayMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object' || !('data' in error)) return undefined;
  const data = error.data;
  if (!data || typeof data !== 'object' || !('opcode' in data) || !('retry_after' in data)) return undefined;
  if (data.opcode !== 8 || typeof data.retry_after !== 'number' || !Number.isFinite(data.retry_after)) return undefined;
  return Math.min(Math.max(Math.ceil(data.retry_after * 1_000) + 250, 250), 60_000);
}

async function fetchFreshMember(guild: Guild, discordId: string): Promise<GuildMember> {
  return guild.members.fetch({ user: discordId, force: true });
}

function roleSnapshot(member: GuildMember): DiscordLeagueMember {
  return { discordId: member.id, displayName: member.displayName, roleIds: [...member.roles.cache.keys()] };
}

function assertMemberRoleState(member: GuildMember, expected: LeagueRoleState): void {
  const assignedTeamRoles = expected.configuredTeamRoleIds.filter((roleId) => member.roles.cache.has(roleId));
  const teamRolesMatch = expected.expectedTeamRoleId
    ? assignedTeamRoles.length === 1 && assignedTeamRoles[0] === expected.expectedTeamRoleId
    : assignedTeamRoles.length === 0;
  const assignedDivisionRoles = expected.configuredDivisionRoleIds.filter((roleId) => member.roles.cache.has(roleId));
  const divisionRolesMatch = assignedDivisionRoles.length === 1 && assignedDivisionRoles[0] === expected.divisionRoleId;
  const freeAgentMatches = member.roles.cache.has(expected.freeAgentRoleId) === expected.expectsFreeAgent;
  if (!teamRolesMatch || !divisionRolesMatch || !freeAgentMatches) {
    throw new Error(`Discord member ${member.id} complete league role state changed before the transaction finished.`);
  }
}

export class DiscordLeagueGateway implements LeagueDiscordPort {
  private completeMemberSnapshotAt: number | undefined;
  private fullMemberFetch: Promise<void> | undefined;

  constructor(
    private readonly guild: Guild,
    private readonly transactionsChannelId: string,
    private readonly memberReadOptions: MemberReadOptions = {},
  ) {}

  private currentMembers(): DiscordLeagueMember[] {
    return this.guild.members.cache.filter((member) => !member.user.bot).map(roleSnapshot);
  }

  private async refreshCompleteMemberCache(): Promise<void> {
    if (!this.fullMemberFetch) {
      this.fullMemberFetch = (async () => {
        try {
          await this.guild.members.fetch();
        } catch (error) {
          const retryDelayMs = memberRateLimitDelayMs(error);
          if (retryDelayMs === undefined || this.completeMemberSnapshotAt !== undefined) throw error;
          const sleep = this.memberReadOptions.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
          await sleep(retryDelayMs);
          await this.guild.members.fetch();
        }
        this.completeMemberSnapshotAt = (this.memberReadOptions.now ?? Date.now)();
      })().finally(() => { this.fullMemberFetch = undefined; });
    }
    await this.fullMemberFetch;
  }

  private async transactionsChannel() {
    const channel = await this.guild.channels.fetch(this.transactionsChannelId);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guild.id !== this.guild.id) {
      throw new Error('The configured transactions channel is unavailable.');
    }
    return channel;
  }

  async getMembers(): Promise<DiscordLeagueMember[]> {
    const now = (this.memberReadOptions.now ?? Date.now)();
    if (this.completeMemberSnapshotAt !== undefined
      && now - this.completeMemberSnapshotAt <= COMPLETE_MEMBER_CACHE_TTL_MS) {
      return this.currentMembers();
    }
    try {
      await this.refreshCompleteMemberCache();
    } catch (error) {
      if (this.completeMemberSnapshotAt === undefined || memberRateLimitDelayMs(error) === undefined) throw error;
      console.warn('Discord rate-limited a full league member refresh; using the last complete live member cache.');
    }
    return this.currentMembers();
  }

  async validateMemberAbsent(discordId: string): Promise<void> {
    try {
      await fetchFreshMember(this.guild, discordId);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === RESTJSONErrorCodes.UnknownMember) return;
      throw new Error(`Ratatoskr could not confirm that ${discordId} has left the YSL server.`);
    }
    throw new LeagueMutationValidationError('That player is back in the YSL server. Use `/transaction drop` to move them into free agency.');
  }

  async validateRoleState(discordId: string, expected: LeagueRoleState): Promise<void> {
    assertMemberRoleState(await fetchFreshMember(this.guild, discordId), expected);
  }

  async validateDisplayName(discordId: string, expectedDisplayName: string): Promise<void> {
    let member: GuildMember;
    try { member = await fetchFreshMember(this.guild, discordId); }
    catch {
      throw new LeagueMutationValidationError(
        'Ratatoskr could not recheck that player’s current Discord display name. No changes were made; try again.',
      );
    }
    if (member.displayName.trim() !== expectedDisplayName.trim()) {
      throw new LeagueMutationValidationError(
        'That player’s Discord display name changed after the operation was loaded. Review the newest value; no changes were made.',
      );
    }
  }

  async applyRoleChange(change: DiscordRoleChange, before: LeagueRoleState, after: LeagueRoleState): Promise<void> {
    const member = await fetchFreshMember(this.guild, change.discordId);
    try {
      assertMemberRoleState(member, before);
    } catch (error) {
      throw new DiscordRoleReconciliationRequiredError(
        `Discord roles changed before Ratatoskr updated ${change.discordId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      if (change.remove.length) await member.roles.remove(change.remove, 'Ratatoskr approved league transaction');
      if (change.add.length) await member.roles.add(change.add, 'Ratatoskr approved league transaction');
      const verified = await fetchFreshMember(this.guild, change.discordId);
      assertMemberRoleState(verified, after);
    } catch (error) {
      throw new DiscordRoleReconciliationRequiredError(
        `Discord role mutation may be partial for ${change.discordId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async reconcileManagedRoles(
    change: DiscordRoleChange,
    expected: LeagueRoleState,
    observedManagedRoleIds: string[],
  ): Promise<void> {
    const member = await fetchFreshMember(this.guild, change.discordId);
    const managedRoleIds = new Set([
      ...expected.configuredTeamRoleIds,
      ...expected.configuredDivisionRoleIds,
      expected.freeAgentRoleId,
    ]);
    const currentManagedRoleIds = [...member.roles.cache.keys()]
      .filter((roleId) => managedRoleIds.has(roleId))
      .sort();
    if (JSON.stringify(currentManagedRoleIds) !== JSON.stringify([...observedManagedRoleIds].sort())) {
      throw new LeagueMutationValidationError(
        'This player’s managed Discord roles changed after the audit was loaded. Review the newest audit card; no roles were changed.',
      );
    }
    try {
      if (change.remove.length) await member.roles.remove(change.remove, 'Ratatoskr approved roster audit repair');
      if (change.add.length) await member.roles.add(change.add, 'Ratatoskr approved roster audit repair');
      assertMemberRoleState(await fetchFreshMember(this.guild, change.discordId), expected);
    } catch (error) {
      throw new DiscordRoleReconciliationRequiredError(
        `Discord role repair may be partial for ${change.discordId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async rollbackRoleChange(change: DiscordRoleChange, expected: LeagueRoleState, applied: LeagueRoleState): Promise<void> {
    const member = await fetchFreshMember(this.guild, change.discordId);
    try {
      assertMemberRoleState(member, applied);
    } catch (error) {
      throw new DiscordRoleReconciliationRequiredError(
        `Discord roles changed before Ratatoskr could roll back ${change.discordId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (change.add.length) await member.roles.remove(change.add, 'Ratatoskr transaction rollback');
    if (change.remove.length) await member.roles.add(change.remove, 'Ratatoskr transaction rollback');
    const verified = await fetchFreshMember(this.guild, change.discordId);
    try {
      assertMemberRoleState(verified, expected);
    } catch {
      throw new DiscordRoleReconciliationRequiredError(`Discord rollback did not converge for ${change.discordId}.`);
    }
  }

  async findAnnouncement(reference: string): Promise<string | undefined> {
    const channel = await this.transactionsChannel();
    let before: string | undefined;
    while (true) {
      const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      const match = messages.find((message) => message.author.id === this.guild.client.user?.id
        && String(message.nonce ?? '') === reference);
      if (match) return match.id;
      if (messages.size < 100) return undefined;
      const oldest = messages.last();
      if (!oldest || oldest.id === before) return undefined;
      before = oldest.id;
    }
  }

  async announce(announcement: LeagueAnnouncement, reference: string): Promise<string> {
    const channel = await this.transactionsChannel();
    const message = await channel.send({
      content: announcement.content,
      embeds: [new EmbedBuilder().setTitle(announcement.title).setDescription(announcement.description).setFooter({ text: announcement.footer })],
      allowedMentions: { parse: [], roles: announcement.allowedRoleIds },
      nonce: reference,
      enforceNonce: true,
    });
    return message.id;
  }
}
