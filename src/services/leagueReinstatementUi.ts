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
export async function openReinstatementCommand(interaction: ChatInputCommandInteraction, db: Database.Database, scope: object) {
  const service = serviceFor({ guild: interaction.guild! }, db, scope);
  try {
    const review = await service.open(interaction.user.id, interaction.options.getString('player', true),
      interaction.options.getString('transaction') ?? undefined, interaction.options.getString('reason') ?? undefined);
    await interaction.editReply(reinstatementReviewMessage(review));
    service.install(review);
  } catch (error) {
    if (!(error instanceof LeagueMutationValidationError)) throw error;
    await interaction.editReply({ content: `${error.message}\n\nNo changes were made.`, components: [], embeds: [] });
  }
}
export async function handleReinstatementInteraction(interaction: Interaction, db: Database.Database, scope: object): Promise<boolean> {
  if ((!interaction.isButton() && !interaction.isStringSelectMenu()) || !interaction.customId.startsWith('reinstate:')) return false;
  if (!interaction.guild) { await interaction.reply({ content: 'Open this review in the league server.', flags: MessageFlags.Ephemeral }); return true; }
  await interaction.deferUpdate();
  const service = serviceFor({ guild: interaction.guild }, db, scope);
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
    if (!(error instanceof LeagueMutationValidationError)) throw error;
    await interaction.followUp({ content: error.message, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  return true;
}
