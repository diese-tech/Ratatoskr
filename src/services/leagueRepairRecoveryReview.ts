import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ButtonInteraction } from 'discord.js';
import type Database from 'better-sqlite3';
import { listIncompleteLeagueAuditRepairs } from '../db/repositories/leagueAuditRepairs.js';
import {
  getLeagueTransactionPreviewFingerprint,
  saveLeagueTransactionPreview,
} from '../db/repositories/leagueOperations.js';
import { hasAccess } from './authorization.js';
import { leagueJobWorkerFor } from './leagueJobWorker.js';
import { LeagueJobBlockedError } from './leagueJobWorker.js';
import { previewRegisteredLeagueRepairRecovery } from './leagueRepairRecovery.js';
import type { LeagueRepairIntent } from './leagueOpsRuntime.js';

export async function handleLeagueRepairRecoveryButton(
  interaction: ButtonInteraction,
  db: Database.Database,
  scope: object,
): Promise<boolean> {
  const [prefix, action, target, approval] = interaction.customId.split(':');
  if (prefix !== 'league-recovery' || !['list', 'preview', 'confirm', 'recheck'].includes(action ?? '')) return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guild) {
    await interaction.editReply('League recovery is only available in the league server.');
    return true;
  }
  const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
  if (!hasAccess(member, 'ADMIN')) {
    await interaction.editReply('Only league administrators can reconcile operations.');
    return true;
  }
  const worker = leagueJobWorkerFor(scope, interaction.guild.id);
  if (action === 'recheck') {
    const job = worker.enqueue('audit', { trigger: 'scheduled' }, 'full-audit');
    await interaction.editReply(
      `Fresh Discord and Sheets check queued: ${job.reference}. Use Review issues on the refreshed panel to preview Discord-name sheet repairs.`,
    );
    return true;
  }
  if (action === 'list') {
    const repairs = listIncompleteLeagueAuditRepairs(db).filter((repair) => repair.guildId === interaction.guild!.id);
    if (!repairs.length) {
      await interaction.editReply(
        'No interrupted audit repairs remain. Use Review issues for current roster differences.',
      );
      return true;
    }
    const buttons = repairs.slice(0, 20).map((repair) =>
      new ButtonBuilder()
        .setCustomId(`league-recovery:preview:${repair.reference}`)
        .setLabel(`Review ${repair.reference}`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(repair.status !== 'reconciliation_required'),
    );
    await interaction.editReply({
      content: `These are interrupted repair records. Review each against fresh Discord and Sheets state before explicitly closing it. No interrupted mutation will be replayed. Showing ${buttons.length} of ${repairs.length}; reopen this list after closing records to see the remaining entries.`,
      components: Array.from({ length: Math.ceil(buttons.length / 5) }, (_, index) =>
        new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(index * 5, index * 5 + 5)),
      ),
      allowedMentions: { parse: [] },
    });
    return true;
  }
  if (!target) {
    await interaction.editReply('The recovery reference is missing. Open Review operations again.');
    return true;
  }
  const intentKey = `repair-recovery:${target}`;
  if (action === 'confirm') {
    const fingerprint = getLeagueTransactionPreviewFingerprint(
      db,
      interaction.guild.id,
      interaction.user.id,
      intentKey,
    );
    if (!fingerprint || approval !== Buffer.from(fingerprint, 'hex').toString('base64url')) {
      await interaction.editReply(
        'This recovery approval is missing or out of date. Review this operation again before confirming.',
      );
      return true;
    }
    const intent: LeagueRepairIntent = {
      actorUserId: interaction.user.id,
      actorName: member.displayName,
      auditReference: '',
      expectedFinding: '',
      action: 'use-discord-name',
      reconcileReference: target,
      expectedRecoveryFingerprint: fingerprint,
    };
    const job = worker.enqueue('repair', intent, `recovery:${target}:${interaction.user.id}:${fingerprint}`);
    await interaction.editReply(
      `Reconciliation acknowledgement ${job.status.toLowerCase().replaceAll('_', ' ')}: ${job.reference}. Fresh state will be checked again before closing ${target}.`,
    );
    return true;
  }
  let preview;
  try {
    preview = await previewRegisteredLeagueRepairRecovery(scope, interaction.guild.id, target);
  } catch (error) {
    if (!(error instanceof LeagueJobBlockedError)) throw error;
    await interaction.editReply(error.message);
    return true;
  }
  if (preview.findings.length) worker.enqueue('audit', { trigger: 'scheduled' }, 'full-audit');
  saveLeagueTransactionPreview(db, {
    guildId: interaction.guild.id,
    actorUserId: interaction.user.id,
    intentKey,
    planFingerprint: preview.fingerprint,
  });
  await interaction.editReply({
    content: [
      `Operation: ${preview.repair.reference}`,
      `Original repair: ${preview.repair.action}`,
      `Original finding:\n${preview.repair.finding}`,
      `Recorded failure: ${preview.repair.errorMessage ?? 'Interrupted; outcome unknown.'}`,
      preview.findings.length
        ? `Current findings: ${preview.findings.length}. Resolve them from Review issues before closing this record.`
        : 'Fresh Discord, private roster, name history and public roster values agree. No current roster repair is needed.',
      'Confirm only after reviewing the recorded operation and name history. This records your reconciliation acknowledgement; it does not replay the old mutation or declare its historical write successful.',
    ]
      .join('\n\n')
      .slice(0, 1950),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            `league-recovery:confirm:${target}:${Buffer.from(preview.fingerprint, 'hex').toString('base64url')}`,
          )
          .setLabel('Confirm reconciled')
          .setDisabled(Boolean(preview.findings.length))
          .setStyle(ButtonStyle.Primary),
      ),
    ],
    allowedMentions: { parse: [] },
  });
  return true;
}
