import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ButtonInteraction,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
} from 'discord.js';
import type Database from 'better-sqlite3';
import { getLeagueAuditState } from '../db/repositories/leagueAudits.js';
import { hasAccess } from './authorization.js';
import { loadLeagueOperationsConfig } from '../config/league-operations.js';
import { createGoogleLeagueSheetsGateway, LeagueSheetsService } from './leagueSheets.js';
import { DiscordLeagueGateway } from './leagueDiscord.js';
import { createLeagueAuditCardPort } from './leagueAuditDiscord.js';
import { runLeagueAudit } from './leagueAudit.js';
import {
  executeLeagueAuditRepair,
  LeagueAuditRepairNoWriteError,
  type LeagueAuditResolutionAction,
} from './leagueAuditResolution.js';
import { executeRepairAndRefresh, type LeagueAuditRunResult } from './leagueAuditReviewFlow.js';
import {
  buildLeagueAuditConfirmationView,
  buildLeagueAuditRepairReply,
  buildLeagueAuditResolutionView,
  buildLeagueAuditReviewView,
  type LeagueAuditReviewView,
} from './leagueAuditReviewView.js';

function payload(view: LeagueAuditReviewView): InteractionReplyOptions & InteractionUpdateOptions {
  return {
    embeds: [new EmbedBuilder().setTitle(view.title).setDescription(view.description).setFooter({ text: view.footer }).setColor(0xC43C35)],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(view.actions.map((action) => new ButtonBuilder()
      .setCustomId(action.id)
      .setLabel(action.label)
      .setStyle(['Previous', 'Next', 'Back'].includes(action.label) ? ButtonStyle.Secondary : ButtonStyle.Primary)
      .setDisabled(action.disabled)))],
    allowedMentions: { parse: [] },
  };
}

function parseReviewId(customId: string): {
  action: 'review' | 'page' | 'resolve' | 'choice' | 'confirm';
  reference: string;
  page: number;
  resolution?: LeagueAuditResolutionAction;
} | undefined {
  const parts = customId.split(':');
  if (parts[0] !== 'league-audit') return undefined;
  if (parts[1] === 'review' && parts[2]) return { action: 'review', reference: parts[2], page: 0 };
  if ((parts[1] === 'page' || parts[1] === 'resolve') && parts[2] && /^\d+$/.test(parts[3] ?? '')) {
    return { action: parts[1], reference: parts[2], page: Number(parts[3]) };
  }
  if ((parts[1] === 'choice' || parts[1] === 'confirm') && parts[2] && /^\d+$/.test(parts[3] ?? '')
    && ['use-discord-name', 'use-league-name', 'use-roster-name', 'repair-roles', 'sync-public-roster', 'mark-inactive'].includes(parts[4] ?? '')) {
    return { action: parts[1], reference: parts[2], page: Number(parts[3]), resolution: parts[4] as LeagueAuditResolutionAction };
  }
  return undefined;
}

function staleRefreshReply(result: LeagueAuditRunResult): string {
  if (result.status === 'error') {
    return 'This issue already changed, so Ratatoskr made no changes. The audit could not be refreshed because Discord or a roster sheet is temporarily unavailable; it will retry automatically.';
  }
  if (result.status === 'clean') {
    return 'This issue was already resolved. Ratatoskr refreshed the audit and no issues remain.';
  }
  return `This issue was already resolved or changed. Ratatoskr refreshed the audit; ${result.issues.length} current issue${result.issues.length === 1 ? '' : 's'} remain. Use **Review issues** on the newest audit card.`;
}

export async function handleLeagueAuditReviewButton(
  interaction: ButtonInteraction,
  db: Database.Database,
  operationScope: object,
): Promise<boolean> {
  const parsed = parseReviewId(interaction.customId);
  if (!parsed) return false;
  if (!interaction.guild) {
    await interaction.reply({ content: 'League audit review is only available in the YSL server.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasAccess(member, 'ADMIN')) {
    await interaction.reply({ content: 'Only league administrators can review or resolve roster audit issues.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const state = getLeagueAuditState(db, interaction.guild.id);
  if (!state || state.result !== 'dirty' || state.runReference !== parsed.reference) {
    await interaction.reply({ content: 'This audit card is out of date. Use the newest League Roster Audit card.', flags: MessageFlags.Ephemeral });
    return true;
  }
  const finding = state.findings[parsed.page];
  if (!finding) {
    await interaction.reply({ content: 'That issue is no longer in the active audit.', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (parsed.action === 'resolve') {
    await interaction.update(payload(buildLeagueAuditResolutionView(finding, parsed.page, parsed.reference)));
    return true;
  }
  if (parsed.action === 'choice') {
    await interaction.update(payload(buildLeagueAuditConfirmationView(
      finding, parsed.page, parsed.reference, parsed.resolution!,
    )));
    return true;
  }
  if (parsed.action === 'confirm') {
    const config = loadLeagueOperationsConfig();
    const connection = createGoogleLeagueSheetsGateway();
    const sheets = new LeagueSheetsService(connection.gateway, connection.config);
    const discord = new DiscordLeagueGateway(interaction.guild, config.transactionsChannelId);
    const actorName = member.displayName || interaction.user.globalName || interaction.user.username;
    const refreshAudit = () => runLeagueAudit({
      db,
      operationScope,
      guildId: interaction.guild!.id,
      trigger: 'scheduled',
      now: new Date(),
      freeAgentRoleId: config.freeAgentRoleId,
      members: discord,
      sheets,
      cards: createLeagueAuditCardPort(interaction.client, db, interaction.guild!.id),
    });
    let outcome: Awaited<ReturnType<typeof executeRepairAndRefresh>>;
    try {
      outcome = await executeRepairAndRefresh(
        async () => {
          await interaction.update({
            content: 'Ratatoskr is checking this issue against Discord and the roster sheets. The controls are paused while this finishes.',
            embeds: [],
            components: [],
            allowedMentions: { parse: [] },
          });
        },
        () => executeLeagueAuditRepair({
          db,
          operationScope,
          guildId: interaction.guild!.id,
          auditReference: parsed.reference,
          actorUserId: interaction.user.id,
          actorName,
          now: new Date(),
          expectedFinding: finding,
          action: parsed.resolution!,
          freeAgentRoleId: config.freeAgentRoleId,
          members: discord,
          sheets,
          discord,
        }),
        refreshAudit,
      );
    } catch (error) {
      if (!(error instanceof LeagueAuditRepairNoWriteError)) throw error;
      await interaction.editReply({
        content: `${error.message}${/no changes were made/i.test(error.message) ? '' : ' No changes were made.'}`,
        embeds: [],
        components: [],
        allowedMentions: { parse: [] },
      });
      return true;
    }
    await interaction.editReply({
      content: outcome.kind === 'stale-refreshed'
        ? staleRefreshReply(outcome.audit)
        : buildLeagueAuditRepairReply(outcome.audit, outcome.reference),
      embeds: [],
      components: [],
      allowedMentions: { parse: [] },
    });
    return true;
  }
  const view = buildLeagueAuditReviewView(state.findings, parsed.page, parsed.reference);
  if (parsed.action === 'review') await interaction.reply({ ...payload(view), flags: MessageFlags.Ephemeral });
  else await interaction.update(payload(view));
  return true;
}
