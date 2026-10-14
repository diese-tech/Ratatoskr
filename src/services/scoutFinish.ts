import { scoutGameName } from './scoutGamePresentation.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, RESTJSONErrorCodes,
  type ButtonInteraction, type Client } from 'discord.js';
import type Database from 'better-sqlite3';
import { finishScoutSetupIfVersion, getScoutCompletion, getScoutLifecycleCleanup, getScoutSetupById, listPendingScoutCompletions,
  listScoutGameHosts, listScoutRosterSlots, markScoutCompletionReconciled, type ScoutSetup } from '../db/index.js';
import { canManageScoutOperationsSetup } from './scoutCancel.js';
import { refreshScoutStatusCardSafely } from './scoutCardCompatibility.js';
import { renderPersistedScoutResult, scoutResultLinkRow, scoutRosterLinkRow } from './scoutPublish.js';
import { renderScoutSignupPost } from './scoutSignupPost.js';
import { tryAcquireDivisionOperation } from './divisionOperation.js';
import { reportOperationalError, operationalErrorGuidance } from './operationalErrors.js';

export function scoutFinishButtonRow(setupId: number, version: number, retry = false, workflow?: 'scout' | 'inhouse') {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder()
    .setCustomId(`scout:finish:${setupId}:${version}`)
    .setLabel(retry ? 'Retry updating posts' : workflow === 'inhouse' ? 'Finish inhouse' : 'Finish scout').setStyle(ButtonStyle.Secondary));
}

function privateScoutFinishRetryButtonRow(setupId: number, version: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder()
    .setCustomId(`scout:finishretry:${setupId}:${version}`)
    .setLabel('Retry updating posts').setStyle(ButtonStyle.Secondary));
}

async function finishPost(
  client: Client,
  setup: ScoutSetup,
  channelId: string,
  messageId: string | null,
  content: string,
  components: ActionRowBuilder<ButtonBuilder>[] = [],
) {
  if (!messageId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !('guildId' in channel) || channel.guildId !== setup.guildId) {
      throw new Error('The original Scout post channel is unavailable or belongs to another guild.');
    }
    const message = await channel.messages.fetch(messageId);
    await message.edit({ content, components, allowedMentions: { parse: [] } });
  } catch (error) {
    const code = Number((error as { code?: number })?.code);
    if (code !== RESTJSONErrorCodes.UnknownMessage && code !== RESTJSONErrorCodes.UnknownChannel) throw error;
  }
}

/** Only edits original posts. A lost edit response is safe to retry; no send is needed. */
export async function reconcileFinishedScoutPost(
  client: Client,
  db: Database.Database,
  setupId: number,
  options: { reportFailure?: boolean; refreshStatusCard?: boolean } = {},
): Promise<string | undefined> {
  const setup = getScoutSetupById(db, setupId);
  const completion = getScoutCompletion(db, setupId);
  if (!setup || !completion) return undefined;
  const lifecycleCleanup = getScoutLifecycleCleanup(db, setupId);
  try {
    if (!completion.posts_reconciled) {
      const finished = [
        `✅ **This ${setup.workflow === 'inhouse' ? 'inhouse' : 'scout'} is finished. Roster changes are closed.**`,
        lifecycleCleanup?.action === 'finished'
          ? `Finished by <@${lifecycleCleanup.actorUserId}> automatically.`
          : '',
      ].filter(Boolean).join('\n');
      await finishPost(client, setup, setup.signupChannelId, setup.signupMessageId,
        `${renderScoutSignupPost(setup)}\n\n${finished}`,
        [scoutResultLinkRow(setup, 'View final roster')]);
      await finishPost(client, setup, setup.resultsChannelId, setup.resultMessageId,
        `${renderPersistedScoutResult(setup, listScoutRosterSlots(db, setupId), listScoutGameHosts(db, setupId))}\n\n${finished}`,
        [scoutRosterLinkRow(setup)]);
      markScoutCompletionReconciled(db, setupId);
    }
  } catch (error) {
    if (options.reportFailure === false) throw error;
    const report = await reportOperationalError(client, db, { guildId: setup.guildId, setupId,
      division: setup.divisionDisplayName, action: 'Finished Scout post cleanup' }, error);
    return operationalErrorGuidance(report);
  } finally {
    if (options.refreshStatusCard !== false) await refreshScoutStatusCardSafely(client, db, setupId);
  }
  return undefined;
}

export async function reconcileFinishedScoutPosts(client: Client, db: Database.Database): Promise<void> {
  for (const completion of listPendingScoutCompletions(db)) {
    const setup = getScoutSetupById(db, completion.setup_id);
    if (!setup) continue;
    const release = tryAcquireDivisionOperation(db, setup.guildId, setup.divisionKey);
    if (!release) continue;
    try { await reconcileFinishedScoutPost(client, db, setup.id); }
    finally { release(); }
  }
}

export async function handleScoutFinishButton(interaction: ButtonInteraction, db: Database.Database): Promise<boolean> {
  const match = /^scout:(finish|finishconfirm|finishkeep|finishretry):(\d+):(\d+)$/.exec(interaction.customId);
  if (!match) return false;
  const [, action, id, version] = match;
  if (action === 'finish') await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  else await interaction.deferUpdate();
  // Settled published history can outlive an archived division. Current staff
  // authorization and the original division/channel identity still apply.
  const setup = await canManageScoutOperationsSetup(interaction, db, Number(id), false);
  if (!setup || (action === 'finish' && interaction.message.id !== setup.controlMessageId)) {
    await interaction.editReply({ content: 'You cannot finish this game here. Use its latest game controls; you must have permission to manage it.', components: [] });
    return true;
  }
  const release = tryAcquireDivisionOperation(db, setup.guildId, setup.divisionKey);
  if (!release) {
    await interaction.editReply({ content: 'Another operation is running for this division. Try again shortly.', components: [] });
    return true;
  }
  try {
    if (action === 'finishkeep') {
      await interaction.editReply({ content: 'No changes made.', components: [] });
      return true;
    }
    const existing = getScoutCompletion(db, setup.id);
    if (action === 'finishretry' && (!existing || setup.version !== Number(version))) {
      await refreshScoutStatusCardSafely(interaction.client, db, setup.id);
      await interaction.editReply({ content: 'These controls are out of date. Open the game’s latest status card to retry updating its posts.', components: [] });
      return true;
    }
    if (!existing && setup.version !== Number(version)) {
      await refreshScoutStatusCardSafely(interaction.client, db, setup.id);
      await interaction.editReply({ content: 'The roster changed since you opened it. Use the game’s latest status card.', components: [] });
      return true;
    }
    if (setup.status !== 'published') {
      await interaction.editReply({ content: 'Teams must be posted before you can finish a game. To stop signups instead, use Cancel setup.', components: [] });
      return true;
    }
    if (action === 'finish' && !existing) {
      await interaction.editReply({ content: `Finish the **${scoutGameName(setup)}** at <t:${setup.startAt}:F>? This keeps the roster and signup history, closes player edits, and cannot be undone.`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`scout:finishconfirm:${setup.id}:${setup.version}`).setLabel('Confirm finish').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`scout:finishkeep:${setup.id}:${setup.version}`).setLabel('Keep open').setStyle(ButtonStyle.Secondary),
        )], allowedMentions: { parse: [] } });
      return true;
    }
    if (action === 'finishretry') {
      const error = await reconcileFinishedScoutPost(interaction.client, db, setup.id);
      await interaction.editReply({ content: error ? `The game is marked as finished, but Rat still needs to update its Discord posts. ${error}` : 'Game finished. The roster and signups are kept for history; players can no longer be changed.',
        components: error ? [privateScoutFinishRetryButtonRow(setup.id, setup.version)] : [] });
      return true;
    }
    const outcome = finishScoutSetupIfVersion(db, setup.id, Number(version), interaction.user.id);
    if (outcome !== 'finished' && outcome !== 'already_finished') {
      await interaction.editReply({ content: outcome === 'pending'
        ? 'Rat still needs to finish posting or updating the teams. Wait for that to finish before ending the game.'
        : 'This game changed. Use its latest status card.', components: [] });
      return true;
    }
    const error = await reconcileFinishedScoutPost(interaction.client, db, setup.id);
    await interaction.editReply({ content: error ? `The game is marked as finished, but Rat still needs to update its Discord posts. ${error}` : 'Game finished. The roster and signups are kept for history; players can no longer be changed.',
      components: error ? [privateScoutFinishRetryButtonRow(setup.id, getScoutSetupById(db, setup.id)!.version)] : [] });
    return true;
  } finally { release(); }
}
