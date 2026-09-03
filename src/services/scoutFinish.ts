import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, RESTJSONErrorCodes,
  type ButtonInteraction, type Client } from 'discord.js';
import type Database from 'better-sqlite3';
import { finishScoutSetupIfVersion, getScoutCompletion, getScoutSetupById, listPendingScoutCompletions,
  listScoutRosterSlots, markScoutCompletionReconciled, type ScoutSetup } from '../db/index.js';
import { canManageScoutOperationsSetup } from './scoutCancel.js';
import { refreshScoutStatusCardSafely } from './scoutCardLifecycle.js';
import { renderPersistedScoutResult } from './scoutPublish.js';
import { renderScoutSignupPost } from './scoutSignupPost.js';
import { tryAcquireDivisionOperation } from './divisionOperation.js';
import { reportOperationalError, operationalErrorGuidance } from './operationalErrors.js';

export function scoutFinishButtonRow(setupId: number, version: number, retry = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder()
    .setCustomId(`scout:finish:${setupId}:${version}`)
    .setLabel(retry ? 'Retry post cleanup' : 'Finish scout').setStyle(ButtonStyle.Secondary));
}

async function finishPost(client: Client, setup: ScoutSetup, channelId: string, messageId: string | null, content: string) {
  if (!messageId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased() || !('guildId' in channel) || channel.guildId !== setup.guildId) {
      throw new Error('The original Scout post channel is unavailable or belongs to another guild.');
    }
    const message = await channel.messages.fetch(messageId);
    await message.edit({ content, components: [], allowedMentions: { parse: [] } });
  } catch (error) {
    const code = Number((error as { code?: number })?.code);
    if (code !== RESTJSONErrorCodes.UnknownMessage && code !== RESTJSONErrorCodes.UnknownChannel) throw error;
  }
}

/** Only edits original posts. A lost edit response is safe to retry; no send is needed. */
export async function reconcileFinishedScoutPost(client: Client, db: Database.Database, setupId: number): Promise<string | undefined> {
  const setup = getScoutSetupById(db, setupId);
  const completion = getScoutCompletion(db, setupId);
  if (!setup || !completion) return undefined;
  try {
    if (!completion.posts_reconciled) {
      const finished = `✅ **This scout is finished. Roster changes are closed.**`;
      await finishPost(client, setup, setup.signupChannelId, setup.signupMessageId,
        `${renderScoutSignupPost(setup)}\n\n${finished}\nRoster: https://discord.com/channels/${setup.guildId}/${setup.resultsChannelId}/${setup.resultMessageId}`);
      await finishPost(client, setup, setup.resultsChannelId, setup.resultMessageId,
        `${renderPersistedScoutResult(setup, listScoutRosterSlots(db, setupId))}\n\n${finished}`);
      markScoutCompletionReconciled(db, setupId);
    }
  } catch (error) {
    const report = await reportOperationalError(client, db, { guildId: setup.guildId, setupId,
      division: setup.divisionDisplayName, action: 'Finished Scout post cleanup' }, error);
    return operationalErrorGuidance(report);
  } finally {
    await refreshScoutStatusCardSafely(client, db, setupId);
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
  const match = /^scout:(finish|finishconfirm|finishkeep):(\d+):(\d+)$/.exec(interaction.customId);
  if (!match) return false;
  const [, action, id, version] = match;
  if (action === 'finish') await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  else await interaction.deferUpdate();
  // Settled published history can outlive an archived division. Current staff
  // authorization and the original division/channel identity still apply.
  const setup = await canManageScoutOperationsSetup(interaction, db, Number(id), false);
  if (!setup) {
    await interaction.editReply({ content: 'You do not have permission to finish this scout from this channel.', components: [] });
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
    if (!existing && setup.version !== Number(version)) {
      await refreshScoutStatusCardSafely(interaction.client, db, setup.id);
      await interaction.editReply({ content: 'This roster view is stale. Use the current Scout Ops card.', components: [] });
      return true;
    }
    if (setup.status !== 'published') {
      await interaction.editReply({ content: 'Only published scouts can be finished. Use Cancel setup for an open posting.', components: [] });
      return true;
    }
    if (action === 'finish' && !existing) {
      await interaction.editReply({ content: `Finish **${setup.divisionDisplayName} scout #${setup.id}** at <t:${setup.startAt}:F>? This keeps the roster and signup history, closes player edits, and cannot be undone.`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`scout:finishconfirm:${setup.id}:${setup.version}`).setLabel('Confirm finish').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`scout:finishkeep:${setup.id}:${setup.version}`).setLabel('Keep open').setStyle(ButtonStyle.Secondary),
        )], allowedMentions: { parse: [] } });
      return true;
    }
    const outcome = finishScoutSetupIfVersion(db, setup.id, Number(version), interaction.user.id);
    if (outcome !== 'finished' && outcome !== 'already_finished') {
      await interaction.editReply({ content: outcome === 'pending'
        ? 'Publication or a roster update is still pending. Let recovery complete before finishing this scout.'
        : 'This scout changed. Use the current Scout Ops card.', components: [] });
      return true;
    }
    const error = await reconcileFinishedScoutPost(interaction.client, db, setup.id);
    await interaction.editReply({ content: error ? `Scout finished in the records. Discord post cleanup is pending. ${error}` : 'Scout finished. The roster and signup history are retained; player edits are closed.',
      components: error ? [scoutFinishButtonRow(setup.id, getScoutSetupById(db, setup.id)!.version, true)] : [] });
    return true;
  } finally { release(); }
}
