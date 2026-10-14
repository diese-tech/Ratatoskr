import { createHash } from 'node:crypto';
import { ActionRowBuilder, AuditLogEvent, ButtonBuilder, ButtonStyle, ChannelType,
  PermissionsBitField, type Guild, type Message, type Role } from 'discord.js';
import type Database from 'better-sqlite3';
import { beginInhouseConfiguration, bindInhouseResource, getInhouseConfig } from '../db/repositories/inhouse.js';

export type InhouseSetupInput = {
  guildId: string; categoryId: string; categoryName: string;
  roleName: string; channelName: string; emoji: string;
};
const marker = (reference: string) => `inhouse:optin:${reference}`;
const reason = (reference: string) => `Ratatoskr permanent inhouses ${reference}`;

async function ownedCreation(guild: Guild, targetId: string, reference: string, type: AuditLogEvent): Promise<boolean> {
  const logs = await guild.fetchAuditLogs({ type, user: guild.client.user.id, limit: 100 });
  return logs.entries.some(entry => entry.targetId === targetId
    && entry.executorId === guild.client.user.id && entry.reason === reason(reference));
}
function ordinaryRole(role: Role) {
  if (role.managed || role.permissions.bitfield !== 0n || !role.editable) {
    throw new Error('The Inhouse role must be an ordinary, permission-free role below Ratatoskr.');
  }
}
function ownsMessage(message: Message, reference: string, botId: string): boolean {
  return message.author.id === botId && message.components.some(row =>
    'components' in row && row.components.some(component => 'customId' in component && component.customId === marker(reference)));
}

/** Only new, explicitly named resources are owned here. Nothing is registered
 * in the division/season scaffold or eligible for their reset/cleanup paths.
 * Discord audit reasons prove a lost create response on a later reviewed run.
 */
export async function setupInhouses(guild: Guild, db: Database.Database, input: InhouseSetupInput,
  options: { write?: boolean; expectedPlan?: string } = {}) {
  if (guild.id !== input.guildId) throw new Error('Unexpected inhouse server.');
  if (!input.roleName.trim() || !/^[a-z0-9-]{1,100}$/.test(input.channelName) || !input.emoji || input.emoji.includes('<')) {
    throw new Error('Supply the approved role, channel and Unicode opt-in emoji names.');
  }
  const [channels, roles, me] = await Promise.all([guild.channels.fetch(), guild.roles.fetch(), guild.members.fetchMe({ force: true })]);
  const category = channels.get(input.categoryId);
  if (!category || category.type !== ChannelType.GuildCategory || category.name !== input.categoryName) {
    throw new Error('The approved permanent category does not match.');
  }
  if (!me.permissions.has([PermissionsBitField.Flags.ManageRoles, PermissionsBitField.Flags.ManageChannels,
    PermissionsBitField.Flags.ViewAuditLog])) throw new Error('Ratatoskr needs its existing resource-management and audit-log access.');
  const postingPermissions = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages,
    PermissionsBitField.Flags.ReadMessageHistory, PermissionsBitField.Flags.AddReactions, PermissionsBitField.Flags.ManageMessages];
  if (!category.permissionsFor(me)?.has(postingPermissions)) {
    throw new Error('Ratatoskr cannot post, seed and pin under the inherited category permissions.');
  }
  const existing = getInhouseConfig(db, guild.id);
  if (existing && (existing.categoryId !== input.categoryId || existing.roleName !== input.roleName
    || existing.channelName !== input.channelName || existing.emoji !== input.emoji)) {
    throw new Error('Existing inhouse configuration belongs to another target; preserve it for review.');
  }
  const namedRoles = [...roles.values()].filter(role => role.name.toLowerCase() === input.roleName.toLowerCase());
  const namedChannels = [...channels.values()].filter(channel => channel?.name.toLowerCase() === input.channelName.toLowerCase());
  if (namedRoles.length > 1 || namedChannels.length > 1) throw new Error('Duplicate inhouse names require explicit ownership review.');
  let role = existing?.roleId ? roles.get(existing.roleId) : namedRoles[0];
  let channel = existing?.channelId ? channels.get(existing.channelId) : namedChannels[0];
  if (existing?.roleId && (!role || role.name !== input.roleName)) throw new Error('The bound Inhouse role is missing or renamed.');
  if (existing?.channelId && !channel) throw new Error('The bound permanent inhouse channel is missing.');
  if (role) {
    ordinaryRole(role);
    if (existing?.roleId !== role.id && (!existing || !await ownedCreation(guild, role.id, existing.provisioningRef, AuditLogEvent.RoleCreate))) {
      throw new Error('An unowned role already uses the proposed name. Nothing was adopted.');
    }
  }
  if (channel) {
    if (channel.type !== ChannelType.GuildText || channel.parentId !== category.id || channel.name !== input.channelName) {
      throw new Error('The named inhouse channel has the wrong type, parent or name.');
    }
    if (existing?.channelId !== channel.id && (!existing || !await ownedCreation(guild, channel.id, existing.provisioningRef, AuditLogEvent.ChannelCreate))) {
      throw new Error('An unowned channel already uses the proposed name. Nothing was adopted.');
    }
    if (!channel.permissionsFor(me)?.has(postingPermissions)) throw new Error('Inhouse channel posting permissions need review.');
  }
  const fingerprint = createHash('sha256').update(JSON.stringify({ input, existing: existing ?? null,
    category: { id: category.id, name: category.name, overwrites: category.permissionOverwrites.cache
      .map(overwrite => ({ id: overwrite.id, type: overwrite.type, allow: String(overwrite.allow.bitfield), deny: String(overwrite.deny.bitfield) })) },
    role: role ? { id: role.id, position: role.position, permissions: String(role.permissions.bitfield) } : null,
    channel: channel && channel.type === ChannelType.GuildText ? { id: channel.id, parent: channel.parentId, type: channel.type,
      overwrites: channel.permissionOverwrites.cache.map(overwrite => ({ id: overwrite.id, type: overwrite.type,
        allow: String(overwrite.allow.bitfield), deny: String(overwrite.deny.bitfield) })) } : null,
  })).digest('hex');
  const summary = { fingerprint, newRole: !role, newChannel: !channel, optinMessageBound: Boolean(existing?.messageId) };
  if (!options.write) return summary;
  if (options.expectedPlan !== fingerprint) throw new Error('The fresh inhouse setup plan does not match the reviewed fingerprint.');
  let config = beginInhouseConfiguration(db, input);
  if (!role) role = await guild.roles.create({ name: input.roleName, permissions: 0n, hoist: false,
    mentionable: false, reason: reason(config.provisioningRef) });
  ordinaryRole(role);
  config = bindInhouseResource(db, guild.id, 'roleId', role.id);
  if (!channel) channel = await guild.channels.create({ name: input.channelName, type: ChannelType.GuildText,
    parent: category.id, permissionOverwrites: category.permissionOverwrites.cache.map(overwrite => ({
      id: overwrite.id, type: overwrite.type, allow: overwrite.allow.bitfield, deny: overwrite.deny.bitfield,
    })), topic: 'Optional open inhouses. React to the pinned message for hosting access and inhouse notifications. Anyone can join games.',
    reason: reason(config.provisioningRef) });
  if (channel.type !== ChannelType.GuildText) throw new Error('The created inhouse channel has an unexpected type.');
  config = bindInhouseResource(db, guild.id, 'channelId', channel.id);
  if (!channel.permissionsFor(me)?.has(postingPermissions)) {
    throw new Error('Ratatoskr cannot post, seed and pin the inhouse message under the inherited category permissions.');
  }
  let message = config.messageId ? await channel.messages.fetch(config.messageId) : undefined;
  if (!message) {
    let before: string | undefined;
    for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
      const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      const matches = page.filter(candidate => ownsMessage(candidate, config.provisioningRef, guild.client.user.id));
      if (matches.size > 1) throw new Error('Multiple opt-in messages need review.');
      message = matches.first();
      if (message || page.size < 100) break;
      before = page.last()?.id;
      if (!before || pageNumber === 9) throw new Error('Opt-in message history could not be fully checked. No duplicate post was sent.');
    }
    if (!message) message = await channel.send({
      content: `**Optional inhouses**\nReact with ${config.emoji} to receive the <@&${role.id}> role and inhouse pings. Remove your reaction to remove the role.\n\nWith the role, use /inhouse create here to host. Only you can manage games you create. **Anyone can join a posted game**, even without this role. Teams use best-effort division balancing and can be adjusted manually.`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder()
        .setCustomId(marker(config.provisioningRef)).setLabel('Optional inhouses').setStyle(ButtonStyle.Secondary).setDisabled(true))],
      allowedMentions: { parse: [], roles: [], users: [] },
    });
    config = bindInhouseResource(db, guild.id, 'messageId', message.id);
  }
  if (!ownsMessage(message, config.provisioningRef, guild.client.user.id)) throw new Error('Bound opt-in message is not the owned Ratatoskr post.');
  await message.react(config.emoji);
  if (!message.pinned) await message.pin('Permanent inhouse opt-in');
  return { ...summary, roleId: role.id, channelId: channel.id, messageId: message.id };
}
