import type { LeagueAuditResolutionAction } from './leagueAuditResolution.js';
import { getLeagueJobByDedupe } from '../db/repositories/leagueJobs.js';
import { leagueJobWorkerFor } from './leagueJobWorker.js';
import type { LeagueRepairIntent } from './leagueOpsRuntime.js';
import { handleLeagueRepairRecoveryButton } from './leagueRepairRecoveryReview.js';
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
import {
  buildLeagueAuditConfirmationView,
  buildLeagueAuditResolutionView,
  buildLeagueAuditReviewView,
  type LeagueAuditReviewView,
} from './leagueAuditReviewView.js';

function payload(view: LeagueAuditReviewView): InteractionReplyOptions & InteractionUpdateOptions {
  return {
    embeds: [
      new EmbedBuilder()
        .setTitle(view.title)
        .setDescription(view.description)
        .setFooter({ text: view.footer })
        .setColor(0xc43c35),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        view.actions.map((action) =>
          new ButtonBuilder()
            .setCustomId(action.id)
            .setLabel(action.label)
            .setStyle(['Previous', 'Next', 'Back'].includes(action.label) ? ButtonStyle.Secondary : ButtonStyle.Primary)
            .setDisabled(action.disabled),
        ),
      ),
    ],
    allowedMentions: { parse: [] },
  };
}

function parseReviewId(customId: string):
  | {
      action: 'review' | 'page' | 'resolve' | 'choice' | 'confirm';
      reference: string;
      page: number;
      resolution?: LeagueAuditResolutionAction;
    }
  | undefined {
  const parts = customId.split(':');
  if (parts[0] !== 'league-audit') return undefined;
  if (parts[1] === 'review' && parts[2]) return { action: 'review', reference: parts[2], page: 0 };
  if ((parts[1] === 'page' || parts[1] === 'resolve') && parts[2] && /^\d+$/.test(parts[3] ?? '')) {
    return { action: parts[1], reference: parts[2], page: Number(parts[3]) };
  }
  if (
    (parts[1] === 'choice' || parts[1] === 'confirm') &&
    parts[2] &&
    /^\d+$/.test(parts[3] ?? '') &&
    [
      'use-discord-name',
      'use-league-name',
      'use-roster-name',
      'repair-roles',
      'sync-public-roster',
      'mark-inactive',
    ].includes(parts[4] ?? '')
  ) {
    return {
      action: parts[1],
      reference: parts[2],
      page: Number(parts[3]),
      resolution: parts[4] as LeagueAuditResolutionAction,
    };
  }
  return undefined;
}

export async function handleLeagueAuditReviewButton(
  interaction: ButtonInteraction,
  db: Database.Database,
  operationScope: object,
): Promise<boolean> {
  if (await handleLeagueRepairRecoveryButton(interaction, db, operationScope)) return true;
  const parsed = parseReviewId(interaction.customId);
  if (!parsed) return false;
  if (!interaction.guild) {
    await interaction.reply({
      content: 'League audit review is only available in the YSL server.',
      flags: MessageFlags.Ephemeral,
    });
    return true;
  }
  if (parsed.action === 'review') await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  else await interaction.deferUpdate();
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!hasAccess(member, 'ADMIN')) {
    await interaction.editReply({ content: 'Only league administrators can review or resolve roster audit issues.' });
    return true;
  }
  const dedupeKey = `repair:${parsed.reference}:${parsed.page}:${parsed.resolution}`;
  if (parsed.action === 'confirm') {
    const existing = getLeagueJobByDedupe(db, interaction.guild.id, dedupeKey);
    if (existing) {
      await interaction.editReply({
        content: `Repair ${existing.status.toLowerCase().replaceAll('_', ' ')}. Reference: ${existing.reference}.`,
        embeds: [],
        components: [],
      });
      return true;
    }
  }
  const state = getLeagueAuditState(db, interaction.guild.id);
  if (!state || state.result === 'clean' || state.runReference !== parsed.reference) {
    await interaction.editReply({
      content: 'This audit card is out of date. Use the current League Ops Status panel.',
    });
    return true;
  }
  const finding = state.findings[parsed.page];
  if (!finding) {
    await interaction.editReply({ content: 'That issue is no longer in the active audit.' });
    return true;
  }
  if (parsed.action === 'resolve') {
    await interaction.editReply(payload(buildLeagueAuditResolutionView(finding, parsed.page, parsed.reference)));
    return true;
  }
  if (parsed.action === 'choice') {
    await interaction.editReply(
      payload(buildLeagueAuditConfirmationView(finding, parsed.page, parsed.reference, parsed.resolution!)),
    );
    return true;
  }
  if (parsed.action === 'confirm') {
    await interaction.editReply({
      content: 'Queued: Ratatoskr will recheck this issue before making changes.',
      embeds: [],
      components: [],
      allowedMentions: { parse: [] },
    });
    const intent: LeagueRepairIntent = {
      actorUserId: interaction.user.id,
      actorName: member.displayName || interaction.user.username,
      auditReference: parsed.reference,
      expectedFinding: finding,
      action: parsed.resolution!,
    };
    const job = leagueJobWorkerFor(operationScope, interaction.guild.id).enqueue('repair', intent, dedupeKey);
    await interaction.editReply({
      content: `Repair ${job.status.toLowerCase().replaceAll('_', ' ')}. Reference: ${job.reference}. Use League Ops Status for the current findings.`,
      embeds: [],
      components: [],
      allowedMentions: { parse: [] },
    });
    return true;
  }
  const view = buildLeagueAuditReviewView(state.findings, parsed.page, parsed.reference);
  await interaction.editReply(payload(view));
  return true;
}
