import {
  ChannelType,
  EmbedBuilder,
  type Guild,
  type GuildMember,
} from 'discord.js';
import type { DiscordLeagueMember, DiscordRoleChange } from '../domain/leagueOperations.js';
import type { LeagueAnnouncement, LeagueDiscordPort, LeagueRoleState } from './leagueTransactions.js';

export class DiscordRoleReconciliationRequiredError extends Error {
  readonly reconciliationRequired = true;
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
  constructor(private readonly guild: Guild, private readonly transactionsChannelId: string) {}

  private async transactionsChannel() {
    const channel = await this.guild.channels.fetch(this.transactionsChannelId);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guild.id !== this.guild.id) {
      throw new Error('The configured transactions channel is unavailable.');
    }
    return channel;
  }

  async getMembers(): Promise<DiscordLeagueMember[]> {
    const members = await this.guild.members.fetch();
    return members.filter((member) => !member.user.bot).map(roleSnapshot);
  }

  async validateRoleState(discordId: string, expected: LeagueRoleState): Promise<void> {
    assertMemberRoleState(await fetchFreshMember(this.guild, discordId), expected);
  }

  async applyRoleChange(change: DiscordRoleChange, before: LeagueRoleState, after: LeagueRoleState): Promise<void> {
    const member = await fetchFreshMember(this.guild, change.discordId);
    assertMemberRoleState(member, before);
    try {
      if (change.remove.length) await member.roles.remove(change.remove, 'Ratatoskr approved league transaction');
      if (change.add.length) await member.roles.add(change.add, 'Ratatoskr approved league transaction');
      const verified = await fetchFreshMember(this.guild, change.discordId);
      assertMemberRoleState(verified, after);
    } catch (error) {
      try {
        const current = await fetchFreshMember(this.guild, change.discordId);
        const missingOriginal = change.remove.filter((roleId) => !current.roles.cache.has(roleId));
        const unexpectedDestination = change.add.filter((roleId) => current.roles.cache.has(roleId));
        if (unexpectedDestination.length) await current.roles.remove(unexpectedDestination, 'Ratatoskr failed transaction repair');
        if (missingOriginal.length) await current.roles.add(missingOriginal, 'Ratatoskr failed transaction repair');
        const repaired = await fetchFreshMember(this.guild, change.discordId);
        assertMemberRoleState(repaired, before);
      } catch (repairError) {
        throw new DiscordRoleReconciliationRequiredError(
          `Discord role mutation may be partial for ${change.discordId}: ${repairError instanceof Error ? repairError.message : String(repairError)}`,
        );
      }
      throw error;
    }
  }

  async rollbackRoleChange(change: DiscordRoleChange, expected: LeagueRoleState): Promise<void> {
    const member = await fetchFreshMember(this.guild, change.discordId);
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
