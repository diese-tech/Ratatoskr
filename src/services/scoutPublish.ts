import { formatScoutSlotLabel, resolveScoutPlayerNames } from './scoutPlayerNames.js';
import { reportOperationalError, operationalErrorGuidance } from './operationalErrors.js';
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
import { tryAcquireDivisionOperation } from './divisionOperation.js';
import {
  prepareScoutPublication,
  getDivisionByKey,
  getScoutConfig,
  getScoutSetupById,
  listScoutPublishesNeedingReconciliation,
  listScoutRosterSlots,
  listScoutSignups,
  listScoutGameHosts,
  markPublishedScoutSignupPostReconciled,
  getScoutRosterUpdate,
  getScoutCompletion,
  listScoutRosterUpdates,
  markScoutRosterUpdateEdited,
  markScoutRosterNoticeAttempted,
  completeScoutRosterUpdate,
  replacePublishedScoutRosterCandidateIfVersion,
  setScoutPendingResultMessage,
  swapPublishedScoutRosterSlotsIfVersion,
  type ScoutGameHost,
  type ScoutSetup,
} from '../db/index.js';
import {
  hasScoutDivisionManagementAccess,
  isScoutOperationsChannel,
  isScoutResultsChannel,
} from './scoutAuthorization.js';
import { renderScoutResult } from './scoutResults.js';
import { refreshScoutStatusCardSafely } from './scoutCardCompatibility.js';
import { renderScoutSignupPost } from './scoutSignupPost.js';
import { eligibleScoutSignups, isScoutUserEligible, resolveEligibleScoutUserIds } from './scoutEligibility.js';
import { withFinalScoutReadiness } from './scoutReadiness.js';
import { rankScoutReplacementCandidates } from './scoutReplacementCandidates.js';

export function renderPersistedScoutResult(
  setup: ScoutSetup,
  slots: ReturnType<typeof listScoutRosterSlots>,
  hosts: readonly ScoutGameHost[] = [],
): string {
  return renderScoutResult({ ...setup, hosts }, slots);
}

function resultHasSetupControls(message: { components: unknown }, setupId: number): boolean {
  return new RegExp(`scout:(?:published[^\"\\\\:]*|cantplay|pingorganizer):${setupId}(?::|\")`)
    .test(JSON.stringify(message.components));
}

export function scoutRosterLinkRow(setup: ScoutSetup, label = 'View original signup') {
  if (!setup.signupMessageId) return new ActionRowBuilder<ButtonBuilder>();
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel(label)
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${setup.guildId}/${setup.signupChannelId}/${setup.signupMessageId}`),
  );
}

export function scoutResultLinkRow(setup: ScoutSetup, label = 'View roster') {
  if (!setup.resultMessageId) return new ActionRowBuilder<ButtonBuilder>();
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel(label)
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${setup.guildId}/${setup.resultsChannelId}/${setup.resultMessageId}`),
  );
}

export function publishedRosterRows(setup: ScoutSetup) {
  const publicRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`scout:cantplay:${setup.id}:${setup.version}`)
      .setLabel("Can't play").setStyle(ButtonStyle.Danger),
    ...Array.from({ length: setup.gameCount }, (_, index) => new ButtonBuilder()
      .setCustomId(`scout:pingorganizer:${setup.id}:${setup.version}:${index + 1}`)
      .setLabel(setup.gameCount === 1 ? 'Ping organizer' : `Ping organizer · Game ${index + 1}`)
      .setStyle(ButtonStyle.Secondary)),
    ...(setup.signupMessageId ? [new ButtonBuilder()
      .setLabel('View original signup')
      .setStyle(ButtonStyle.Link)
      .setURL(`https://discord.com/channels/${setup.guildId}/${setup.signupChannelId}/${setup.signupMessageId}`)] : []),
  );
  return [managementRow(setup.id, setup.version), publicRow];
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
      message.author.id === client.user?.id && resultHasSetupControls(message, setup.id));
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
  const current = getScoutSetupById(db, setup.id) ?? setup;
  const currentHosts = listScoutGameHosts(db, setup.id);
  if ('edit' in resultMessage && typeof resultMessage.edit === 'function') {
    await resultMessage.edit({
      content: renderScoutResult({ ...current, hosts: currentHosts }, listScoutRosterSlots(db, setup.id)),
      components: publishedRosterRows(current),
      allowedMentions: { parse: [] },
    });
  }
  await signupMessage.edit({
    content: `${renderScoutSignupPost(setup)}\n\n✅ Roster published: ${resultMessage.url}`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setLabel('View roster').setStyle(ButtonStyle.Link).setURL(resultMessage.url),
    )],
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
        throw new Error('Publication is claimed but the result send is delivery-uncertain; no automatic resend was attempted.');
      }
      await attachRecoveredScoutResult(client, db, setup, resultMessage);
    } catch (error) {
      await reportOperationalError(client, db, { guildId: setup.guildId, setupId: setup.id, division: setup.divisionDisplayName, action: 'Scout publication recovery' }, error);
    }
  }
}

export function managementRow(setupId: number, version: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`scout:publishedswap:${setupId}:${version}`)
      .setLabel('Swap players')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`scout:publishedreplace:${setupId}:${version}`)
      .setLabel('Replace player')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`scout:pingroster:${setupId}:${version}`)
      .setLabel('Ping roster').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`scout:changehost:${setupId}:${version}`)
      .setLabel('Change host').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`scout:changeorganizer:${setupId}:${version}`)
      .setLabel('Change organizer').setStyle(ButtonStyle.Secondary),
  );
}

type PublishedManagementOrigin = 'canonical-entry' | 'private-continuation';

function isCanonicalPublishedManagementMessage(
  interaction: MessageComponentInteraction,
  setup: ScoutSetup,
) {
  return (isScoutResultsChannel(setup, interaction.channelId) && interaction.message.id === setup.resultMessageId) ||
    (isScoutOperationsChannel(setup, interaction.channelId) && interaction.message.id === setup.controlMessageId);
}

async function authorized(
  interaction: MessageComponentInteraction,
  db: Database.Database,
  setupId: number,
  status: 'roster_ready' | 'published',
  origin: PublishedManagementOrigin,
): Promise<ScoutSetup | undefined> {
  const setup = getScoutSetupById(db, setupId);
  if (!setup || setup.guildId !== interaction.guildId || setup.status !== status || !interaction.guild) return undefined;
  const correctChannel = status === 'roster_ready'
    ? isScoutOperationsChannel(setup, interaction.channelId)
    : isScoutResultsChannel(setup, interaction.channelId) || isScoutOperationsChannel(setup, interaction.channelId);
  if (!correctChannel) return undefined;
  if (status === 'published' && origin === 'canonical-entry' &&
      !isCanonicalPublishedManagementMessage(interaction, setup)) return undefined;
  const division = getDivisionByKey(db, setup.guildId, setup.divisionKey);
  if (!division || division.id !== setup.divisionId || division.status !== 'active') return undefined;
  const member = await interaction.guild.members.fetch(interaction.user.id);
  const config = getScoutConfig(db, setup.guildId);
  const { hasAccess } = await import('./authorization.js');
  return hasScoutDivisionManagementAccess(db, member, config, division, hasAccess(member, 'ADMIN')) ? setup : undefined;
}

export async function handleScoutPublishButton(interaction: ButtonInteraction, db: Database.Database): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] !== 'scout' || ![
    'publish', 'publishconfirm', 'publishback', 'publishedreplace', 'publishedswap',
    'publishedcandidateconfirm', 'publishedcandidateback',
  ].includes(parts[1] ?? '')) return false;
  const setupId = Number(parts[2]);
  const expectedVersion = Number(parts[3]);
  if (!Number.isInteger(setupId) || !Number.isInteger(expectedVersion)) return false;
  const publishedAction = [
    'publishedreplace', 'publishedswap', 'publishedcandidateconfirm', 'publishedcandidateback',
  ].includes(parts[1] ?? '');
  if (publishedAction || parts[1] === 'publish') await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  else await interaction.deferUpdate();
  return withPublishedDivisionGuard(interaction, db, setupId, async () => {
    const publishedOrigin: PublishedManagementOrigin = ['publishedreplace', 'publishedswap'].includes(parts[1]!)
      ? 'canonical-entry'
      : 'private-continuation';
    let setup = await authorized(
      interaction,
      db,
      setupId,
      publishedAction ? 'published' : 'roster_ready',
      publishedOrigin,
    );
    if (!setup) {
      await interaction.editReply({ content: 'You do not have permission to manage this scout result.' });
      return true;
    }
    if (await rejectFinishedScout(interaction, db, setupId)) return true;

    if (publishedAction && getScoutRosterUpdate(db, setupId)) {
      await finishPublishedUpdate(interaction, db, setupId);
      return true;
    }
    if (setup.version !== expectedVersion) {
      await interaction.editReply({ content: 'This roster view is stale. Open the current roster controls again.', components: [] });
      return true;
    }
    if (parts[1] === 'publishback') {
      const { buildScoutRosterReviewView } = await import('./scoutReview.js');
      await interaction.editReply(buildScoutRosterReviewView(db, setup.id, setup.version, listScoutRosterSlots(db, setup.id)));
      return true;
    }
    if (parts[1] === 'publishedcandidateback') {
      await interaction.editReply({ content: 'Replacement cancelled.', components: [] });
      return true;
    }
    if (parts[1] === 'publishedcandidateconfirm') {
      const slotId = Number(parts[4]);
      const userId = parts[5];
      if (!Number.isInteger(slotId) || !userId) return false;
      const slots = listScoutRosterSlots(db, setupId);
      const target = slots.find((slot) => slot.id === slotId);
      const member = await interaction.guild!.members.fetch(userId).catch(() => undefined);
      const eligibleSignups = await eligibleScoutSignups(
        interaction.guild!, listScoutSignups(db, setupId), setup.eligibilityRoleId,
      );
      const candidate = target && rankScoutReplacementCandidates(
        eligibleSignups, new Set(slots.map((slot) => slot.userId)), target.role,
      ).find((item) => item.userId === userId);
      if (!target || !member || !isScoutUserEligible(member.roles.cache.keys(), setup.eligibilityRoleId) || !candidate) {
        await interaction.editReply({ content: 'That replacement candidate is no longer eligible or unseated.', components: [] });
        return true;
      }
      const outcome = replacePublishedScoutRosterCandidateIfVersion(db, {
        setupId, expectedVersion, slotId, userId, actorUserId: interaction.user.id,
        allowExplicitMember: false, now: Math.floor(Date.now() / 1_000),
      });
      if (outcome !== 'updated') {
        await interaction.editReply({ content: `No replacement was made (${outcome}).`, components: [] });
        return true;
      }
      await finishPublishedUpdate(interaction, db, setupId);
      return true;
    }
    if (parts[1] === 'publish') {
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`scout:publishconfirm:${setupId}:${expectedVersion}`).setLabel('Confirm publish').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`scout:publishback:${setupId}:${expectedVersion}`).setLabel('Back').setStyle(ButtonStyle.Secondary),
      );
      await interaction.editReply({
        content: `Publish this finalized roster to <#${setup.signupChannelId}>? This can only happen once.`,
        components: [row],
      });
      return true;
    }
    if (parts[1] === 'publishedreplace') {
      const slots = listScoutRosterSlots(db, setupId);
      const names = await resolveScoutPlayerNames(interaction.guild!, slots.map((slot) => slot.userId));
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`scout:publishedpick:${setupId}:${expectedVersion}`)
        .setPlaceholder('Published slot to replace')
        .addOptions(slots.map((slot) => new StringSelectMenuOptionBuilder()
          .setLabel(formatScoutSlotLabel(slot, names.get(slot.userId)))
          .setValue(String(slot.id))));
      await interaction.editReply({
        content: 'Choose the published roster slot to replace.',
        components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu)],
      });
      return true;
    }

    if (parts[1] === 'publishedswap') {
      const slots = listScoutRosterSlots(db, setupId);
      const names = await resolveScoutPlayerNames(interaction.guild!, slots.map((slot) => slot.userId));
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`scout:publishedswapfirst:${setupId}:${expectedVersion}`)
        .setPlaceholder('First published player')
        .addOptions(slots.map((slot) => new StringSelectMenuOptionBuilder()
          .setLabel(formatScoutSlotLabel(slot, names.get(slot.userId)))
          .setValue(String(slot.id))));
      await interaction.editReply({
        content: 'Choose the first published player to swap.',
        components: [new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu)],
      });
      return true;
    }

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
    const claim = await withFinalScoutReadiness(interaction.client, db, setupId,
      () => prepareScoutPublication(db, {
        setupId, expectedVersion, now: Math.floor(Date.now() / 1000),
      }));
    if (claim.status !== 'claimed') {
      await interaction.editReply({
        content: claim.status === 'withdrawals' ? 'Publishing is blocked by one or more withdrawn signups.' : 'That publish confirmation is stale or already completed.',
        components: [],
      });
      return true;
    }

    // Claim atomically switches only unclaimed rosters to signup-channel routing.
    // Already-published/pending records keep their original destination on retry.
    setup = getScoutSetupById(db, setupId)!;
    const slots = listScoutRosterSlots(db, setupId);
    let resultMessage;
    try {
      const channel = await interaction.client.channels.fetch(setup.resultsChannelId);
      if (!channel?.isSendable()) throw new Error('The snapshotted results channel is not sendable.');
      resultMessage = await channel.send({
        content: renderScoutResult({ ...setup, hosts: listScoutGameHosts(db, setupId) }, slots),
        components: publishedRosterRows(setup),
        allowedMentions: { parse: [], users: slots.map((slot) => slot.userId), roles: [] },
      });
      if (!setScoutPendingResultMessage(db, setupId, resultMessage.id)) {
        throw new Error('Could not record the pending result message.');
      }

      const signupChannel = await interaction.client.channels.fetch(setup.signupChannelId);
      if (!signupChannel?.isTextBased() || !setup.signupMessageId) throw new Error('The original signup post is unavailable.');
      const signupMessage = await signupChannel.messages.fetch(setup.signupMessageId);
      await signupMessage.edit({
        content: `${renderScoutSignupPost(setup)}\n\n✅ Roster published: ${resultMessage.url}`,
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setLabel('View roster').setStyle(ButtonStyle.Link).setURL(resultMessage.url),
        )],
        allowedMentions: { parse: [] },
      });
      if (!markPublishedScoutSignupPostReconciled(db, setupId, resultMessage.id)) {
        throw new Error('Could not record the updated signup post.');
      }
    } catch (error) {
      const report = await reportOperationalError(interaction.client, db, { guildId: setup.guildId, setupId, action: 'Scout publication' }, error);
      await interaction.editReply({
        content: `Publishing was interrupted after the database claim. Ratatoskr kept the authoritative publish state for safe recovery: ${operationalErrorGuidance(report)}`,
        components: [],
      });
      return true;
    }
    await refreshScoutStatusCardSafely(interaction.client, db, setup.id);
    await interaction.editReply({ content: `Scout roster published: ${resultMessage.url}`, components: [] });
    return true;
  });
}

export async function handleScoutPublishedSlotSelect(
  interaction: StringSelectMenuInteraction,
  db: Database.Database,
): Promise<boolean> {
  const parts = interaction.customId.split(':');
  if (parts[0] === 'scout' && parts[1] === 'publishedcandidate') {
    const setupId = Number(parts[2]);
    const version = Number(parts[3]);
    const slotId = Number(parts[4]);
    const userId = interaction.values[0];
    if (![setupId, version, slotId].every(Number.isInteger) || !userId) return false;
    await interaction.deferUpdate();
    return withPublishedDivisionGuard(interaction, db, setupId, async () => {
      const setup = await authorized(interaction, db, setupId, 'published', 'private-continuation');
      if (!setup || setup.version !== version || await rejectFinishedScout(interaction, db, setupId)) {
        if (!setup || setup.version !== version) await interaction.editReply({ content: 'This roster view is stale.', components: [] });
        return true;
      }
      const slots = listScoutRosterSlots(db, setupId);
      const target = slots.find((slot) => slot.id === slotId);
      const member = await interaction.guild!.members.fetch(userId).catch(() => undefined);
      const eligibleSignups = await eligibleScoutSignups(
        interaction.guild!, listScoutSignups(db, setupId), setup.eligibilityRoleId,
      );
      const candidate = target && rankScoutReplacementCandidates(
        eligibleSignups, new Set(slots.map((slot) => slot.userId)), target.role,
      ).find((item) => item.userId === userId);
      if (!target || !member || !isScoutUserEligible(member.roles.cache.keys(), setup.eligibilityRoleId) || !candidate) {
        await interaction.editReply({ content: 'That replacement candidate is no longer eligible or unseated.', components: [] });
        return true;
      }
      if (candidate.offRole) {
        await interaction.editReply({
          content: `⚠️ ${formatScoutSlotLabel(target)} is outside <@${userId}>'s declared roles.`,
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`scout:publishedcandidateconfirm:${setupId}:${version}:${slotId}:${userId}`)
              .setLabel('Replace anyway').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`scout:publishedcandidateback:${setupId}:${version}`)
              .setLabel('Cancel').setStyle(ButtonStyle.Secondary),
          )],
          allowedMentions: { parse: [] },
        });
        return true;
      }
      const outcome = replacePublishedScoutRosterCandidateIfVersion(db, {
        setupId, expectedVersion: version, slotId, userId, actorUserId: interaction.user.id,
        allowExplicitMember: false, now: Math.floor(Date.now() / 1_000),
      });
      if (outcome !== 'updated') {
        await interaction.editReply({ content: `No replacement was made (${outcome}).`, components: [] });
        return true;
      }
      await finishPublishedUpdate(interaction, db, setupId);
      return true;
    });
  }
  if (parts[0] !== 'scout' || !['publishedpick', 'publishedswapfirst', 'publishedswapsecond'].includes(parts[1] ?? '')) return false;
  const setupId = Number(parts[2]);
  const version = Number(parts[3]);
  const slotId = Number(interaction.values[0]);
  if (![setupId, version, slotId].every(Number.isInteger)) return false;
  await interaction.deferUpdate();
  return withPublishedDivisionGuard(interaction, db, setupId, async () => {
    const setup = await authorized(interaction, db, setupId, 'published', 'private-continuation');
    if (!setup) {
      await interaction.editReply({ content: 'You do not have permission to manage this result.' });
      return true;
    }
    if (await rejectFinishedScout(interaction, db, setupId)) return true;
    if (getScoutRosterUpdate(db, setupId)) {
      await finishPublishedUpdate(interaction, db, setupId);
      return true;
    }
    if (setup.version !== version) {
      await interaction.editReply({ content: 'This roster view is stale. Open the current roster controls again.', components: [] });
      return true;
    }
    if (parts[1] === 'publishedswapfirst') {
      const slots = listScoutRosterSlots(db, setupId);
      if (!slots.some((slot) => slot.id === slotId)) return false;
      const names = await resolveScoutPlayerNames(interaction.guild!, slots.map((slot) => slot.userId));
      const menu = new StringSelectMenuBuilder()
        .setCustomId(`scout:publishedswapsecond:${setupId}:${version}:${slotId}`)
        .setPlaceholder('Second published player')
        .addOptions(slots.filter((slot) => slot.id !== slotId).map((slot) => new StringSelectMenuOptionBuilder()
          .setLabel(formatScoutSlotLabel(slot, names.get(slot.userId)))
          .setValue(String(slot.id))));
      await interaction.editReply({
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
        await interaction.editReply({ content: 'That swap is no longer available.', components: [] });
        return true;
      }
      const channel = await interaction.client.channels.fetch(setup.resultsChannelId).catch(() => undefined);
      const message = channel?.isTextBased()
        ? await channel.messages.fetch(setup.resultMessageId).catch(() => undefined)
        : undefined;
      if (!message) {
        await interaction.editReply({ content: 'The published result message is unavailable; no swap was made.', components: [] });
        return true;
      }
      if (!swapPublishedScoutRosterSlotsIfVersion(
        db, setupId, version, firstSlotId, slotId, interaction.user.id,
      )) {
        await interaction.editReply({ content: 'That result view was stale; no swap was made.', components: [] });
        return true;
      }
      await finishPublishedUpdate(interaction, db, setupId);
      return true;
    }
    const slots = listScoutRosterSlots(db, setupId);
    const target = slots.find((slot) => slot.id === slotId);
    if (!target) {
      await interaction.editReply({ content: 'That roster slot is no longer available.', components: [] });
      return true;
    }
    const eligibleSignups = await eligibleScoutSignups(
      interaction.guild!, listScoutSignups(db, setupId), setup.eligibilityRoleId,
    );
    const candidates = rankScoutReplacementCandidates(
      eligibleSignups, new Set(slots.map((slot) => slot.userId)), target.role,
    );
    const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
    if (candidates.length) {
      const shown = candidates.slice(0, 25);
      const names = await resolveScoutPlayerNames(interaction.guild!, shown.map((candidate) => candidate.userId));
      rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`scout:publishedcandidate:${setupId}:${version}:${slotId}`)
          .setPlaceholder('Signup replacement')
          .addOptions(shown.map((candidate) => new StringSelectMenuOptionBuilder()
            .setLabel(`${names.get(candidate.userId) ?? candidate.userId}${candidate.offRole ? ' (off-role)' : ''}`.slice(0, 100))
            .setDescription(candidate.roles.map((role) => role === 'fill' ? 'Fill' : role).join(', ').slice(0, 100))
            .setValue(candidate.userId))),
      ));
    }
    rows.push(new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`scout:publisheduser:${setupId}:${version}:${slotId}`)
        .setPlaceholder('Or choose an explicit eligible member'),
    ));
    await interaction.editReply({
      content: `Choose the replacement for ${formatScoutSlotLabel(target)}.${candidates.length > 25 ? ` Showing the first 25 of ${candidates.length} signup candidates; the explicit member picker remains available.` : ''}`,
      components: rows,
  });
  return true;
  });
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
  await interaction.deferUpdate();
  return withPublishedDivisionGuard(interaction, db, setupId, async () => {
    const setup = await authorized(interaction, db, setupId, 'published', 'private-continuation');
    if (!setup) {
      await interaction.editReply({ content: 'You do not have permission to replace this player.' });
      return true;
    }
    if (await rejectFinishedScout(interaction, db, setupId)) return true;
    if (getScoutRosterUpdate(db, setupId)) {
      await finishPublishedUpdate(interaction, db, setupId);
      return true;
    }
    if (setup.version !== version) {
      await interaction.editReply({ content: 'This roster view is stale. Open the current roster controls again.', components: [] });
      return true;
    }
    const userId = interaction.values[0]!;
    const replacementMember = await interaction.guild?.members.fetch(userId).catch(() => undefined);
    if (!replacementMember) {
      await interaction.editReply({ content: 'The replacement must be a current server member.' });
      return true;
    }
    if (replacementMember.user.bot) {
      await interaction.editReply({ content: 'A bot cannot be used as a scout replacement.' });
      return true;
    }
    if (!isScoutUserEligible(replacementMember.roles.cache.keys(), setup.eligibilityRoleId)) {
      await interaction.editReply({ content: 'The replacement does not hold this setup\'s eligibility role.' });
      return true;
    }
    const oldSlot = listScoutRosterSlots(db, setupId).find((slot) => slot.id === slotId);
    const channel = await interaction.client.channels.fetch(setup.resultsChannelId).catch(() => undefined);
    if (!channel?.isTextBased() || !setup.resultMessageId) {
      await interaction.editReply({ content: 'The published result message is unavailable; no replacement was made.', components: [] });
      return true;
    }
    const message = await channel.messages.fetch(setup.resultMessageId).catch(() => undefined);
    if (!message) {
      await interaction.editReply({ content: 'The published result message was deleted or cannot be accessed; no replacement was made.', components: [] });
      return true;
    }
    const outcome = replacePublishedScoutRosterCandidateIfVersion(db, {
      setupId, expectedVersion: version, slotId, userId, actorUserId: interaction.user.id,
      allowExplicitMember: true, now: Math.floor(Date.now() / 1_000),
    });
    if (outcome !== 'updated' || !oldSlot) {
      await interaction.editReply({ content: `No replacement was made (${outcome}).`, components: [] });
      return true;
    }
    await finishPublishedUpdate(interaction, db, setupId);
    return true;
  });
}


async function withPublishedDivisionGuard(
  interaction: MessageComponentInteraction, db: Database.Database, setupId: number, work: () => Promise<boolean>,
): Promise<boolean> {
  const setup = getScoutSetupById(db, setupId);
  if (!setup || setup.guildId !== interaction.guildId) return work();
  const release = tryAcquireDivisionOperation(db, setup.guildId, setup.divisionKey);
  if (!release) {
    await interaction.editReply({ content: 'This division has an operation in progress. Retry when it finishes.', components: [] });
    return true;
  }
  try { return await work(); } finally { release(); }
}

// Must run under the same division guard as live published edits.
async function reconcileScoutRosterUpdateLocked(client: Client, db: Database.Database, setupId: number): Promise<void> {
  const pending = getScoutRosterUpdate(db, setupId);
  if (!pending) return;
  const setup = getScoutSetupById(db, setupId);
  if (!setup || setup.status !== 'published' || setup.version !== pending.version || !setup.resultMessageId) {
    throw new Error('Pending roster update disagrees with its published setup. Operator reconciliation required.');
  }
  const channel = await client.channels.fetch(setup.resultsChannelId);
  if (!channel?.isTextBased()) throw new Error('The roster channel is unavailable.');
  if (!pending.message_reconciled) {
    const message = await channel.messages.fetch(setup.resultMessageId);
    await message.edit({
      content: renderPersistedScoutResult(
        setup, listScoutRosterSlots(db, setupId), listScoutGameHosts(db, setupId),
      ),
      components: publishedRosterRows(setup), allowedMentions: { parse: [] },
    });
    markScoutRosterUpdateEdited(db, setupId, pending.version);
  }
  if (!pending.notice.trim()) {
    completeScoutRosterUpdate(db, setupId, pending.version);
    return;
  }
  if (pending.notice_attempted) {
    throw new Error('Roster is updated; notice delivery is uncertain. Inspect the channel and pending update before manual reconciliation.');
  }
  if (!channel.isSendable()) throw new Error('Roster is updated; the notice channel is not sendable.');
  markScoutRosterNoticeAttempted(db, setupId, pending.version);
  await channel.send({ content: pending.notice, allowedMentions: { parse: [] } });
  completeScoutRosterUpdate(db, setupId, pending.version);
}

export async function reconcileScoutPublishedPresentation(
  client: Client,
  db: Database.Database,
  setupId: number,
): Promise<void> {
  await reconcileScoutRosterUpdateLocked(client, db, setupId);
}

async function finishPublishedUpdate(interaction: MessageComponentInteraction, db: Database.Database, setupId: number) {
  try {
    await reconcileScoutRosterUpdateLocked(interaction.client, db, setupId);
  } catch (error) {
    const report = await reportOperationalError(interaction.client, db, { guildId: interaction.guildId!, setupId, action: 'Published roster recovery', next: 'Roster change saved; inspect pending Discord edit or notice before retrying a player change.' }, error);
    await interaction.editReply({ content: `The roster change is saved; Discord update or notice delivery is pending recovery. Do not repeat the player change. ${operationalErrorGuidance(report)}`, components: [] });
    return;
  }
  await refreshScoutStatusCardSafely(interaction.client, db, setupId);
  await interaction.editReply({ content: 'Published roster updated.', components: [] });
}

async function rejectFinishedScout(interaction: MessageComponentInteraction, db: Database.Database, setupId: number): Promise<boolean> {
  if (!getScoutCompletion(db, setupId)) return false;
  await interaction.editReply({ content: 'This scout is finished. The roster is kept for history and player edits are closed.', components: [] });
  return true;
}

export async function reconcilePendingScoutRosterUpdates(client: Client, db: Database.Database): Promise<void> {
  for (const pending of listScoutRosterUpdates(db)) {
    const setup = getScoutSetupById(db, pending.setup_id);
    if (!setup) continue;
    const release = tryAcquireDivisionOperation(db, setup.guildId, setup.divisionKey);
    if (!release) continue;
    try { await reconcileScoutRosterUpdateLocked(client, db, setup.id); }
    catch (error) { await reportOperationalError(client, db, { guildId: setup.guildId, setupId: setup.id, division: setup.divisionDisplayName, action: 'Published roster recovery' }, error); }
    finally { release(); }
  }
}
