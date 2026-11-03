import { openReinstatementCommand } from '../services/leagueReinstatementUi.js';
import { logMemberReadDeferral, memberReadDeferralMessage } from '../services/leagueMemberReadMessages.js';
import { historicalPlayerChoices, historicalPlayerIndex } from '../services/leagueReinstatement.js';
import { getLeagueJobByDedupe } from '../db/repositories/leagueJobs.js';
import { leagueJobWorkerFor } from '../services/leagueJobWorker.js';
import { buildLeagueIntentPlan, type LeagueTransactionIntent } from '../services/leagueTransactionIntent.js';
import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import type Database from 'better-sqlite3';
import {
  isOneWayTrade,
  LeagueMutationValidationError,
  type LeagueMutationPlan,
  type LeagueSnapshot,
} from '../domain/leagueOperations.js';
import { hasAccess } from '../services/authorization.js';
import { loadLeagueOperationsConfig } from '../config/league-operations.js';
import { DiscordLeagueGateway } from '../services/leagueDiscord.js';
import { createGoogleLeagueSheetsGateway, LeagueSheetsService } from '../services/leagueSheets.js';
import {
  deleteLeagueTransactionPreview,
  getLeaguePreviewApproval,
  getLeagueTransactionPreviewFingerprint,
  saveLeagueTransactionPreview,
} from '../db/repositories/leagueOperations.js';
import {
  leagueTransactionPlanFingerprint,
  validateOneWayTradePreview,
} from '../services/leagueTransactions.js';
import { persistPreviewAfterDelivery } from '../services/transactionPreview.js';
import { leagueStatusLabel, savedLeagueErrorMessage, leagueValidationMessage } from '../services/leaguePresentation.js';

export const transactionCommand = new SlashCommandBuilder()
  .setName('transaction')
  .setDescription('Process approved YSL roster changes.')
  .setDMPermission(false)
  .addSubcommand(subcommand => subcommand.setName('reinstate').setDescription('Review a former player’s return with linked exit history.')
    .addStringOption(option => option.setName('player').setDescription('Player name, old nickname or Discord ID, including departed players.').setAutocomplete(true).setRequired(true))
    .addStringOption(option => option.setName('transaction').setDescription('Optional original exit reference when several exits match.'))
    .addStringOption(option => option.setName('reason').setDescription('Optional short staff reason for the return.').setMaxLength(300)))
  .addSubcommand((subcommand) => subcommand
    .setName('trade')
    .setDescription('Swap two players or transfer one player to another team in the same division.')
    .addUserOption((option) => option.setName('player_one').setDescription('Player leaving the first team.').setRequired(true))
    .addUserOption((option) => option.setName('player_two').setDescription('Player leaving the other team in a swap.'))
    .addRoleOption((option) => option.setName('receiving_team').setDescription('Team receiving the player when no player comes back.'))
    .addBooleanOption((option) => option.setName('confirm').setDescription('Choose true after reviewing the transaction preview.')))
  .addSubcommand((subcommand) => subcommand
    .setName('drop')
    .setDescription('Release a rostered player into their division free-agent pool.')
    .addUserOption((option) => option.setName('player').setDescription('Rostered player to release.').setRequired(true))
    .addUserOption((option) => option.setName('replacement').setDescription('Optional same-division free agent replacing them.'))
    .addBooleanOption((option) => option.setName('confirm').setDescription('Choose true after reviewing the transaction preview.')))
  .addSubcommand((subcommand) => subcommand
    .setName('self-drop')
    .setDescription('Record a self-drop and optional same-division replacement.')
    .addStringOption((option) => option
      .setName('player')
      .setDescription('Rostered player who self-dropped, including players who left Discord.')
      .setAutocomplete(true)
      .setRequired(true))
    .addUserOption((option) => option.setName('replacement').setDescription('Optional same-division free agent replacing them.'))
    .addBooleanOption((option) => option.setName('confirm').setDescription('Choose true after reviewing the transaction preview.')))
  .addSubcommand((subcommand) => subcommand
    .setName('departure')
    .setDescription('Remove a rostered player who has left the YSL server.')
    .addStringOption((option) => option
      .setName('player')
      .setDescription('Departed rostered player.')
      .setAutocomplete(true)
      .setRequired(true))
    .addUserOption((option) => option.setName('replacement').setDescription('Optional same-division free agent replacing them.'))
    .addBooleanOption((option) => option.setName('confirm').setDescription('Choose true after reviewing the transaction preview.')))
  .addSubcommand((subcommand) => subcommand
    .setName('pickup')
    .setDescription('Add a division free agent to an active team.')
    .addUserOption((option) => option.setName('player').setDescription('Free agent joining the team.').setRequired(true))
    .addRoleOption((option) => option.setName('team').setDescription('Team role for the player to join; choose the one for their division.').setRequired(true))
    .addBooleanOption((option) => option.setName('confirm').setDescription('Choose true after reviewing the transaction preview.')))
  .addSubcommand((subcommand) => subcommand
    .setName('rename')
    .setDescription("Preview or confirm a player's Discord nickname and league name change.")
    .addUserOption((option) => option.setName('player').setDescription('Player to rename.').setRequired(true))
    .addStringOption((option) => option.setName('league_name').setDescription('New server nickname and official league name.').setRequired(true).setMaxLength(32))
    .addBooleanOption((option) => option.setName('confirm').setDescription('Choose true after reviewing the transaction preview.')));

function intentKey(interaction: ChatInputCommandInteraction): string {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'trade') {
    const player = interaction.options.getUser('player_one', true).id;
    const counterpart = interaction.options.getUser('player_two')?.id;
    const receiver = interaction.options.getRole('receiving_team')?.id;
    if (Boolean(counterpart) === Boolean(receiver)) {
      throw new LeagueMutationValidationError('Choose player_two for a swap or receiving_team for a one-way transfer. Choose exactly one.');
    }
    return counterpart ? JSON.stringify(['trade', player, counterpart]) : JSON.stringify(['trade-one-way', player, receiver]);
  }
  if (subcommand === 'departure') {
    return JSON.stringify([subcommand, interaction.options.getString('player', true), interaction.options.getUser('replacement')?.id ?? null]);
  }
  if (subcommand === 'self-drop') {
    return JSON.stringify([subcommand, interaction.options.getString('player', true), interaction.options.getUser('replacement')?.id ?? null]);
  }
  const player = interaction.options.getUser('player', true).id;
  if (subcommand === 'drop') {
    return JSON.stringify([subcommand, player, interaction.options.getUser('replacement')?.id ?? null]);
  }
  if (subcommand === 'pickup') return JSON.stringify([subcommand, player, interaction.options.getRole('team', true).id]);
  if (subcommand === 'rename') return JSON.stringify([subcommand, player, interaction.options.getString('league_name', true)]);
  return JSON.stringify([subcommand, player]);
}

function preview(plan: LeagueMutationPlan): string {
  if (plan.kind === 'trade') {
    if (isOneWayTrade(plan)) {
      const [sender, receiver] = plan.teams;
      const sendingAfter = plan.rosters.filter(row => row.teamRoleId === sender!.teamRoleId).length;
      const receivingAfter = plan.rosters.filter(row => row.teamRoleId === receiver!.teamRoleId).length;
      return [
        '**Trade preview · 1-for-0 (one-way transfer)**',
        `${plan.players[0]} (<@${plan.playerIds[0]}>): ${sender!.franchise} → ${receiver!.franchise}`,
        `${sender!.franchise} roster: ${sendingAfter + 1} → ${sendingAfter}`,
        `${receiver!.franchise} roster: ${receivingAfter - 1} → ${receivingAfter}`,
        ...(receivingAfter > 7 ? ['The receiving roster would exceed seven players. Confirm only if staff approve the exception.'] : []),
        'Only this player’s team role, Current Rosters assignment, Player Name History franchise and public roster placement will change. One trade history row will be added.',
        '',
        'No changes were made. Re-run with the same options and `confirm:True` after reviewing.',
      ].join('\n');
    }
    return [
      '**Trade preview**',
      `${plan.players[0]}: ${plan.teams[0]!.franchise} → ${plan.teams[1]!.franchise}`,
      `${plan.players[1]}: ${plan.teams[1]!.franchise} → ${plan.teams[0]!.franchise}`,
      '',
      'No changes were made. Re-run this command with `confirm:True` to process the approved trade.',
    ].join('\n');
  }
  if (plan.kind === 'drop' || plan.kind === 'departure' || plan.kind === 'self-drop') {
    const destination = plan.kind === 'drop' ? 'Free Agents' : plan.kind === 'departure' ? 'Inactive' : 'Self-Drop Suspension';
    const replacement = plan.players[1] ? `\n${plan.players[1]}: Free Agents → ${plan.teams[0]!.franchise}` : '';
    const label = plan.kind === 'self-drop' ? 'Self-drop' : plan.kind[0]!.toUpperCase() + plan.kind.slice(1);
    return `**${label} preview**\n${plan.players[0]}: ${plan.teams[0]!.franchise} → ${destination}${replacement}\n\nNo changes were made. Re-run with \`confirm:True\` to continue.`;
  }
  if (plan.kind === 'pickup') return `**Pickup preview**\n${plan.players[0]}: Free Agents → ${plan.teams[0]!.franchise}\n\nNo changes were made. Re-run with \`confirm:True\` to continue.`;
  return `**Name-change preview**\nDiscord server nickname: ${plan.discordNicknameChange?.beforeDisplayName ?? plan.players[0]} → ${plan.players[0]}\nOfficial league name: ${plan.players[0]}\nCurrent Rosters, Player Name History and public roster will be synced; historical aliases remain preserved.\n\nNo changes were made. Re-run with \`confirm:True\` to continue.`;
}

const divisionOrder = new Map([['Vanaheim', 0], ['Alfheim', 1], ['Svartalfheim', 2]]);

export function buildRosterPlayerAutocompleteChoices(
  rosters: Awaited<ReturnType<LeagueSheetsService['listRosterPlayers']>>,
  focused: string,
): { name: string; value: string }[] {
  const query = focused.trim().toLocaleLowerCase();
  return [...rosters]
    .sort((left, right) => (divisionOrder.get(left.division)! - divisionOrder.get(right.division)!)
      || left.franchise.localeCompare(right.franchise)
      || left.player.localeCompare(right.player))
    .filter((row) => `${row.player} ${row.franchise} ${row.division}`.toLocaleLowerCase().includes(query))
    .slice(0, 25)
    .map((row) => ({
      name: `${row.player} — ${row.franchise} (${row.division})`.slice(0, 100),
      value: row.discordId,
    }));
}

export async function handleTransactionAutocomplete(interaction: AutocompleteInteraction, db?: Database.Database): Promise<void> {
  if (!['departure', 'self-drop', 'reinstate'].includes(interaction.options.getSubcommand(false) ?? '')
    || interaction.options.getFocused(true).name !== 'player'
    || !interaction.guild) {
    await interaction.respond([]);
    return;
  }
  try {
    const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
    if (!hasAccess(member, 'OPERATIONS')) {
      await interaction.respond([]);
      return;
    }
    const { gateway, config } = createGoogleLeagueSheetsGateway();
    const sheets = new LeagueSheetsService(gateway, config);
    const choices = interaction.options.getSubcommand() === 'reinstate'
      ? historicalPlayerChoices(db ? historicalPlayerIndex(db, interaction.guild.id, await sheets.listHistoricalNames()) : await sheets.listHistoricalNames(), interaction.options.getFocused()).slice(0, 25)
      : buildRosterPlayerAutocompleteChoices(
      await sheets.listRosterPlayers(),
      interaction.options.getFocused(),
    );
    await interaction.respond(choices);
  } catch (error) {
    console.error('Transaction roster-player autocomplete failed:', error);
    await interaction.respond([]);
  }
}

export async function replyToTransactionValidation(
  interaction: { editReply(content: string): Promise<unknown> },
  error: unknown,
): Promise<boolean> {
  if (!(error instanceof LeagueMutationValidationError)) return false;
  await interaction.editReply(`Rat cannot show this player change yet: ${leagueValidationMessage(error.message, 'read-only')}\n\nNo changes were made.`);
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
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
  if (!hasAccess(member,'OPERATIONS')) { await interaction.editReply('You do not have permission to use this command.'); return; }

  if (interaction.options.getSubcommand() === 'reinstate') {
    await openReinstatementCommand(interaction, db, operationScope);
    return;
  }
  let previewIntent: string;
  try {
    previewIntent = intentKey(interaction);
  } catch (error) {
    if (!(error instanceof LeagueMutationValidationError)) throw error;
    await interaction.editReply(`${error.message} No changes were made.`);
    return;
  }
  const transactionEnvironment = loadLeagueOperationsConfig();
  const { gateway, config } = createGoogleLeagueSheetsGateway();
  const sheets = new LeagueSheetsService(gateway, config);
  const discord = new DiscordLeagueGateway(interaction.guild, transactionEnvironment.transactionsChannelId);
  const buildPlan = (snapshot: LeagueSnapshot) => buildLeagueIntentPlan(previewIntent,snapshot);

  const oneWay = previewIntent.startsWith('["trade-one-way",');
  const loadPlan = async () => {
    const loaded = await sheets.load(await discord.getMembers(), transactionEnvironment.freeAgentRoleId);
    const plan = buildPlan(loaded.snapshot);
    if (plan.discordNicknameChange) await discord.validateNicknameChange(plan.discordNicknameChange);
    if (oneWay) await validateOneWayTradePreview(loaded, plan, sheets, discord);
    return plan;
  };
  const showPreview = async (message = '', plan?: LeagueMutationPlan) => {
    const reviewed = plan ?? await loadPlan();
    await persistPreviewAfterDelivery(
      () => interaction.editReply(`${message}${preview(reviewed)}`),
      () => saveLeagueTransactionPreview(db, {
        guildId,
        actorUserId: interaction.user.id,
        intentKey: previewIntent,
        planFingerprint: leagueTransactionPlanFingerprint(reviewed),
      }),
    );
  };

  // Set once a job exists. Member-read failures before that point are read-only previews.
  let enqueued = false;
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
    const worker = leagueJobWorkerFor(operationScope,interaction.guild.id);
    const dedupeKey = `transaction:${interaction.user.id}:${previewIntent}:${getLeaguePreviewApproval(db,guildId,interaction.user.id,previewIntent)}`;
    const existing = oneWay ? getLeagueJobByDedupe(db, guildId, dedupeKey) : undefined;
    if (oneWay && !existing) {
      const fresh = await loadPlan();
      const currentActor = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
      if (!hasAccess(currentActor, 'OPERATIONS')) {
        await interaction.editReply('You no longer have permission to confirm this trade. No changes were made.');
        return;
      }
      const approval = getLeaguePreviewApproval(db, guildId, interaction.user.id, previewIntent);
      if (leagueTransactionPlanFingerprint(fresh) !== expectedPlanFingerprint
        || `transaction:${interaction.user.id}:${previewIntent}:${approval}` !== dedupeKey) {
        await showPreview('The trade changed after your review. Check this new preview before confirming.\n\n', fresh);
        return;
      }
    }
    enqueued = true;
    const job = existing ?? worker.enqueue('transaction', {
      selections: previewIntent, actorUserId: interaction.user.id, actorName, expectedPlanFingerprint,
    } satisfies LeagueTransactionIntent, dedupeKey);
    if (job.status === 'BLOCKED_REVIEW') {
      await showPreview(`This player change needs another review. ${savedLeagueErrorMessage(job.lastError)}\n\n`);
      return;
    }
    await interaction.editReply(`${leagueStatusLabel(job.status)}. Reference: ${job.reference}\nUse Open league tools on the League Status message to check this action. Do not submit it again.`);
  } catch (error) {
    // A Discord cooldown while building a preview is a private, no-change deferral, not the
    // generic staff alert about possible partial changes (#186). Keep any earlier preview.
    const deferred = enqueued ? undefined
      : memberReadDeferralMessage(error, { unchanged: 'No changes were made.', retry: 'Run the same /transaction command again' });
    if (deferred) {
      logMemberReadDeferral(guildId, `/transaction ${interaction.options.getSubcommand()}`, error);
      await interaction.editReply(deferred);
      return;
    }
    if (oneWay && !enqueued && error instanceof LeagueMutationValidationError) {
      await interaction.editReply(`${error.message}\n\nNo changes were made.`);
    } else if (!(await replyToTransactionValidation(interaction, error))) throw error;
    deleteLeagueTransactionPreview(db, guildId, interaction.user.id, previewIntent);
  }
}
