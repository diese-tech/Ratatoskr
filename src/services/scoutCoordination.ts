import type Database from 'better-sqlite3';
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
import {
  appendScoutEvent,
  changeScoutGameHostIfVersion,
  changeScoutOrganizerIfVersion,
  getDivisionByKey,
  getScoutCompletion,
  getScoutConfig,
  getScoutSetupById,
  listScoutGameHosts,
  listScoutRosterSlots,
  scheduleScoutNotification,
  scheduleScoutNotificationIfCooldownAvailable,
} from '../db/index.js';
import { hasScoutDivisionManagementAccess } from './scoutAuthorization.js';
import { refreshScoutStatusCardSafely } from './scoutCardLifecycle.js';
import { formatScoutSlotLabel, resolveScoutPlayerNames } from './scoutPlayerNames.js';
import { publishedRosterRows, renderPersistedScoutResult } from './scoutPublish.js';

async function activePublishedSetup(interaction: MessageComponentInteraction, db: Database.Database, setupId: number) {
  const setup = getScoutSetupById(db, setupId);
  if (!setup || setup.guildId !== interaction.guildId || setup.resultsChannelId !== interaction.channelId ||
      setup.status !== 'published' || !setup.resultMessageId || !setup.signupPostReconciled ||
      getScoutCompletion(db, setupId) || !interaction.guild) return undefined;
  return setup;
}

async function managerCanAct(interaction: MessageComponentInteraction, db: Database.Database, setupId: number) {
  const setup = await activePublishedSetup(interaction, db, setupId);
  if (!setup) return undefined;
  const division = getDivisionByKey(db, setup.guildId, setup.divisionKey);
  if (!division || division.id !== setup.divisionId || division.status !== 'active') return undefined;
  const member = await interaction.guild!.members.fetch(interaction.user.id);
  const config = getScoutConfig(db, setup.guildId);
  const { hasAccess } = await import('./authorization.js');
  return hasScoutDivisionManagementAccess(db, member, config, division, hasAccess(member, 'ADMIN')) ? setup : undefined;
}

async function refreshPublishedPresentation(interaction: MessageComponentInteraction, db: Database.Database, setupId: number) {
  const setup = getScoutSetupById(db, setupId)!;
  const channel = await interaction.client.channels.fetch(setup.resultsChannelId).catch(() => undefined);
  const message = channel?.isTextBased()
    ? await channel.messages.fetch(setup.resultMessageId!).catch(() => undefined)
    : undefined;
  if (message) await message.edit({
    content: renderPersistedScoutResult(setup, listScoutRosterSlots(db, setupId), listScoutGameHosts(db, setupId)),
    components: publishedRosterRows(setup),
    allowedMentions: { parse: [] },
  });
  await refreshScoutStatusCardSafely(interaction.client, db, setupId);
}

export async function handleScoutCoordinationButton(
  interaction: ButtonInteraction,
  db: Database.Database,
): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || ![
    'pingroster', 'pingrosterconfirm', 'pingrosterback', 'pingorganizer',
    'changehost', 'changeorganizer',
  ].includes(parts[1] ?? '')) return false;
  const setupId = Number(parts[2]);
  const expectedVersion = Number(parts[3]);
  if (!Number.isInteger(setupId) || !Number.isInteger(expectedVersion)) return false;
  if (['pingroster', 'pingorganizer', 'changehost', 'changeorganizer'].includes(parts[1]!)) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } else await interaction.deferUpdate();

  if (parts[1] === 'pingorganizer') {
    const setup = await activePublishedSetup(interaction, db, setupId);
    const gameNumber = Number(parts[4]) as 1 | 2;
    const host = setup && listScoutGameHosts(db, setupId).find((candidate) => candidate.gameNumber === gameNumber);
    if (!setup || setup.version !== expectedVersion || !host || host.lobbyHostUserId !== interaction.user.id || !setup.operationsChannelId) {
      await interaction.editReply({ content: 'Only the current Lobby Host for that game can ping the Organizer.', components: [] });
      return true;
    }
    const now = Math.floor(Date.now() / 1_000);
    const scheduled = db.transaction(() => {
      const outcome = scheduleScoutNotificationIfCooldownAvailable(db, {
        setupId, gameNumber, kind: 'host_organizer', dedupeKey: `host:${setupId}:${gameNumber}:${now}`,
        nonce: `h${setupId}-${gameNumber}-${now}`.slice(0, 25), channelId: setup.operationsChannelId!,
        dueAt: now, cooldownSince: now - 60,
      });
      if (outcome.status === 'created') appendScoutEvent(db, {
        setupId, setupVersion: setup.version, eventType: 'organizer_ping_scheduled',
        actorUserId: interaction.user.id, payload: { gameNumber },
      });
      return outcome;
    })();
    await interaction.editReply({ content: scheduled.status === 'created'
      ? 'The current Organizer will be pinged in Scout Ops.'
      : 'The Organizer was pinged recently. Please wait before trying again.', components: [] });
    return true;
  }

  const setup = await managerCanAct(interaction, db, setupId);
  if (!setup || setup.version !== expectedVersion) {
    await interaction.editReply({ content: 'You are not authorized or that roster view is stale.', components: [] });
    return true;
  }
  if (parts[1] === 'pingrosterback') {
    await interaction.editReply({ content: 'Roster ping cancelled.', components: [] });
    return true;
  }
  if (parts[1] === 'pingroster') {
    await interaction.editReply({
      content: `**Ping the current roster?**\nThis will notify all ${listScoutRosterSlots(db, setupId).length} currently rostered players.`,
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`scout:pingrosterconfirm:${setupId}:${expectedVersion}`)
          .setLabel('Ping roster').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`scout:pingrosterback:${setupId}:${expectedVersion}`)
          .setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      )],
    });
    return true;
  }
  if (parts[1] === 'pingrosterconfirm') {
    const now = Math.floor(Date.now() / 1_000);
    const scheduled = db.transaction(() => {
      const outcome = scheduleScoutNotificationIfCooldownAvailable(db, {
        setupId, gameNumber: null, kind: 'manual_roster', dedupeKey: `manual:${setupId}:${now}`,
        nonce: `m${setupId}-${now}`.slice(0, 25), channelId: setup.resultsChannelId,
        dueAt: now, cooldownSince: now - 5 * 60,
      });
      if (outcome.status === 'created') appendScoutEvent(db, {
        setupId, setupVersion: setup.version, eventType: 'manual_roster_ping_scheduled',
        actorUserId: interaction.user.id,
      });
      return outcome;
    })();
    await interaction.editReply({ content: scheduled.status === 'created'
      ? 'The current roster ping is queued.'
      : 'This roster was pinged recently. Please wait before trying again.', components: [] });
    return true;
  }
  if (parts[1] === 'changehost') {
    const slots = listScoutRosterSlots(db, setupId).filter((slot) => !slot.replacementNeeded);
    const names = await resolveScoutPlayerNames(interaction.guild!, slots.map((slot) => slot.userId));
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`scout:changehostpick:${setupId}:${expectedVersion}`)
      .setPlaceholder('Game and new Lobby Host')
      .addOptions(slots.map((slot) => new StringSelectMenuOptionBuilder()
        .setLabel(formatScoutSlotLabel(slot, names.get(slot.userId))).setValue(`${slot.gameNumber}|${slot.userId}`)));
    await interaction.editReply({ content: 'Choose a current player as that game’s Lobby Host.', components: [
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu),
    ] });
    return true;
  }
  const menu = new UserSelectMenuBuilder()
    .setCustomId(`scout:changeorganizerpick:${setupId}:${expectedVersion}`)
    .setPlaceholder('New Organizer');
  await interaction.editReply({ content: 'Choose the new setup Organizer.', components: [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu),
  ] });
  return true;
}

export async function handleScoutCoordinationStringSelect(
  interaction: StringSelectMenuInteraction,
  db: Database.Database,
): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || parts[1] !== 'changehostpick') return false;
  const setupId = Number(parts[2]);
  const expectedVersion = Number(parts[3]);
  if (!Number.isInteger(setupId) || !Number.isInteger(expectedVersion)) return false;
  await interaction.deferUpdate();
  const setup = await managerCanAct(interaction, db, setupId);
  const [rawGame, userId] = (interaction.values[0] ?? '').split('|');
  const gameNumber = Number(rawGame) as 1 | 2;
  if (!setup || setup.version !== expectedVersion || !userId || ![1, 2].includes(gameNumber)) {
    await interaction.editReply({ content: 'That Host selection is stale or unauthorized.', components: [] });
    return true;
  }
  const outcome = changeScoutGameHostIfVersion(
    db, setupId, expectedVersion, gameNumber, userId, interaction.user.id,
  );
  if (outcome === 'updated') {
    const now = Math.floor(Date.now() / 1_000);
    scheduleScoutNotification(db, {
      setupId, gameNumber, kind: 'host_change', dedupeKey: `host-change:${setupId}:${expectedVersion + 1}`,
      nonce: `c${setupId}-${expectedVersion + 1}`, channelId: setup.resultsChannelId,
      dueAt: now,
    });
    await refreshPublishedPresentation(interaction, db, setupId);
  }
  await interaction.editReply({ content: outcome === 'updated' ? 'Lobby Host changed.' : `No Host change was made (${outcome}).`, components: [] });
  return true;
}

export async function handleScoutCoordinationUserSelect(
  interaction: UserSelectMenuInteraction,
  db: Database.Database,
): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || parts[1] !== 'changeorganizerpick') return false;
  const setupId = Number(parts[2]);
  const expectedVersion = Number(parts[3]);
  if (!Number.isInteger(setupId) || !Number.isInteger(expectedVersion)) return false;
  await interaction.deferUpdate();
  const setup = await managerCanAct(interaction, db, setupId);
  const userId = interaction.values[0];
  if (!setup || setup.version !== expectedVersion || !userId || interaction.users.get(userId)?.bot) {
    await interaction.editReply({ content: 'That Organizer selection is stale or invalid.', components: [] });
    return true;
  }
  const outcome = changeScoutOrganizerIfVersion(db, setupId, expectedVersion, userId, interaction.user.id);
  if (outcome === 'updated') await refreshPublishedPresentation(interaction, db, setupId);
  await interaction.editReply({ content: outcome === 'updated' ? 'Organizer changed.' : `No Organizer change was made (${outcome}).`, components: [] });
  return true;
}
