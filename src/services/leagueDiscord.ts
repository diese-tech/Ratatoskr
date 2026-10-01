import {
  ChannelType,
  EmbedBuilder,
  type Guild,
  type GuildMember,
} from 'discord.js';
import type { DiscordLeagueMember, DiscordRoleChange } from '../domain/leagueOperations.js';
import type { LeagueAnnouncement, LeagueDiscordPort } from './leagueTransactions.js';

export class DiscordRoleReconciliationRequiredError extends Error {
  readonly reconciliationRequired = true;
}

async function fetchFreshMember(guild: Guild, discordId: string): Promise<GuildMember> {
  return guild.members.fetch({ user: discordId, force: true });
}

function roleSnapshot(member: GuildMember): DiscordLeagueMember {
  return { discordId: member.id, displayName: member.displayName, roleIds: [...member.roles.cache.keys()] };
}

export class DiscordLeagueGateway implements LeagueDiscordPort {
  constructor(private readonly guild: Guild, private readonly transactionsChannelId: string) {}

  async getMembers(): Promise<DiscordLeagueMember[]> {
    const members = await this.guild.members.fetch();
    return members.filter((member) => !member.user.bot).map(roleSnapshot);
  }

  async applyRoleChange(change: DiscordRoleChange): Promise<void> {
    const member = await fetchFreshMember(this.guild, change.discordId);
    if (change.remove.some((roleId) => !member.roles.cache.has(roleId))
      || change.add.some((roleId) => member.roles.cache.has(roleId))) {
      throw new Error(`Discord roles changed before ${change.discordId} could be updated.`);
    }
    try {
      if (change.remove.length) await member.roles.remove(change.remove, 'Ratatoskr approved league transaction');
      if (change.add.length) await member.roles.add(change.add, 'Ratatoskr approved league transaction');
      const verified = await fetchFreshMember(this.guild, change.discordId);
      if (change.remove.some((roleId) => verified.roles.cache.has(roleId))
        || change.add.some((roleId) => !verified.roles.cache.has(roleId))) {
        throw new Error('Discord returned a role state that does not match the approved transaction.');
      }
    } catch (error) {
      try {
        const current = await fetchFreshMember(this.guild, change.discordId);
        const missingOriginal = change.remove.filter((roleId) => !current.roles.cache.has(roleId));
        const unexpectedDestination = change.add.filter((roleId) => current.roles.cache.has(roleId));
        if (unexpectedDestination.length) await current.roles.remove(unexpectedDestination, 'Ratatoskr failed transaction repair');
        if (missingOriginal.length) await current.roles.add(missingOriginal, 'Ratatoskr failed transaction repair');
        const repaired = await fetchFreshMember(this.guild, change.discordId);
        if (change.remove.some((roleId) => !repaired.roles.cache.has(roleId))
          || change.add.some((roleId) => repaired.roles.cache.has(roleId))) throw new Error('Role repair did not converge.');
      } catch (repairError) {
        throw new DiscordRoleReconciliationRequiredError(
          `Discord role mutation may be partial for ${change.discordId}: ${repairError instanceof Error ? repairError.message : String(repairError)}`,
        );
      }
      throw error;
    }
  }

  async rollbackRoleChange(change: DiscordRoleChange): Promise<void> {
    const member = await fetchFreshMember(this.guild, change.discordId);
    if (change.add.length) await member.roles.remove(change.add, 'Ratatoskr transaction rollback');
    if (change.remove.length) await member.roles.add(change.remove, 'Ratatoskr transaction rollback');
    const verified = await fetchFreshMember(this.guild, change.discordId);
    if (change.remove.some((roleId) => !verified.roles.cache.has(roleId))
      || change.add.some((roleId) => verified.roles.cache.has(roleId))) {
      throw new DiscordRoleReconciliationRequiredError(`Discord rollback did not converge for ${change.discordId}.`);
    }
  }

  async announce(announcement: LeagueAnnouncement, reference: string): Promise<string> {
    const channel = await this.guild.channels.fetch(this.transactionsChannelId);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guild.id !== this.guild.id) {
      throw new Error('The configured transactions channel is unavailable.');
    }
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
