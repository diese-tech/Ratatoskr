import type Database from 'better-sqlite3';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
} from 'discord.js';
import {
  getScoutCompletion,
  getScoutSetupById,
  listScoutRosterSlots,
  markScoutPlayerUnavailableIfVersion,
} from '../db/index.js';
import { SCOUT_ROLE_LABELS } from '../domain/index.js';
import { refreshScoutStatusCardSafely } from './scoutCardLifecycle.js';
import { reconcileScoutPublishedPresentation } from './scoutPublish.js';
import { operationalErrorGuidance, reportOperationalError } from './operationalErrors.js';

export async function handleScoutAvailabilityButton(
  interaction: ButtonInteraction,
  db: Database.Database,
): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || !['cantplay', 'cantplayconfirm', 'cantplayback'].includes(parts[1] ?? '')) return false;
  const setupId = Number(parts[2]);
  const expectedVersion = Number(parts[3]);
  if (!Number.isInteger(setupId) || !Number.isInteger(expectedVersion)) return false;
  if (parts[1] === 'cantplay') await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  else await interaction.deferUpdate();

  const setup = getScoutSetupById(db, setupId);
  const seated = setup && listScoutRosterSlots(db, setupId).find((slot) => slot.userId === interaction.user.id);
  if (!setup || setup.guildId !== interaction.guildId || setup.resultsChannelId !== interaction.channelId ||
      setup.status !== 'published' || !setup.resultMessageId || interaction.message.id !== setup.resultMessageId ||
      getScoutCompletion(db, setupId) || !seated) {
    await interaction.editReply({ content: 'Only a player currently seated on this active roster can use Can’t play.', components: [] });
    return true;
  }
  if (parts[1] === 'cantplayback') {
    await interaction.editReply({ content: 'Your roster seat was not changed.', components: [] });
    return true;
  }
  if (parts[1] === 'cantplay') {
    if (setup.version !== expectedVersion) {
      await interaction.editReply({ content: 'That roster changed. Use Can’t play on the current roster.', components: [] });
      return true;
    }
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`scout:cantplayconfirm:${setupId}:${expectedVersion}`)
        .setLabel('Confirm').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`scout:cantplayback:${setupId}:${expectedVersion}`)
        .setLabel('Never mind').setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({
      content: `**Can’t make this scout?**\nThis will keep you in ${seated.team === 'team_one' ? 'Order' : 'Chaos'} ${SCOUT_ROLE_LABELS[seated.role]} while notifying the Organizer that your seat needs a replacement.`,
      components: [row],
    });
    return true;
  }

  const outcome = markScoutPlayerUnavailableIfVersion(db, {
    setupId, expectedVersion, userId: interaction.user.id, now: Math.floor(Date.now() / 1_000),
  });
  if (outcome.status === 'stale' || outcome.status === 'not_rostered') {
    await interaction.editReply({ content: 'That roster changed; no availability flag was added.', components: [] });
    return true;
  }
  const current = getScoutSetupById(db, setupId)!;
  if (outcome.status === 'updated') {
    try {
      await reconcileScoutPublishedPresentation(interaction.client, db, setupId);
    } catch (error) {
      const report = await reportOperationalError(interaction.client, db, {
        guildId: current.guildId, setupId, division: current.divisionDisplayName,
        action: 'Availability roster presentation',
        next: 'The availability flag is saved; startup recovery will retry the canonical roster edit.',
      }, error);
      await refreshScoutStatusCardSafely(interaction.client, db, setupId);
      await interaction.editReply({
        content: `Your seat is marked as needing a replacement. The roster display update is pending recovery. ${operationalErrorGuidance(report)}`,
        components: [],
      });
      return true;
    }
  }
  await refreshScoutStatusCardSafely(interaction.client, db, setupId);
  await interaction.editReply({
    content: outcome.status === 'unchanged'
      ? 'Your seat was already marked as needing a replacement; the Organizer was not notified again.'
      : 'Your seat is marked as needing a replacement and the Organizer will be notified.',
    components: [],
  });
  return true;
}
