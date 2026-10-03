import {
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import type Database from 'better-sqlite3';
import {
  buildDropPlan,
  buildPickupPlan,
  buildRenamePlan,
  buildTradePlan,
  LeagueMutationValidationError,
  type LeagueMutationPlan,
  type LeagueSnapshot,
} from '../domain/leagueOperations.js';
import { requireAccess } from '../services/authorization.js';
import { loadLeagueOperationsConfig } from '../config/league-operations.js';
import { DiscordLeagueGateway } from '../services/leagueDiscord.js';
import { createGoogleLeagueSheetsGateway, LeagueSheetsService } from '../services/leagueSheets.js';
import {
  deleteLeagueTransactionPreview,
  getLeagueTransactionPreviewFingerprint,
  saveLeagueTransactionPreview,
} from '../db/repositories/leagueOperations.js';
import {
  executeLeagueTransaction,
  LeagueTransactionPreviewChangedError,
  leagueTransactionPlanFingerprint,
} from '../services/leagueTransactions.js';
import { persistPreviewAfterDelivery } from '../services/transactionPreview.js';

export const transactionCommand = new SlashCommandBuilder()
  .setName('transaction')
  .setDescription('Process approved YSL roster changes.')
  .setDMPermission(false)
  .addSubcommand((subcommand) => subcommand
    .setName('trade')
    .setDescription('Swap two players between teams in the same division.')
    .addUserOption((option) => option.setName('player_one').setDescription('Player leaving the first team.').setRequired(true))
    .addUserOption((option) => option.setName('player_two').setDescription('Player leaving the other team.').setRequired(true))
    .addBooleanOption((option) => option.setName('confirm').setDescription('Choose true after reviewing the transaction preview.')))
  .addSubcommand((subcommand) => subcommand
    .setName('drop')
    .setDescription('Release a rostered player into their division free-agent pool.')
    .addUserOption((option) => option.setName('player').setDescription('Rostered player to release.').setRequired(true))
    .addBooleanOption((option) => option.setName('confirm').setDescription('Choose true after reviewing the transaction preview.')))
  .addSubcommand((subcommand) => subcommand
    .setName('pickup')
    .setDescription('Add a division free agent to an active team.')
    .addUserOption((option) => option.setName('player').setDescription('Free agent joining the team.').setRequired(true))
    .addRoleOption((option) => option.setName('team').setDescription('Division-suffixed team role receiving the player.').setRequired(true))
    .addBooleanOption((option) => option.setName('confirm').setDescription('Choose true after reviewing the transaction preview.')))
  .addSubcommand((subcommand) => subcommand
    .setName('rename')
    .setDescription("Change a player's official league name while preserving name history.")
    .addUserOption((option) => option.setName('player').setDescription('Player whose official league name is changing.').setRequired(true))
    .addStringOption((option) => option.setName('league_name').setDescription('New official league name.').setRequired(true).setMaxLength(100))
    .addBooleanOption((option) => option.setName('confirm').setDescription('Choose true after reviewing the transaction preview.')));

function planBuilder(interaction: ChatInputCommandInteraction): (snapshot: LeagueSnapshot) => LeagueMutationPlan {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'trade') {
    const first = interaction.options.getUser('player_one', true).id;
    const second = interaction.options.getUser('player_two', true).id;
    return (snapshot) => buildTradePlan(snapshot, first, second);
  }
  const player = interaction.options.getUser('player', true).id;
  if (subcommand === 'drop') return (snapshot) => buildDropPlan(snapshot, player);
  if (subcommand === 'pickup') {
    const teamRole = interaction.options.getRole('team', true).id;
    return (snapshot) => buildPickupPlan(snapshot, player, teamRole);
  }
  if (subcommand === 'rename') {
    const leagueName = interaction.options.getString('league_name', true);
    return (snapshot) => buildRenamePlan(snapshot, player, leagueName);
  }
  throw new Error('Unknown transaction type.');
}

function intentKey(interaction: ChatInputCommandInteraction): string {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'trade') {
    return JSON.stringify([subcommand, interaction.options.getUser('player_one', true).id, interaction.options.getUser('player_two', true).id]);
  }
  const player = interaction.options.getUser('player', true).id;
  if (subcommand === 'pickup') return JSON.stringify([subcommand, player, interaction.options.getRole('team', true).id]);
  if (subcommand === 'rename') return JSON.stringify([subcommand, player, interaction.options.getString('league_name', true)]);
  return JSON.stringify([subcommand, player]);
}

function preview(plan: LeagueMutationPlan): string {
  if (plan.kind === 'trade') {
    return [
      '**Trade preview**',
      `${plan.players[0]}: ${plan.teams[0]!.franchise} → ${plan.teams[1]!.franchise}`,
      `${plan.players[1]}: ${plan.teams[1]!.franchise} → ${plan.teams[0]!.franchise}`,
      '',
      'No changes were made. Re-run this command with `confirm:True` to process the approved trade.',
    ].join('\n');
  }
  if (plan.kind === 'drop') return `**Drop preview**\n${plan.players[0]}: ${plan.teams[0]!.franchise} → Free Agents\n\nNo changes were made. Re-run with \`confirm:True\` to continue.`;
  if (plan.kind === 'pickup') return `**Pickup preview**\n${plan.players[0]}: Free Agents → ${plan.teams[0]!.franchise}\n\nNo changes were made. Re-run with \`confirm:True\` to continue.`;
  return `**Name-change preview**\nOfficial league name: ${plan.players[0]}\n\nNo changes were made. Re-run with \`confirm:True\` to continue.`;
}

export async function replyToTransactionValidation(
  interaction: { editReply(content: string): Promise<unknown> },
  error: unknown,
): Promise<boolean> {
  if (!(error instanceof LeagueMutationValidationError)) return false;
  await interaction.editReply(`Transaction cannot be previewed: ${error.message}\n\nNo changes were made.`);
  return true;
}

export async function handleTransactionCommand(
  interaction: ChatInputCommandInteraction,
  db: Database.Database,
  operationScope: object,
): Promise<void> {
  if (!interaction.guild) {
    await interaction.reply({ content: 'This command can only be used in the YSL server.', flags: MessageFlags.Ephemeral });
    return;
  }
  const guildId = interaction.guild.id;
  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (!(await requireAccess(interaction, member, 'ADMIN'))) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const transactionEnvironment = loadLeagueOperationsConfig();
  const { gateway, config } = createGoogleLeagueSheetsGateway();
  const sheets = new LeagueSheetsService(gateway, config);
  const discord = new DiscordLeagueGateway(interaction.guild, transactionEnvironment.transactionsChannelId);
  const buildPlan = planBuilder(interaction);
  const previewIntent = intentKey(interaction);

  const showPreview = async (message = '') => {
    const loaded = await sheets.load(await discord.getMembers(), transactionEnvironment.freeAgentRoleId);
    const plan = buildPlan(loaded.snapshot);
    await persistPreviewAfterDelivery(
      () => interaction.editReply(`${message}${preview(plan)}`),
      () => saveLeagueTransactionPreview(db, {
        guildId,
        actorUserId: interaction.user.id,
        intentKey: previewIntent,
        planFingerprint: leagueTransactionPlanFingerprint(plan),
      }),
    );
  };

  try {
    if (interaction.options.getBoolean('confirm') !== true) {
      await showPreview();
      return;
    }

    const expectedPlanFingerprint = getLeagueTransactionPreviewFingerprint(
      db, guildId, interaction.user.id, previewIntent,
    );
    if (!expectedPlanFingerprint) {
      await showPreview('A matching preview is required before confirmation.\n\n');
      return;
    }

    const actorName = (member as GuildMember).displayName || interaction.user.globalName || interaction.user.username;
    let result: Awaited<ReturnType<typeof executeLeagueTransaction>>;
    try {
      result = await executeLeagueTransaction({
        db,
        operationScope,
        guildId,
        actorUserId: interaction.user.id,
        actorName,
        freeAgentRoleId: transactionEnvironment.freeAgentRoleId,
        now: new Date(),
        sheets,
        discord,
        buildPlan,
        expectedPlanFingerprint,
      });
    } catch (error) {
      if (!(error instanceof LeagueTransactionPreviewChangedError)) throw error;
      await persistPreviewAfterDelivery(
        () => interaction.editReply(`League state changed after your preview. Review this updated transaction before confirming again.\n\n${preview(error.plan)}`),
        () => saveLeagueTransactionPreview(db, {
          guildId,
          actorUserId: interaction.user.id,
          intentKey: previewIntent,
          planFingerprint: leagueTransactionPlanFingerprint(error.plan),
        }),
      );
      return;
    }
    deleteLeagueTransactionPreview(db, guildId, interaction.user.id, previewIntent);
    await interaction.editReply(`Transaction completed. Reference: ${result.reference}`);
  } catch (error) {
    if (!(await replyToTransactionValidation(interaction, error))) throw error;
    deleteLeagueTransactionPreview(db, guildId, interaction.user.id, previewIntent);
  }
}
