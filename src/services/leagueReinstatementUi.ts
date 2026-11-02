import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, EmbedBuilder, MessageFlags,
  type Interaction, type ChatInputCommandInteraction } from 'discord.js';
import type Database from 'better-sqlite3';
import { hasAccess } from './authorization.js';
import { loadLeagueOperationsConfig } from '../config/league-operations.js';
import { createGoogleLeagueSheetsGateway, LeagueSheetsService } from './leagueSheets.js';
import { DiscordLeagueGateway } from './leagueDiscord.js';
import { leagueJobWorkerFor } from './leagueJobWorker.js';
import { LeagueReinstatementService, reinstatementPreviewText, type ReinstatementReview } from './leagueReinstatement.js';
import { reinstatementPolicyExceptions, LeagueMutationValidationError } from '../domain/leagueOperations.js';
import { leagueStatusLabel } from './leaguePresentation.js';
import { LeagueMemberGatewayThrottleError, LeagueMemberSnapshotUnavailableError } from './leagueMemberReads.js';

export type ReinstatementStep = 'open' | 'choose' | 'exceptions' | 'confirm';

/**
 * Every whole-member read in the reinstatement service happens before a job is saved
 * (open, picker, advisory redraws and confirm's fresh check before enqueue). A Discord
 * cooldown or incomplete member list there is a read-only deferral: answer privately and
 * do not raise the generic staff alert that warns about possible partial changes (#186).
 * Errors after enqueue never reach this path; the worker owns those and their recovery.
 */
export function reinstatementMemberReadMessage(error: unknown, step: ReinstatementStep): string | undefined {
  const retry = step === 'open' ? 'Run /transaction reinstate again' : step === 'confirm' ? 'Press Confirm reinstatement again' : 'Make your choice again';
  const unchanged = step === 'confirm' ? 'Your approval was not saved and no changes were made.' : 'No changes were made.';
  if (error instanceof LeagueMemberGatewayThrottleError) {
    const seconds = Math.max(1, Math.ceil(error.retryAfterMs / 1_000));
    return `Discord asked Rat to wait before checking the member list again. ${unchanged} ${retry} in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`;
  }
  if (error instanceof LeagueMemberSnapshotUnavailableError)
    return `Rat could not check every Discord member just now. ${unchanged} ${retry} in a moment.`;
  return undefined;
}

function logMemberReadDeferral(guildId: string, step: ReinstatementStep, error: Error) {
  console.warn('Reinstatement member check deferred before any change', { guildId, step, error: error.name,
    ...(error instanceof LeagueMemberGatewayThrottleError ? { retryAfterMs: error.retryAfterMs } : {}) });
}

export function reinstatementReviewMessage(review: ReinstatementReview) {
  const id = (action: string) => `reinstate:${action}:${review.token}`;
  const cancel = new ButtonBuilder().setCustomId(id('cancel')).setLabel('Cancel').setStyle(ButtonStyle.Secondary);
  if (review.payload.kind === 'picker') {
    const payload = review.payload;
    const select = new StringSelectMenuBuilder().setCustomId(id('choose')).setPlaceholder('Choose the player and original exit')
      .addOptions(payload.candidates.slice(payload.page * 25, payload.page * 25 + 25).map((source, index) => ({
        label: `${source.playerName ?? source.playerId} · ${source.playerId} · ${source.kind}`.slice(0, 100),
        description: `${source.effectiveDate} · ${source.franchise} · ${source.reference}`.slice(0, 100), value: String(payload.page * 25 + index),
      })));
    return { content: `Several historical matches were found. Choose the exact player and original exit. No changes were made. Page ${payload.page + 1}/${Math.ceil(payload.candidates.length / 25)}.`,
      embeds: [], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(id('previous')).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(payload.page === 0),
          new ButtonBuilder().setCustomId(id('next')).setLabel('Next').setStyle(ButtonStyle.Secondary).setDisabled((payload.page + 1) * 25 >= payload.candidates.length), cancel)],
      allowedMentions: { parse: [] as never[] } };
  }
  const details = review.payload.plan.reinstatement!;
  const policyExceptions = reinstatementPolicyExceptions(details);
  const exceptions = policyExceptions.length ? new StringSelectMenuBuilder().setCustomId(id('exceptions')).setPlaceholder('Choose each policy exception you approve')
    .setMinValues(0).setMaxValues(policyExceptions.length).addOptions(policyExceptions.map(item => ({
      label: item.id === 'discipline' ? 'Override current-season suspension; keep future penalty' : 'Approve roster-count exception',
      value: item.id, default: details.selection.overrides.includes(item.id),
    }))) : undefined;
  return { content: '', embeds: [new EmbedBuilder().setDescription(reinstatementPreviewText(review.payload.plan)).setColor(details.blockers.length ? 0xb45435 : 0x466a65)],
    components: [...(exceptions ? [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(exceptions)] : []),
      new ActionRowBuilder<ButtonBuilder>().addComponents(cancel,
        new ButtonBuilder().setCustomId(id('confirm')).setLabel('Confirm reinstatement').setStyle(ButtonStyle.Primary)
          .setDisabled(!!details.blockers.length || policyExceptions.some(item => !details.selection.overrides.includes(item.id))))],
    allowedMentions: { parse: [] as never[] } };
}

function serviceFor(interaction: { guild: NonNullable<ChatInputCommandInteraction['guild']> }, db: Database.Database, scope: object) {
  const environment = loadLeagueOperationsConfig();
  const { gateway, config } = createGoogleLeagueSheetsGateway();
  const guild = interaction.guild;
  return new LeagueReinstatementService({ db, guildId: guild.id, sheets: new LeagueSheetsService(gateway, config),
    discord: new DiscordLeagueGateway(guild, environment.transactionsChannelId), freeAgentRoleId: environment.freeAgentRoleId,
    authorize: async actor => {
      const member = await guild.members.fetch({ user: actor, force: true });
      if (!hasAccess(member, 'OPERATIONS')) throw new LeagueMutationValidationError('You no longer have permission to approve league changes. Ask a league administrator to review this action.');
      return member.displayName;
    }, enqueue: (payload, key) => leagueJobWorkerFor(scope, guild.id).enqueue('transaction', payload, key) });
}
type ReinstatementServicePort = Pick<LeagueReinstatementService, 'open' | 'choose' | 'exceptions' | 'page' | 'cancel' | 'confirm' | 'install'>;
export async function openReinstatementCommand(interaction: ChatInputCommandInteraction, db: Database.Database, scope: object,
  service: ReinstatementServicePort = serviceFor({ guild: interaction.guild! }, db, scope)) {
  try {
    const review = await service.open(interaction.user.id, interaction.options.getString('player', true),
      interaction.options.getString('transaction') ?? undefined, interaction.options.getString('reason') ?? undefined);
    await interaction.editReply(reinstatementReviewMessage(review));
    service.install(review);
  } catch (error) {
    const deferred = reinstatementMemberReadMessage(error, 'open');
    if (deferred) {
      logMemberReadDeferral(interaction.guildId ?? '', 'open', error as Error);
      await interaction.editReply({ content: deferred, components: [], embeds: [] });
      return;
    }
    if (!(error instanceof LeagueMutationValidationError)) throw error;
    await interaction.editReply({ content: `${error.message}\n\nNo changes were made.`, components: [], embeds: [] });
  }
}
export async function handleReinstatementInteraction(interaction: Interaction, db: Database.Database, scope: object,
  createService: (guild: NonNullable<Interaction['guild']>) => ReinstatementServicePort = guild => serviceFor({ guild }, db, scope)): Promise<boolean> {
  if ((!interaction.isButton() && !interaction.isStringSelectMenu()) || !interaction.customId.startsWith('reinstate:')) return false;
  if (!interaction.guild) { await interaction.reply({ content: 'Open this review in the league server.', flags: MessageFlags.Ephemeral }); return true; }
  await interaction.deferUpdate();
  const service = createService(interaction.guild);
  const [, action, token] = interaction.customId.split(':');
  try {
    if (action === 'cancel') {
      await service.cancel(interaction.user.id, token!);
      await interaction.editReply({ content: 'Reinstatement cancelled. No changes were made.', components: [], embeds: [] });
    } else if (action === 'confirm') {
      const job = await service.confirm(interaction.user.id, token!);
      await interaction.editReply({ content: `${leagueStatusLabel(job.status)}. Reference: ${job.reference}\nUse Open league tools → Review operations to inspect the saved result and linked original action. Do not submit it again.`, components: [], embeds: [] });
    } else {
      const review = action === 'choose' && interaction.isStringSelectMenu() ? await service.choose(interaction.user.id, token!, interaction.values[0]!)
        : action === 'exceptions' && interaction.isStringSelectMenu() ? await service.exceptions(interaction.user.id, token!, interaction.values)
          : action === 'previous' || action === 'next' ? await service.page(interaction.user.id, token!, action === 'next' ? 1 : -1) : undefined;
      if (!review) throw new LeagueMutationValidationError('This control is unavailable. Open a fresh reinstatement preview.');
      await interaction.editReply(reinstatementReviewMessage(review));
      service.install(review, token);
    }
  } catch (error) {
    const step: ReinstatementStep | undefined = action === 'confirm' || action === 'choose' || action === 'exceptions' ? action : undefined;
    const deferred = step && reinstatementMemberReadMessage(error, step);
    if (deferred) {
      // Leave the current review and its controls in place; they stay valid until it expires.
      logMemberReadDeferral(interaction.guildId ?? '', step, error as Error);
      await interaction.followUp({ content: deferred, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return true;
    }
    if (!(error instanceof LeagueMutationValidationError)) throw error;
    await interaction.followUp({ content: error.message, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  return true;
}
