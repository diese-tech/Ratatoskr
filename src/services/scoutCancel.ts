import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type MessageComponentInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type Database from 'better-sqlite3';
import {
  cancelScoutSetupIfVersion,
  getDivisionByKey,
  getScoutConfig,
  getScoutSetupById,
  listCancellableScoutSetups,
  listDivisions,
  listManagedResourcesByDomain,
  type ScoutSetup,
} from '../db/index.js';
import { hasScoutManagementAccess } from './scoutAuthorization.js';
import { resolveScoutChannelScope } from './scoutChannels.js';
import { renderScoutSignupPost } from './scoutSignupPost.js';

export function scoutCancelButton(setupId: number, version: number): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`scout:cancel:${setupId}:${version}`)
    .setLabel('Cancel setup')
    .setStyle(ButtonStyle.Danger);
}

export function scoutCancelButtonRow(setupId: number, version: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(scoutCancelButton(setupId, version));
}

function liveChannelMap(guild: Guild) {
  return new Map(
    guild.channels.cache
      .filter((channel) => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildVoice)
      .map((channel) => [
        channel.id,
        {
          resourceType: channel.type === ChannelType.GuildText ? ('text_channel' as const) : ('voice_channel' as const),
          parentId: channel.parentId,
        },
      ]),
  );
}

async function canManageSetup(
  interaction: MessageComponentInteraction,
  db: Database.Database,
  setupId: number,
): Promise<ScoutSetup | undefined> {
  const setup = getScoutSetupById(db, setupId);
  if (!setup || setup.guildId !== interaction.guildId || !interaction.guild) return undefined;
  const division = getDivisionByKey(db, setup.guildId, setup.divisionKey);
  if (!division || division.id !== setup.divisionId || division.status !== 'active') return undefined;
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const config = getScoutConfig(db, setup.guildId);
  const { hasAccess } = await import('./authorization.js');
  return hasScoutManagementAccess({
    isAdmin: hasAccess(member, 'ADMIN'),
    memberRoleIds: new Set(member.roles.cache.keys()),
    additionalAuthorizedRoleIds: config?.authorizedRoleIds ?? [],
    divisionCaptainAccessRoleId: division.captainAccessRoleId,
  }) ? setup : undefined;
}

function confirmation(setup: ScoutSetup) {
  return {
    content: `Cancel **${setup.divisionDisplayName} scout setup #${setup.id}** at <t:${setup.startAt}:F>? Signups will close and this cannot be undone.`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`scout:cancelconfirm:${setup.id}:${setup.version}`)
          .setLabel('Confirm cancellation')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`scout:cancelkeep:${setup.id}:${setup.version}`)
          .setLabel('Keep setup')
          .setStyle(ButtonStyle.Secondary),
      ),
    ],
  };
}

function publishedDirection(setup: ScoutSetup): string {
  const resultUrl = setup.resultMessageId
    ? `https://discord.com/channels/${setup.guildId}/${setup.resultsChannelId}/${setup.resultMessageId}`
    : 'the published result';
  return `That setup is already published and cannot be cancelled. Use **Replace player** on ${resultUrl}.`;
}

export async function handleScoutCancelCommand(
  interaction: ChatInputCommandInteraction,
  db: Database.Database,
): Promise<void> {
  if (!interaction.guild) return;
  await interaction.guild.channels.fetch();
  const divisions = listDivisions(db, interaction.guild.id);
  const scope = resolveScoutChannelScope({
    guildId: interaction.guild.id,
    channelId: interaction.channelId,
    divisions,
    managedResources: listManagedResourcesByDomain(db, interaction.guild.id, 'division'),
    liveChannels: liveChannelMap(interaction.guild),
  });
  if (!scope || scope.purpose !== 'signups') {
    await interaction.reply({
      content: 'Run `/scout cancel` from the managed scout-signups channel for the division you want to manage.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const division = divisions.find((candidate) => candidate.id === scope.divisionId && candidate.status === 'active');
  if (!division) {
    await interaction.reply({ content: 'This division is not active.', flags: MessageFlags.Ephemeral });
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const config = getScoutConfig(db, interaction.guild.id);
  const { hasAccess } = await import('./authorization.js');
  const allowed = hasScoutManagementAccess({
    isAdmin: hasAccess(member, 'ADMIN'),
    memberRoleIds: new Set(member.roles.cache.keys()),
    additionalAuthorizedRoleIds: config?.authorizedRoleIds ?? [],
    divisionCaptainAccessRoleId: division.captainAccessRoleId,
  });
  if (!allowed) {
    await interaction.reply({ content: 'You do not have permission to cancel this division\'s scout setups.', flags: MessageFlags.Ephemeral });
    return;
  }

  const setups = listCancellableScoutSetups(db, interaction.guild.id, division.id);
  if (setups.length === 0) {
    await interaction.reply({ content: 'This division has no open or roster-ready scout setups to cancel.', flags: MessageFlags.Ephemeral });
    return;
  }
  if (setups.length === 1) {
    await interaction.reply({ ...confirmation(setups[0]!), flags: MessageFlags.Ephemeral });
    return;
  }

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`scout:cancelpick:${division.id}`)
    .setPlaceholder('Choose the scout setup to cancel')
    .addOptions(setups.slice(0, 25).map((setup) =>
      new StringSelectMenuOptionBuilder()
        .setLabel(`Setup #${setup.id} — ${new Date(setup.startAt * 1_000).toISOString().slice(0, 16).replace('T', ' ')}`)
        .setDescription(setup.status === 'roster_ready' ? 'Roster ready' : 'Accepting signups')
        .setValue(String(setup.id)),
    ));
  await interaction.reply({
    content: `Choose one of the cancellable **${division.displayName}** scout setups.`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleScoutCancelSelect(
  interaction: StringSelectMenuInteraction,
  db: Database.Database,
): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || parts[1] !== 'cancelpick') return false;
  const divisionId = Number(parts[2]);
  const setupId = Number(interaction.values[0]);
  if (![divisionId, setupId].every(Number.isInteger)) return false;
  const setup = await canManageSetup(interaction, db, setupId);
  if (!setup || setup.divisionId !== divisionId || setup.signupChannelId !== interaction.channelId) {
    await interaction.update({ content: 'That setup is no longer available to you.', components: [] });
    return true;
  }
  if (!['open', 'roster_ready'].includes(setup.status)) {
    await interaction.update({
      content: setup.status === 'published' ? publishedDirection(setup) : 'That setup is no longer cancellable.',
      components: [],
    });
    return true;
  }
  await interaction.update(confirmation(setup));
  return true;
}

export async function handleScoutCancelButton(
  interaction: ButtonInteraction,
  db: Database.Database,
): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || !['cancel', 'cancelconfirm', 'cancelkeep'].includes(parts[1] ?? '')) return false;
  const setupId = Number(parts[2]);
  const expectedVersion = Number(parts[3]);
  if (![setupId, expectedVersion].every(Number.isInteger)) return false;
  const setup = await canManageSetup(interaction, db, setupId);
  if (!setup) {
    await interaction.reply({ content: 'You do not have permission to cancel this scout setup.', flags: MessageFlags.Ephemeral });
    return true;
  }

  if (parts[1] === 'cancelkeep') {
    await interaction.update({
      content: setup.status === 'published'
        ? 'Cancellation dismissed. The scout setup was published while this confirmation was open.'
        : setup.status === 'cancelled'
          ? 'This scout setup was already cancelled.'
          : 'Cancellation dismissed. The scout setup remains active.',
      components: [],
    });
    return true;
  }
  if (setup.status === 'published') {
    const response = { content: publishedDirection(setup), components: [] };
    if (parts[1] === 'cancel') await interaction.reply({ ...response, flags: MessageFlags.Ephemeral });
    else await interaction.update(response);
    return true;
  }
  if (!['open', 'roster_ready'].includes(setup.status)) {
    const response = { content: 'That scout setup is no longer cancellable.', components: [] };
    if (parts[1] === 'cancel') await interaction.reply({ ...response, flags: MessageFlags.Ephemeral });
    else await interaction.update(response);
    return true;
  }
  if (parts[1] === 'cancel') {
    await interaction.reply({ ...confirmation(setup), flags: MessageFlags.Ephemeral });
    return true;
  }

  await interaction.deferUpdate();
  const outcome = cancelScoutSetupIfVersion(db, setup.id, expectedVersion);
  if (outcome !== 'cancelled') {
    await interaction.editReply({
      content: outcome === 'published' ? publishedDirection(getScoutSetupById(db, setup.id) ?? setup) : 'That cancellation was stale or already applied.',
      components: [],
    });
    return true;
  }

  try {
    const channel = await interaction.client.channels.fetch(setup.signupChannelId);
    if (!channel?.isTextBased() || !setup.signupMessageId) throw new Error('The original signup post is unavailable.');
    const message = await channel.messages.fetch(setup.signupMessageId);
    await message.edit({
      content: `${renderScoutSignupPost(setup)}\n\n🚫 **This scout setup was cancelled.**`,
      components: [],
      allowedMentions: { parse: [] },
    });
    await message.reactions.removeAll().catch(() => undefined);
    await interaction.editReply({ content: `Scout setup #${setup.id} was cancelled.`, components: [] });
  } catch (error) {
    await interaction.editReply({
      content: `Scout setup #${setup.id} was cancelled, but its original post could not be updated: ${(error as Error).message}`,
      components: [],
    });
  }
  return true;
}
