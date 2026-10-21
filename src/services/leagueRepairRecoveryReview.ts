import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ButtonInteraction } from 'discord.js';
import type Database from 'better-sqlite3';
import { listIncompleteLeagueAuditRepairs } from '../db/repositories/leagueAuditRepairs.js';
import { hasAccess } from './authorization.js';
import { leagueJobWorkerFor } from './leagueJobWorker.js';
import { LeagueJobBlockedError } from './leagueJobWorker.js';
import { previewRegisteredLeagueRepairRecovery } from './leagueRepairRecovery.js';
import { leagueActionLabel, savedLeagueErrorMessage } from './leaguePresentation.js';

export async function handleLeagueRepairRecoveryButton(
  interaction: ButtonInteraction,
  db: Database.Database,
  scope: object,
): Promise<boolean> {
  const [prefix, action, target] = interaction.customId.split(':');
  if (prefix !== 'league-recovery' || !['list', 'preview', 'confirm', 'recheck'].includes(action ?? '')) return false;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (!interaction.guild) {
    await interaction.editReply('Unfinished actions can only be checked in the league server.');
    return true;
  }
  const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
  if (!hasAccess(member, 'OPERATIONS')) {
    await interaction.editReply('Only Allfather, Aesir and Valkyrie staff can check unfinished league actions.');
    return true;
  }
  const worker = leagueJobWorkerFor(scope, interaction.guild.id);
  if (action === 'recheck') {
    const job = worker.enqueue('audit', { trigger: 'scheduled' }, 'full-audit');
    await interaction.editReply(
      `A new Discord and roster-sheet check is waiting to start: ${job.reference}. Use Open league tools on the updated League Status message to review any fixes.`,
    );
    return true;
  }
  if (action === 'list') {
    const repairs = listIncompleteLeagueAuditRepairs(db).filter((repair) => repair.guildId === interaction.guild!.id);
    if (!repairs.length) {
      await interaction.editReply(
        'No unfinished roster fixes remain. Use Open league tools to check current differences.',
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
      content: `These fixes were interrupted. Check each one against Discord and the sheets before closing it. Rat will not run the old change again. Showing ${buttons.length} of ${repairs.length}; reopen this list after closing records to see the remaining entries.`,
      components: Array.from({ length: Math.ceil(buttons.length / 5) }, (_, index) =>
        new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(index * 5, index * 5 + 5)),
      ),
      allowedMentions: { parse: [] },
    });
    return true;
  }
  if (!target) {
    await interaction.editReply('The action reference is missing. Open View unfinished fixes again.');
    return true;
  }
  if (action === 'confirm') {
    await interaction.editReply('This view only shows records. Use Open league tools to check that Discord and the sheets agree, then review the history before closing the action.');
    return true;
  }
  let preview;
  try {
    preview = await previewRegisteredLeagueRepairRecovery(scope, interaction.guild.id, target);
  } catch (error) {
    if (!(error instanceof LeagueJobBlockedError)) throw error;
    await interaction.editReply(savedLeagueErrorMessage(error.message));
    return true;
  }
  if (preview.findings.length) worker.enqueue('audit', { trigger: 'scheduled' }, 'full-audit');
  await interaction.editReply({
    content: [
      `Operation: ${preview.repair.reference}`,
      `Earlier fix: ${leagueActionLabel(preview.repair.action)}`,
      `Earlier problem:\n${preview.repair.finding}`,
      `What happened: ${savedLeagueErrorMessage(preview.repair.errorMessage ?? 'Interrupted; outcome unknown.')}`,
      preview.findings.length
        ? `Current problems: ${preview.findings.length}. Fix them from Open league tools before closing this action.`
        : 'Discord and both roster sheets agree, including the player’s names. No new roster fix is needed.',
      'Review the saved action and name history first. Closing it records that today’s records agree. It does not run the old change again or say the old attempt succeeded.',
    ]
      .join('\n\n')
      .slice(0, 1950),
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(
            `league-recovery:confirm:${target}:${Buffer.from(preview.fingerprint, 'hex').toString('base64url')}`,
          )
          .setLabel('Close checked action')
          .setDisabled(true)
          .setStyle(ButtonStyle.Primary),
      ),
    ],
    allowedMentions: { parse: [] },
  });
  return true;
}
