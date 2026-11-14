import { openReinstatementCommand } from '../services/leagueReinstatementUi.js';
import { logMemberReadDeferral, memberReadDeferralMessage } from '../services/leagueMemberReadMessages.js';
import { historicalPlayerChoices, historicalPlayerIndex } from '../services/leagueReinstatement.js';
import { leagueJobWorkerFor } from '../services/leagueJobWorker.js';
import { buildLeagueIntentPlan, type LeagueTransactionIntent } from '../services/leagueTransactionIntent.js';
import {
  MessageFlags,
  SlashCommandBuilder,
  type SlashCommandStringOption,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import type Database from 'better-sqlite3';
import {
  isLayeredDivision,
  isOneWayTrade,
  LeagueMutationValidationError,
  type LeagueMutationPlan,
  type LeagueSnapshot,
  type LeagueTeam,
} from '../domain/leagueOperations.js';
import { hasAccess } from '../services/authorization.js';
import { compareDivisions, LEAGUE_DIVISIONS, LEAGUE_DIVISION_METADATA } from '../domain/leagueDivisions.js';
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

// Picks one membership when a player is on both a Svartalfheim and a Niflheim team (#200).
const targetDivisions = LEAGUE_DIVISIONS.filter((division) => isLayeredDivision(division)
  || LEAGUE_DIVISIONS.some((layered) => LEAGUE_DIVISION_METADATA[layered].layeredOn === division));
function divisionOption(option: SlashCommandStringOption): SlashCommandStringOption {
  return option.setName('division')
    .setDescription('Only for players on two teams: which division this change is for.')
    .addChoices(...targetDivisions.map((division) => ({ name: division, value: division })));
}

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
    .addStringOption(divisionOption)
    .addBooleanOption((option) => option.setName('confirm').setDescription('Choose true after reviewing the transaction preview.')))
  .addSubcommand((subcommand) => subcommand
    .setName('drop')
    .setDescription('Release a rostered player into their division free-agent pool.')
    .addUserOption((option) => option.setName('player').setDescription('Rostered player to release.').setRequired(true))
    .addUserOption((option) => option.setName('replacement').setDescription('Optional same-division free agent replacing them.'))
    .addStringOption(divisionOption)
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
    .addStringOption(divisionOption)
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
    .addStringOption(divisionOption)
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
  const key = baseIntentKey(interaction);
  const division = interaction.options.getString('division');
  // Appended only when chosen, so intents saved before #200 keep their keys.
  return division && !key.startsWith('["trade-one-way",') ? JSON.stringify([...JSON.parse(key) as unknown[], division]) : key;
}

function baseIntentKey(interaction: ChatInputCommandInteraction): string {
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

// Niflheim teams are named with their division so staff can see which membership changes.
function teamName(team: LeagueTeam): string {
  return isLayeredDivision(team.division) ? `${team.franchise} (${team.division})` : team.franchise;
}

function preview(plan: LeagueMutationPlan): string {
  if (plan.kind === 'trade') {
    if (isOneWayTrade(plan)) {
      const [sender, receiver] = plan.teams;
      const sendingAfter = plan.rosters.filter(row => row.teamRoleId === sender!.teamRoleId).length;
      const receivingAfter = plan.rosters.filter(row => row.teamRoleId === receiver!.teamRoleId).length;
      return [
        '**Trade preview · 1-for-0 (one-way transfer)**',
        `${plan.players[0]} (<@${plan.playerIds[0]}>): ${teamName(sender!)} → ${teamName(receiver!)}`,
        `${sender!.franchise} roster: ${sendingAfter + 1} → ${sendingAfter}`,
        `${receiver!.franchise} roster: ${receivingAfter - 1} → ${receivingAfter}`,
        ...(receivingAfter > 7 ? ['The receiving roster would exceed seven players. Confirm only if staff approve the exception.'] : []),
        'Only this player’s team role, their team in our records and their spot on the roster page will change. One line is added to the trade history.',
        '',
        'No changes were made. Re-run with the same options and `confirm:True` after reviewing.',
      ].join('\n');
    }
    return [
      '**Trade preview**',
      `${plan.players[0]}: ${teamName(plan.teams[0]!)} → ${teamName(plan.teams[1]!)}`,
      `${plan.players[1]}: ${teamName(plan.teams[1]!)} → ${teamName(plan.teams[0]!)}`,
      '',
      'No changes were made. Re-run this command with `confirm:True` to process the approved trade.',
    ].join('\n');
  }
  if (plan.kind === 'drop' || plan.kind === 'departure' || plan.kind === 'self-drop') {
    const parent = LEAGUE_DIVISION_METADATA[plan.teams[0]!.division].layeredOn;
    const destination = plan.kind === 'drop' ? parent ? `Released (${parent} status unchanged)` : 'Free Agents'
      : plan.kind === 'departure' ? 'Inactive' : 'Self-Drop Suspension';
    const moves = plan.teams.map((team) => `${plan.players[0]}: ${teamName(team)} → ${destination}`).join('\n');
    const replacement = plan.players[1] ? `\n${plan.players[1]}: Free Agents → ${teamName(plan.teams[0]!)}` : '';
    const label = plan.kind === 'self-drop' ? 'Self-drop' : plan.kind[0]!.toUpperCase() + plan.kind.slice(1);
    return `**${label} preview**\n${moves}${replacement}\n\nNo changes were made. Re-run with \`confirm:True\` to continue.`;
  }
  if (plan.kind === 'pickup') {
    const parent = LEAGUE_DIVISION_METADATA[plan.teams[0]!.division].layeredOn;
    const stays = parent ? `\nThey stay a ${parent} free agent.` : '';
    return `**Pickup preview**\n${plan.players[0]}: Free Agents → ${teamName(plan.teams[0]!)}${stays}\n\nNo changes were made. Re-run with \`confirm:True\` to continue.`;
  }
  return `**Name-change preview**\nDiscord server nickname: ${plan.discordNicknameChange?.beforeDisplayName ?? plan.players[0]} → ${plan.players[0]}\nOfficial league name: ${plan.players[0]}\nCurrent Rosters, Player Name History and public roster will be synced; historical aliases remain preserved.\n\nNo changes were made. Re-run with \`confirm:True\` to continue.`;
}

export function buildRosterPlayerAutocompleteChoices(
  rosters: Awaited<ReturnType<LeagueSheetsService['listRosterPlayers']>>,
  focused: string,
): { name: string; value: string }[] {
  const query = focused.trim().toLocaleLowerCase();
  return [...rosters]
    .sort((left, right) => compareDivisions(left.division, right.division)
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
  const showPreview = async (message = '') => {
    const reviewed = await loadPlan();
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
    // Confirmation approves the saved fingerprint. The worker owns the fresh
    // complete-member read and rejects stale approvals before any writes.
    enqueued = true;
    const job = worker.enqueue('transaction', {
      selections: previewIntent, actorUserId: interaction.user.id, actorName, expectedPlanFingerprint,
    } satisfies LeagueTransactionIntent, dedupeKey);
    if (job.status === 'BLOCKED_REVIEW' && oneWay) {
      await interaction.editReply(`Rat stopped this trade before making any changes. ${leagueValidationMessage(job.lastError ?? '', 'read-only')} Review a fresh preview without confirm before approving again. Reference: ${job.reference}`);
      return;
    }
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
    if (!(await replyToTransactionValidation(interaction, error))) throw error;
    deleteLeagueTransactionPreview(db, guildId, interaction.user.id, previewIntent);
  }
}
