import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  UserSelectMenuBuilder,
  type ButtonInteraction,
  type MessageActionRowComponentBuilder,
  type MessageComponentInteraction,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from 'discord.js';
import type Database from 'better-sqlite3';
import {
  claimScoutPublish,
  getDivisionByKey,
  getScoutConfig,
  getScoutSetupById,
  listScoutRosterSlots,
  releaseScoutPublishClaim,
  replacePublishedScoutRosterSlotIfVersion,
  setScoutResultMessage,
  type ScoutSetup,
} from '../db/index.js';
import { SCOUT_ROLE_LABELS } from '../domain/index.js';
import { hasScoutManagementAccess } from './scoutAuthorization.js';
import { scoutReviewButtonRow } from './scoutReview.js';
import { renderScoutResult } from './scoutResults.js';
import { renderScoutSignupPost } from './scoutSignupPost.js';

function replacementRow(setupId: number, version: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`scout:publishedreplace:${setupId}:${version}`)
      .setLabel('Replace player')
      .setStyle(ButtonStyle.Secondary),
  );
}

async function authorized(
  interaction: MessageComponentInteraction,
  db: Database.Database,
  setupId: number,
  status: 'roster_ready' | 'published',
): Promise<ScoutSetup | undefined> {
  const setup = getScoutSetupById(db, setupId);
  if (!setup || setup.guildId !== interaction.guildId || setup.status !== status || !interaction.guild) return undefined;
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

export async function handleScoutPublishButton(interaction: ButtonInteraction, db: Database.Database): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || !['publish', 'publishconfirm', 'publishback', 'publishedreplace'].includes(parts[1] ?? '')) return false;
  const setupId = Number(parts[2]);
  const expectedVersion = Number(parts[3]);
  if (!Number.isInteger(setupId) || !Number.isInteger(expectedVersion)) return false;
  const publishedAction = parts[1] === 'publishedreplace';
  const setup = await authorized(interaction, db, setupId, publishedAction ? 'published' : 'roster_ready');
  if (!setup) {
    await interaction.reply({ content: 'You do not have permission to manage this scout result.', flags: MessageFlags.Ephemeral });
    return true;
  }

  if (parts[1] === 'publishback') {
    const { buildScoutRosterReviewView } = await import('./scoutReview.js');
    await interaction.update(buildScoutRosterReviewView(db, setup.id, setup.version, listScoutRosterSlots(db, setup.id)));
    return true;
  }
  if (parts[1] === 'publish') {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`scout:publishconfirm:${setupId}:${expectedVersion}`).setLabel('Confirm publish').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`scout:publishback:${setupId}:${expectedVersion}`).setLabel('Back').setStyle(ButtonStyle.Secondary),
    );
    await interaction.update({
      content: `Publish this finalized roster to <#${setup.resultsChannelId}>? This can only happen once.`,
      components: [row],
    });
    return true;
  }
  if (parts[1] === 'publishedreplace') {
    const slots = listScoutRosterSlots(db, setupId);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`scout:publishedpick:${setupId}:${expectedVersion}`)
      .setPlaceholder('Published slot to replace')
      .addOptions(slots.map((slot) => new StringSelectMenuOptionBuilder()
        .setLabel(`${slot.team === 'team_one' ? 'Order' : 'Chaos'} ${SCOUT_ROLE_LABELS[slot.role]} — ${slot.userId}`.slice(0, 100))
        .setValue(String(slot.id))));
    await interaction.reply({
      content: 'Choose the published roster slot to replace.',
      components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu)],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.deferUpdate();
  const claim = claimScoutPublish(db, setupId, expectedVersion);
  if (claim !== 'claimed') {
    await interaction.editReply({
      content: claim === 'withdrawals' ? 'Publishing is blocked by one or more withdrawn signups.' : 'That publish confirmation is stale or already completed.',
      components: [],
    });
    return true;
  }

  const slots = listScoutRosterSlots(db, setupId);
  let resultMessage;
  let signupMessage;
  let signupPostUpdated = false;
  try {
    const channel = await interaction.client.channels.fetch(setup.resultsChannelId);
    if (!channel?.isSendable()) throw new Error('The snapshotted results channel is not sendable.');
    resultMessage = await channel.send({
      content: renderScoutResult(setup, slots),
      components: [replacementRow(setupId, setup.version)],
      allowedMentions: { parse: [], users: slots.map((slot) => slot.userId), roles: [] },
    });

    const signupChannel = await interaction.client.channels.fetch(setup.signupChannelId);
    if (!signupChannel?.isTextBased() || !setup.signupMessageId) {
      throw new Error('The original signup post is unavailable.');
    }
    signupMessage = await signupChannel.messages.fetch(setup.signupMessageId);
    await signupMessage.edit({
      content: `${renderScoutSignupPost(setup)}\n\n✅ Roster published: ${resultMessage.url}`,
      components: [],
      allowedMentions: { parse: [] },
    });
    signupPostUpdated = true;

    if (!setScoutResultMessage(db, setupId, resultMessage.id)) throw new Error('Could not attach the result message to the setup.');
  } catch (error) {
    if (resultMessage) await resultMessage.delete().catch(() => undefined);
    releaseScoutPublishClaim(db, setupId);
    if (signupPostUpdated && signupMessage) {
      await signupMessage.edit({
        content: renderScoutSignupPost(setup),
        components: [scoutReviewButtonRow(setup.id)],
        allowedMentions: { parse: [] },
      }).catch(() => undefined);
    }
    await interaction.editReply({ content: `Publishing failed and is ready to retry: ${(error as Error).message}`, components: [] });
    return true;
  }
  await interaction.editReply({ content: `Scout roster published: ${resultMessage.url}`, components: [] });
  return true;
}

export async function handleScoutPublishedSlotSelect(
  interaction: StringSelectMenuInteraction,
  db: Database.Database,
): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || parts[1] !== 'publishedpick') return false;
  const setupId = Number(parts[2]);
  const version = Number(parts[3]);
  const slotId = Number(interaction.values[0]);
  if (![setupId, version, slotId].every(Number.isInteger)) return false;
  if (!(await authorized(interaction, db, setupId, 'published'))) {
    await interaction.reply({ content: 'You do not have permission to replace this player.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const menu = new UserSelectMenuBuilder()
    .setCustomId(`scout:publisheduser:${setupId}:${version}:${slotId}`)
    .setPlaceholder('Choose a non-rostered replacement');
  await interaction.update({
    content: 'Choose the replacement. Existing roster members will be rejected.',
    components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu)],
  });
  return true;
}

export async function handleScoutPublishedUserSelect(
  interaction: UserSelectMenuInteraction,
  db: Database.Database,
): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || parts[1] !== 'publisheduser') return false;
  const setupId = Number(parts[2]);
  const version = Number(parts[3]);
  const slotId = Number(parts[4]);
  if (![setupId, version, slotId].every(Number.isInteger)) return false;
  const setup = await authorized(interaction, db, setupId, 'published');
  if (!setup) {
    await interaction.reply({ content: 'You do not have permission to replace this player.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const userId = interaction.values[0]!;
  const replacementMember = await interaction.guild?.members.fetch(userId).catch(() => undefined);
  if (!replacementMember) {
    await interaction.reply({ content: 'The replacement must be a current server member.', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (replacementMember.user.bot) {
    await interaction.reply({ content: 'A bot cannot be used as a scout replacement.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const oldSlot = listScoutRosterSlots(db, setupId).find((slot) => slot.id === slotId);
  const outcome = replacePublishedScoutRosterSlotIfVersion(db, setupId, version, slotId, userId);
  if (outcome !== 'updated' || !oldSlot) {
    await interaction.update({ content: `No replacement was made (${outcome}).`, components: [] });
    return true;
  }
  const updated = getScoutSetupById(db, setupId)!;
  const slots = listScoutRosterSlots(db, setupId);
  const channel = await interaction.client.channels.fetch(updated.resultsChannelId);
  if (!channel?.isTextBased() || !updated.resultMessageId) throw new Error('Published result channel or message is unavailable.');
  const message = await channel.messages.fetch(updated.resultMessageId);
  await message.edit({
    content: renderScoutResult(updated, slots),
    components: [replacementRow(setupId, updated.version)],
    allowedMentions: { parse: [], users: slots.map((slot) => slot.userId), roles: [] },
  });
  if (channel.isSendable()) {
    await channel.send({
      content: `Roster update: <@${oldSlot.userId}> was replaced by <@${userId}> at ${SCOUT_ROLE_LABELS[oldSlot.role]}.`,
      allowedMentions: { parse: [] },
    });
  }
  await interaction.update({ content: 'Published roster updated.', components: [] });
  return true;
}
