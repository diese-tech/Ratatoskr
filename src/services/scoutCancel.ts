import { reportOperationalError, operationalErrorGuidance } from './operationalErrors.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Client,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type Database from 'better-sqlite3';
import {
  cancelScoutSetupIfVersion,
  getDivisionByKey,
  listDivisions,
  getScoutConfig,
  getScoutSetupById,
  listCancelledScoutSetupsNeedingSignupPostReconciliation,
  listCancellableScoutSetups,
  markCancelledScoutSignupPostReconciled,
  type ScoutSetup,
} from '../db/index.js';
import { hasScoutDivisionManagementAccess, isScoutOperationsChannel } from './scoutAuthorization.js';
import { renderScoutSignupPost } from './scoutSignupPost.js';
import { refreshScoutStatusCardSafely } from './scoutCardLifecycle.js';
import { tryAcquireDivisionOperation } from './divisionOperation.js';
import { withFinalScoutReadiness } from './scoutReadiness.js';

export function scoutCancelButton(setupId: number, version: number): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`scout:cancel:${setupId}:${version}`)
    .setLabel('Cancel setup')
    .setStyle(ButtonStyle.Danger);
}

export function scoutCancelButtonRow(setupId: number, version: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(scoutCancelButton(setupId, version));
}

async function canManageSetup(
  interaction: MessageComponentInteraction,
  db: Database.Database,
  setupId: number,
): Promise<ScoutSetup | undefined> {
  const setup = getScoutSetupById(db, setupId);
  if (!setup || setup.guildId !== interaction.guildId || !interaction.guild) return undefined;
  if (!isScoutOperationsChannel(setup, interaction.channelId)) return undefined;
  const division = getDivisionByKey(db, setup.guildId, setup.divisionKey);
  if (!division || division.id !== setup.divisionId || division.status !== 'active') return undefined;
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const config = getScoutConfig(db, setup.guildId);
  const { hasAccess } = await import('./authorization.js');
  return hasScoutDivisionManagementAccess(db, member, config, division, hasAccess(member, 'ADMIN')) ? setup : undefined;
}

function confirmation(setup: ScoutSetup) {
  return {
    content: `Cancel **${setup.divisionDisplayName} scout setup #${setup.id}** at <t:${setup.startAt}:F>? Signups will close and this cannot be undone.${setup.signupMessageId ? `\nhttps://discord.com/channels/${setup.guildId}/${setup.signupChannelId}/${setup.signupMessageId}` : ''}`,
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

export async function reconcileCancelledScoutSignupPost(
  client: Client,
  db: Database.Database,
  setup: ScoutSetup,
): Promise<string | undefined> {
  try {
    const channel = await client.channels.fetch(setup.signupChannelId);
    if (!channel?.isTextBased() || !setup.signupMessageId) throw new Error('The original signup post is unavailable.');
    const message = await channel.messages.fetch(setup.signupMessageId);
    await message.edit({
      content: `${renderScoutSignupPost(setup)}\n\n🚫 **This scout setup was cancelled.**`,
      components: [],
      allowedMentions: { parse: [] },
    });
    await message.reactions.removeAll();
    if (!setup.signupPostReconciled && !markCancelledScoutSignupPostReconciled(db, setup.id)) {
      const current = getScoutSetupById(db, setup.id);
      if (!current?.signupPostReconciled) throw new Error('The signup post was updated, but reconciliation could not be recorded.');
    }
    await refreshScoutStatusCardSafely(client, db, setup.id);
    return undefined;
  } catch (error) {
    const report = await reportOperationalError(client, db, { guildId: setup.guildId, setupId: setup.id, division: setup.divisionDisplayName, action: 'Scout cancellation recovery' }, error);
    return operationalErrorGuidance(report);
  }
}

export async function reconcileCancelledScoutSignupPosts(client: Client, db: Database.Database): Promise<void> {
  for (const setup of listCancelledScoutSetupsNeedingSignupPostReconciliation(db)) {
    await reconcileCancelledScoutSignupPost(client, db, setup);
    // The repair function already reports failures with a correlation reference.
  }
}

async function showCancellationPage(
  interaction: ChatInputCommandInteraction | ButtonInteraction, db: Database.Database, requestedPage = 0,
): Promise<void> {
  if (!interaction.guild) return;
  const config = getScoutConfig(db, interaction.guild.id);
  if (!config?.operationsChannelId || interaction.channelId !== config.operationsChannelId) {
    await interaction.editReply({ content: 'Run `/scout cancel` from the configured `scout-ops` channel.', components: [] });
    return;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const { hasAccess } = await import('./authorization.js');
  const manageable = new Set(listDivisions(db, interaction.guild.id)
    .filter((division) => division.status === 'active' && hasScoutDivisionManagementAccess(db, member, config, division, hasAccess(member, 'ADMIN')))
    .map((division) => division.id));
  const setups = listCancellableScoutSetups(db, interaction.guild.id)
    .filter((setup) => manageable.has(setup.divisionId) && setup.operationsChannelId === interaction.channelId);
  if (!setups.length) {
    await interaction.editReply({ content: 'There are no active scout postings you can cancel.', components: [] });
    return;
  }
  const pages = Math.ceil(setups.length / 25);
  const page = Math.max(0, Math.min(requestedPage, pages - 1));
  const format = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const menu = new StringSelectMenuBuilder().setCustomId('scout:cancelpick:all')
    .setPlaceholder('Choose an active scout posting')
    .addOptions(setups.slice(page * 25, (page + 1) * 25).map((setup) => new StringSelectMenuOptionBuilder()
      .setLabel(`${setup.divisionDisplayName.slice(0, 35)} — ${format.format(setup.startAt * 1000)}`.slice(0, 100))
      .setDescription(`#${setup.id} · ${setup.status === 'roster_ready' ? 'Roster ready' : 'Accepting signups'}`)
      .setValue(`${setup.id}:${setup.version}`)));
  const components: (ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>)[] = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)];
  if (pages > 1) components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`scout:cancelpage:${page - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
    new ButtonBuilder().setCustomId(`scout:cancelpage:${page + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1),
  ));
  await interaction.editReply({ content: `Choose an active scout posting to cancel. Page ${page + 1}/${pages}. Selection is followed by confirmation.`, components, allowedMentions: { parse: [] } });
}

export async function handleScoutCancelCommand(interaction: ChatInputCommandInteraction, db: Database.Database): Promise<void> {
  if (!interaction.guild) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await showCancellationPage(interaction, db);
}

export async function handleScoutCancelSelect(
  interaction: StringSelectMenuInteraction,
  db: Database.Database,
): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || parts[1] !== 'cancelpick') return false;
  const allDivisions = parts[2] === 'all';
  const divisionId = Number(parts[2]);
  const [idValue, versionValue] = (interaction.values[0] ?? '').split(':');
  const setupId = Number(idValue);
  const version = versionValue === undefined ? undefined : Number(versionValue);
  if (!Number.isSafeInteger(setupId) || (!allDivisions && !Number.isSafeInteger(divisionId)) || (allDivisions && !Number.isSafeInteger(version))) return false;
  await interaction.deferUpdate();
  const setup = await canManageSetup(interaction, db, setupId);
  const config = interaction.guildId ? getScoutConfig(db, interaction.guildId) : undefined;
  if (!setup || (!allDivisions && setup.divisionId !== divisionId) || config?.operationsChannelId !== interaction.channelId) {
    await interaction.editReply({ content: 'That setup is no longer available to you.', components: [] });
    return true;
  }
  if (version !== undefined && setup.version !== version) {
    await interaction.editReply({ content: 'That posting changed. Run /scout cancel again to refresh the list.', components: [] });
    return true;
  }
  if (!['open', 'roster_ready'].includes(setup.status)) {
    await interaction.editReply({
      content: setup.status === 'published' ? publishedDirection(setup) : 'That setup is no longer cancellable.',
      components: [],
    });
    return true;
  }
  await interaction.editReply(confirmation(setup));
  return true;
}

export async function handleScoutCancelButton(
  interaction: ButtonInteraction,
  db: Database.Database,
): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] === 'scout' && parts[1] === 'cancelpage') {
    const page = Number(parts[2]);
    if (!Number.isSafeInteger(page)) return false;
    await interaction.deferUpdate();
    await showCancellationPage(interaction, db, page);
    return true;
  }
  if (parts[0] !== 'scout' || !['cancel', 'cancelconfirm', 'cancelkeep'].includes(parts[1] ?? '')) return false;
  const setupId = Number(parts[2]);
  const expectedVersion = Number(parts[3]);
  if (![setupId, expectedVersion].every(Number.isInteger)) return false;
  if (parts[1] === 'cancel') await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  else await interaction.deferUpdate();
  const setup = await canManageSetup(interaction, db, setupId);
  if (!setup) {
    await interaction.editReply({ content: 'You do not have permission to cancel this scout setup.' });
    return true;
  }

  const release = tryAcquireDivisionOperation(db, setup.guildId, setup.divisionKey);
  if (!release) {
    await interaction.editReply({ content: 'This division has an operation in progress. Retry when it finishes.', components: [] });
    return true;
  }
  try {
    if (parts[1] === 'cancelkeep') {
      await interaction.editReply({
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
      if (parts[1] === 'cancel') await interaction.editReply({ ...response });
      else await interaction.editReply(response);
      return true;
    }
    if (setup.status === 'cancelled' && parts[1] === 'cancel') {
      const error = await reconcileCancelledScoutSignupPost(interaction.client, db, setup);
      await interaction.editReply({
        content: error
          ? `This setup is cancelled, but its post still could not be repaired: ${error}`
          : `Scout setup #${setup.id} was already cancelled; its signup post is now reconciled.`,
      });
      return true;
    }
    if (!['open', 'roster_ready'].includes(setup.status)) {
      const response = { content: 'That scout setup is no longer cancellable.', components: [] };
      if (parts[1] === 'cancel') await interaction.editReply({ ...response });
      else await interaction.editReply(response);
      return true;
    }
    if (parts[1] === 'cancel') {
      await interaction.editReply({ ...confirmation(setup) });
      return true;
    }

    const outcome = await withFinalScoutReadiness(interaction.client, db, setup.id,
      () => cancelScoutSetupIfVersion(db, setup.id, expectedVersion));
    if (outcome !== 'cancelled') {
      await interaction.editReply({
        content: outcome === 'published' ? publishedDirection(getScoutSetupById(db, setup.id) ?? setup) : 'That cancellation was stale or already applied.',
        components: [],
      });
      return true;
    }

    const postError = await reconcileCancelledScoutSignupPost(interaction.client, db, setup);
    if (!postError) {
      await interaction.editReply({ content: `Scout setup #${setup.id} was cancelled.`, components: [] });
    } else {
      await interaction.editReply({
        content: `Scout setup #${setup.id} was cancelled, but its original post could not be updated: ${postError}. Ratatoskr will retry automatically after restart; you can also use this button to retry now.`,
        components: [scoutCancelButtonRow(setup.id, setup.version)],
      });
    }
    return true;
  } finally { release(); }
}
