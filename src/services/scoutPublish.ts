import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  UserSelectMenuBuilder,
  type Client,
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
  listScoutPublishesNeedingReconciliation,
  listScoutRosterSlots,
  markPublishedScoutSignupPostReconciled,
  releaseScoutPublishClaim,
  rollbackPublishedScoutRosterReplacement,
  rollbackPublishedScoutRosterSwap,
  replacePublishedScoutRosterSlotIfVersion,
  setScoutPendingResultMessage,
  swapPublishedScoutRosterSlotsIfVersion,
  type ScoutSetup,
} from '../db/index.js';
import { SCOUT_ROLE_LABELS } from '../domain/index.js';
import {
  hasScoutDivisionManagementAccess,
  isScoutOperationsChannel,
  isScoutResultsChannel,
} from './scoutAuthorization.js';
import { renderScoutResult } from './scoutResults.js';
import { updateScoutControlPanel } from './scoutControlPanel.js';
import { renderScoutSignupPost } from './scoutSignupPost.js';
import { isScoutUserEligible, resolveEligibleScoutUserIds } from './scoutEligibility.js';
import { renderPersistedScoutSignupPost } from './scoutCreate.js';

export function scoutResultMarker(setupId: number): string {
  return `SCOUT-RESULT-${setupId}`;
}

function renderPersistedScoutResult(setup: ScoutSetup, slots: ReturnType<typeof listScoutRosterSlots>): string {
  return `${renderScoutResult(setup, slots)}\n\n\`${scoutResultMarker(setup.id)}\``;
}

async function findRecoverableResultMessage(client: Client, setup: ScoutSetup) {
  const channel = await client.channels.fetch(setup.resultsChannelId);
  if (!channel?.isTextBased()) throw new Error('The snapshotted results channel is unavailable.');
  if (setup.resultMessageId) {
    return channel.messages.fetch(setup.resultMessageId);
  }
  let before: string | undefined;
  while (true) {
    const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const found = messages.find((message) =>
      message.author.id === client.user?.id && message.content.includes(scoutResultMarker(setup.id)));
    if (found || messages.size < 100) return found;
    before = messages.last()?.id;
    if (!before) return undefined;
  }
}

async function attachRecoveredScoutResult(
  client: Client,
  db: Database.Database,
  setup: ScoutSetup,
  resultMessage: { id: string; url: string },
): Promise<void> {
  if (!setup.resultMessageId && !setScoutPendingResultMessage(db, setup.id, resultMessage.id)) {
    const current = getScoutSetupById(db, setup.id);
    if (current?.resultMessageId !== resultMessage.id) throw new Error('Could not record the recovered result message.');
  }
  const signupChannel = await client.channels.fetch(setup.signupChannelId);
  if (!signupChannel?.isTextBased() || !setup.signupMessageId) throw new Error('The original signup post is unavailable.');
  const signupMessage = await signupChannel.messages.fetch(setup.signupMessageId);
  await signupMessage.edit({
    content: `${renderScoutSignupPost(setup)}\n\n✅ Roster published: ${resultMessage.url}`,
    components: [],
    allowedMentions: { parse: [] },
  });
  if (!setup.signupPostReconciled && !markPublishedScoutSignupPostReconciled(db, setup.id, resultMessage.id)) {
    const current = getScoutSetupById(db, setup.id);
    if (!current?.signupPostReconciled) throw new Error('Could not record the repaired signup post.');
  }
}

export async function reconcilePendingScoutPublishes(client: Client, db: Database.Database): Promise<void> {
  for (const setup of listScoutPublishesNeedingReconciliation(db)) {
    try {
      const resultMessage = await findRecoverableResultMessage(client, setup);
      if (!resultMessage) {
        if (!releaseScoutPublishClaim(db, setup.id)) {
          throw new Error('No result post was found and the publish claim could not be released.');
        }
        continue;
      }
      await attachRecoveredScoutResult(client, db, setup, resultMessage);
    } catch (error) {
      console.error(`Scout publish reconciliation failed for setup #${setup.id}`, error);
    }
  }
}

function managementRow(setupId: number, version: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`scout:publishedswap:${setupId}:${version}`)
      .setLabel('Swap players')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`scout:publishedreplace:${setupId}:${version}`)
      .setLabel('Replace player')
      .setStyle(ButtonStyle.Secondary),
  );
}

function publishedSlotLabel(slot: ReturnType<typeof listScoutRosterSlots>[number]) {
  return `Game ${slot.gameNumber} ${slot.team === 'team_one' ? 'Order' : 'Chaos'} ${SCOUT_ROLE_LABELS[slot.role]} — ${slot.userId}`;
}

async function authorized(
  interaction: MessageComponentInteraction,
  db: Database.Database,
  setupId: number,
  status: 'roster_ready' | 'published',
): Promise<ScoutSetup | undefined> {
  const setup = getScoutSetupById(db, setupId);
  if (!setup || setup.guildId !== interaction.guildId || setup.status !== status || !interaction.guild) return undefined;
  const correctChannel = status === 'roster_ready'
    ? isScoutOperationsChannel(setup, interaction.channelId)
    : isScoutResultsChannel(setup, interaction.channelId);
  if (!correctChannel) return undefined;
  const division = getDivisionByKey(db, setup.guildId, setup.divisionKey);
  if (!division || division.id !== setup.divisionId || division.status !== 'active') return undefined;
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const config = getScoutConfig(db, setup.guildId);
  const { hasAccess } = await import('./authorization.js');
  return hasScoutDivisionManagementAccess(member, config, division, hasAccess(member, 'ADMIN')) ? setup : undefined;
}

export async function handleScoutPublishButton(interaction: ButtonInteraction, db: Database.Database): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || !['publish', 'publishconfirm', 'publishback', 'publishedreplace', 'publishedswap'].includes(parts[1] ?? '')) return false;
  const setupId = Number(parts[2]);
  const expectedVersion = Number(parts[3]);
  if (!Number.isInteger(setupId) || !Number.isInteger(expectedVersion)) return false;
  const publishedAction = ['publishedreplace', 'publishedswap'].includes(parts[1] ?? '');
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
        .setLabel(publishedSlotLabel(slot).slice(0, 100))
        .setValue(String(slot.id))));
    await interaction.reply({
      content: 'Choose the published roster slot to replace.',
      components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu)],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }

  await interaction.deferUpdate();
  const preflightSlots = listScoutRosterSlots(db, setupId);
  const eligibleUserIds = await resolveEligibleScoutUserIds(
    interaction.guild!,
    preflightSlots.map((slot) => slot.userId),
    setup.eligibilityRoleId,
  );
  const ineligible = preflightSlots.filter((slot) => !eligibleUserIds.has(slot.userId));
  if (ineligible.length) {
    await interaction.editReply({
      content: `Publishing is blocked because these players no longer satisfy the eligibility role: ${ineligible.map((slot) => `<@${slot.userId}>`).join(', ')}`,
      components: [],
      allowedMentions: { parse: [] },
    });
    return true;
  }
  if (parts[1] === 'publishedswap') {
    const slots = listScoutRosterSlots(db, setupId);
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`scout:publishedswapfirst:${setupId}:${expectedVersion}`)
      .setPlaceholder('First published player')
      .addOptions(slots.map((slot) => new StringSelectMenuOptionBuilder()
        .setLabel(publishedSlotLabel(slot).slice(0, 100))
        .setValue(String(slot.id))));
    await interaction.reply({
      content: 'Choose the first published player to swap.',
      components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu)],
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
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
  let resultSendAttempted = false;
  try {
    const channel = await interaction.client.channels.fetch(setup.resultsChannelId);
    if (!channel?.isSendable()) throw new Error('The snapshotted results channel is not sendable.');
    resultSendAttempted = true;
    resultMessage = await channel.send({
      content: renderPersistedScoutResult(setup, slots),
      components: [managementRow(setupId, setup.version)],
      allowedMentions: { parse: [], users: slots.map((slot) => slot.userId), roles: [] },
    });
    if (!setScoutPendingResultMessage(db, setupId, resultMessage.id)) {
      throw new Error('Could not record the pending result message.');
    }

    const signupChannel = await interaction.client.channels.fetch(setup.signupChannelId);
    if (!signupChannel?.isTextBased() || !setup.signupMessageId) throw new Error('The original signup post is unavailable.');
    signupMessage = await signupChannel.messages.fetch(setup.signupMessageId);
    await signupMessage.edit({
      content: `${renderScoutSignupPost(setup)}\n\n✅ Roster published: ${resultMessage.url}`,
      components: [],
      allowedMentions: { parse: [] },
    });
    signupPostUpdated = true;
    if (!markPublishedScoutSignupPostReconciled(db, setupId, resultMessage.id)) {
      throw new Error('Could not record the updated signup post.');
    }
  } catch (error) {
    const resultDeleted = resultMessage
      ? await resultMessage.delete().then(() => true, () => false)
      : !resultSendAttempted;
    const released = resultDeleted
      ? releaseScoutPublishClaim(db, setupId, resultMessage?.id)
      : false;
    if (signupPostUpdated && signupMessage) {
      await signupMessage.edit({
        content: renderPersistedScoutSignupPost(setup),
        components: [],
        allowedMentions: { parse: [] },
      }).catch(() => undefined);
    }
    await interaction.editReply({
      content: released
        ? `Publishing failed and is ready to retry: ${(error as Error).message}`
        : `Publishing was interrupted after the result post was created. Ratatoskr kept the publish claim and will reconcile it on restart: ${(error as Error).message}`,
      components: [],
    });
    return true;
  }
  await updateScoutControlPanel(
    interaction.client,
    setup,
    `✅ **${setup.divisionDisplayName} scout setup #${setup.id} published**\n${resultMessage.url}`,
  );
  await interaction.editReply({ content: `Scout roster published: ${resultMessage.url}`, components: [] });
  return true;
}

export async function handleScoutPublishedSlotSelect(
  interaction: StringSelectMenuInteraction,
  db: Database.Database,
): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || !['publishedpick', 'publishedswapfirst', 'publishedswapsecond'].includes(parts[1] ?? '')) return false;
  const setupId = Number(parts[2]);
  const version = Number(parts[3]);
  const slotId = Number(interaction.values[0]);
  if (![setupId, version, slotId].every(Number.isInteger)) return false;
  const setup = await authorized(interaction, db, setupId, 'published');
  if (!setup) {
    await interaction.reply({ content: 'You do not have permission to manage this result.', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (parts[1] === 'publishedswapfirst') {
    const slots = listScoutRosterSlots(db, setupId);
    if (!slots.some((slot) => slot.id === slotId)) return false;
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`scout:publishedswapsecond:${setupId}:${version}:${slotId}`)
      .setPlaceholder('Second published player')
      .addOptions(slots.filter((slot) => slot.id !== slotId).map((slot) => new StringSelectMenuOptionBuilder()
        .setLabel(publishedSlotLabel(slot).slice(0, 100))
        .setValue(String(slot.id))));
    await interaction.update({
      content: 'Choose the second player. Players may be swapped across teams, roles, or games.',
      components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu)],
    });
    return true;
  }
  if (parts[1] === 'publishedswapsecond') {
    const firstSlotId = Number(parts[4]);
    if (!Number.isInteger(firstSlotId)) return false;
    const before = listScoutRosterSlots(db, setupId);
    const first = before.find((slot) => slot.id === firstSlotId);
    const second = before.find((slot) => slot.id === slotId);
    if (!first || !second || !setup.resultMessageId) {
      await interaction.update({ content: 'That swap is no longer available.', components: [] });
      return true;
    }
    const channel = await interaction.client.channels.fetch(setup.resultsChannelId).catch(() => undefined);
    const message = channel?.isTextBased()
      ? await channel.messages.fetch(setup.resultMessageId).catch(() => undefined)
      : undefined;
    if (!message) {
      await interaction.update({ content: 'The published result message is unavailable; no swap was made.', components: [] });
      return true;
    }
    if (!swapPublishedScoutRosterSlotsIfVersion(db, setupId, version, firstSlotId, slotId)) {
      await interaction.update({ content: 'That result view was stale; no swap was made.', components: [] });
      return true;
    }
    const updated = getScoutSetupById(db, setupId)!;
    const slots = listScoutRosterSlots(db, setupId);
    try {
      await message.edit({
        content: renderScoutResult(updated, slots),
        components: [managementRow(setupId, updated.version)],
        allowedMentions: { parse: [], users: slots.map((slot) => slot.userId), roles: [] },
      });
    } catch (error) {
      const rolledBack = rollbackPublishedScoutRosterSwap(db, setupId, updated.version, firstSlotId, slotId);
      await interaction.update({
        content: rolledBack
          ? `The result message could not be edited, so no swap was saved. Fix the channel permissions and retry: ${(error as Error).message}`
          : `The result message could not be edited and the swap could not be rolled back safely. Stop and reconcile setup #${setupId}: ${(error as Error).message}`,
        components: [],
      });
      return true;
    }
    const notice = `Roster update: <@${first.userId}> and <@${second.userId}> swapped between ${publishedSlotLabel(first).split(' — ')[0]} and ${publishedSlotLabel(second).split(' — ')[0]}.`;
    const noticeSent = channel?.isSendable()
      ? await channel.send({ content: notice, allowedMentions: { parse: [] } }).then(() => true, () => false)
      : false;
    await interaction.update({
      content: noticeSent ? 'Published roster updated.' : 'Published roster updated, but Ratatoskr could not send the swap notice. Post it manually.',
      components: [],
    });
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
  if (!isScoutUserEligible(replacementMember.roles.cache.keys(), setup.eligibilityRoleId)) {
    await interaction.reply({ content: 'The replacement does not hold this setup\'s eligibility role.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const oldSlot = listScoutRosterSlots(db, setupId).find((slot) => slot.id === slotId);
  const channel = await interaction.client.channels.fetch(setup.resultsChannelId).catch(() => undefined);
  if (!channel?.isTextBased() || !setup.resultMessageId) {
    await interaction.update({ content: 'The published result message is unavailable; no replacement was made.', components: [] });
    return true;
  }
  const message = await channel.messages.fetch(setup.resultMessageId).catch(() => undefined);
  if (!message) {
    await interaction.update({ content: 'The published result message was deleted or cannot be accessed; no replacement was made.', components: [] });
    return true;
  }
  const outcome = replacePublishedScoutRosterSlotIfVersion(db, setupId, version, slotId, userId);
  if (outcome !== 'updated' || !oldSlot) {
    await interaction.update({ content: `No replacement was made (${outcome}).`, components: [] });
    return true;
  }
  const updated = getScoutSetupById(db, setupId)!;
  const slots = listScoutRosterSlots(db, setupId);
  try {
    await message.edit({
      content: renderScoutResult(updated, slots),
      components: [managementRow(setupId, updated.version)],
      allowedMentions: { parse: [], users: slots.map((slot) => slot.userId), roles: [] },
    });
  } catch (error) {
    const rolledBack = rollbackPublishedScoutRosterReplacement(
      db,
      setupId,
      updated.version,
      slotId,
      userId,
      oldSlot.userId,
      oldSlot.staffAssigned,
    );
    await interaction.update({
      content: rolledBack
        ? `The result message could not be edited, so no replacement was saved. Fix the channel permissions and retry: ${(error as Error).message}`
        : `The result message could not be edited and the replacement could not be rolled back safely. Stop and reconcile setup #${setupId}: ${(error as Error).message}`,
      components: [],
    });
    return true;
  }
  if (channel.isSendable()) {
    const noticeSent = await channel.send({
      content: `Roster update: <@${oldSlot.userId}> was replaced by <@${userId}> at ${publishedSlotLabel(oldSlot).split(' — ')[0]}.`,
      allowedMentions: { parse: [] },
    }).then(() => true, () => false);
    await interaction.update({
      content: noticeSent
        ? 'Published roster updated.'
        : 'Published roster updated, but Ratatoskr could not send the replacement notice. Post that notice manually.',
      components: [],
    });
    return true;
  }
  await interaction.update({ content: 'Published roster updated, but this channel cannot accept the replacement notice. Post it manually.', components: [] });
  return true;
}
