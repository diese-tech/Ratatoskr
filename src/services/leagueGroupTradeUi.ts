import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, StringSelectMenuBuilder,
  type ChatInputCommandInteraction, type Interaction,
} from 'discord.js';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  auditLeagueRoster, buildGroupTradePlan, LeagueMutationValidationError, type GroupTradeSelection, type LeagueMutationPlan,
} from '../domain/leagueOperations.js';
import { loadLeagueOperationsConfig } from '../config/league-operations.js';
import { hasAccess } from './authorization.js';
import { humanizeLeagueAuditIssues } from './leagueAuditPresentation.js';
import { DiscordLeagueGateway } from './leagueDiscord.js';
import { leagueJobWorkerFor } from './leagueJobWorker.js';
import { logMemberReadDeferral, memberReadDeferralMessage } from './leagueMemberReadMessages.js';
import { leagueStatusLabel, leagueValidationMessage } from './leaguePresentation.js';
import { buildVerifiedTransactionIntent } from './leagueReinstatement.js';
import { createGoogleLeagueSheetsGateway, LeagueSheetsService, LeagueSheetDriftError, type LoadedLeagueSnapshot } from './leagueSheets.js';
import { groupTradeIntent } from './leagueTransactionIntent.js';
import { leagueTransactionPlanFingerprint } from './leagueTransactions.js';

const REVIEW_TTL = 10 * 60_000;
type TradeReview = {
  token: string;
  expires: number;
  selection: GroupTradeSelection;
  loaded: LoadedLeagueSnapshot;
  plan?: LeagueMutationPlan;
  blocker?: string;
  busy?: boolean;
  reference?: string;
};
const reviews = new WeakMap<object, Map<string, TradeReview | { busy: true }>>();

function reviewMap(scope: object) {
  let map = reviews.get(scope);
  if (!map) { map = new Map(); reviews.set(scope, map); }
  return map;
}

function services(guild: NonNullable<Interaction['guild']>) {
  const environment = loadLeagueOperationsConfig();
  const { gateway, config } = createGoogleLeagueSheetsGateway();
  return {
    sheets: new LeagueSheetsService(gateway, config),
    discord: new DiscordLeagueGateway(guild, environment.transactionsChannelId),
    freeAgentRoleId: environment.freeAgentRoleId,
  };
}

function privateError(error: unknown, guildId: string): string {
  const deferred = memberReadDeferralMessage(error, { unchanged: 'No changes were made.', retry: 'Try the trade review again' });
  if (deferred) {
    logMemberReadDeferral(guildId, 'group trade review', error);
    return deferred;
  }
  console.error('Trade review stopped before approval:', error);
  const guidance = error instanceof LeagueMutationValidationError || error instanceof LeagueSheetDriftError
    ? leagueValidationMessage(error.message, 'read-only')
    : 'Rat could not verify the trade. Ask staff to check Discord and the roster sheets, then open a fresh review.';
  return `${guidance}\n\nNo changes were made.`;
}

function groupTradeReviewText(plan: Pick<LeagueMutationPlan, 'groupTrade' | 'teams' | 'players'>, blocker?: string): string {
  const details = plan.groupTrade!;
  const a = details.selection.outboundA.length;
  const b = details.selection.outboundB.length;
  const [first, second] = plan.teams;
  return [
    `**${a}-for-${b} trade · ${first!.division}**`,
    `${first!.franchise} → ${second!.franchise}: ${plan.players.slice(0, a).join(', ')}`,
    `${second!.franchise} → ${first!.franchise}: ${plan.players.slice(a).join(', ')}`,
    ...plan.teams.map((team, i) => [
      `**${team.franchise} · ${details.before[i]!.length} → ${details.after[i]!.length} players**`,
      `Before: ${details.before[i]!.join(', ') || 'Empty'}`,
      `After: ${details.after[i]!.join(', ') || 'Empty'}`,
    ].join('\n')),
    'Rat will update team roles, Current Rosters, Player Name History and the public roster for all movers. Each mover gets a History row under one trade reference. Original draft ownership stays with the original picks.',
    '**Staff advisories**',
    ...details.advisories,
    ...(details.selection.reason ? [`Staff reason: ${details.selection.reason}`] : []),
    blocker ? `**Trade blocked**\n${blocker}\nNo changes were made.`
      : 'Confirm trade approves the moves and the advisories shown. No changes were made.',
  ].join('\n\n');
}

function reviewMessage(review: TradeReview) {
  const { loaded, selection } = review;
  const id = (action: string) => `group-trade:${action}:${review.token}`;
  const components: (ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>)[] = [];
  for (const [side, role, selected] of [
    ['a', selection.teamA, selection.outboundA], ['b', selection.teamB, selection.outboundB],
  ] as const) {
    const team = loaded.snapshot.teams.find(row => row.teamRoleId === role && row.active);
    const roster = loaded.snapshot.rosters.filter(row => row.teamRoleId === role);
    if (!team || !roster.length || roster.length > 25) continue;
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId(id(side)).setPlaceholder(`Players sent by ${team.franchise}`.slice(0, 150))
        .setMinValues(0).setMaxValues(Math.min(3, roster.length)).addOptions(roster.map(row => ({
          label: row.player.slice(0, 100), value: row.discordId, default: selected.includes(row.discordId),
          description: `${row.rosterStatus} · Discord ID ${row.discordId}`.slice(0, 100),
        }))),
    ));
  }
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(id('cancel')).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(id('confirm')).setLabel('Confirm trade').setStyle(ButtonStyle.Primary)
      .setDisabled(!review.plan || Boolean(review.blocker)),
  ));
  const description = review.plan ? groupTradeReviewText(review.plan, review.blocker) : [
    '**Two-team trade review**',
    review.blocker ? `**Trade blocked**\n${review.blocker}` : 'Choose the players each team sends. Change either selection before confirming.',
    'No changes were made.',
  ].join('\n\n');
  return { content: '', embeds: [new EmbedBuilder().setDescription(description)], components, allowedMentions: { parse: [] as never[] } };
}

async function buildReview(
  db: Database.Database, guildId: string, loaded: LoadedLeagueSnapshot, selection: GroupTradeSelection,
  { sheets, discord }: ReturnType<typeof services>,
): Promise<TradeReview> {
  const review: TradeReview = { token: randomUUID(), expires: Date.now() + REVIEW_TTL, selection, loaded };
  const [a, b] = [selection.teamA, selection.teamB].map(id => loaded.snapshot.teams.find(team => team.teamRoleId === id && team.active));
  if (!a || !b || a.teamRoleId === b.teamRoleId || a.division !== b.division) {
    review.blocker = 'Choose two different active team roles in the same division. Open a new trade review to change teams.';
    return review;
  }
  const issues = auditLeagueRoster(loaded.snapshot);
  if (issues.length) {
    console.error('Trade preview roster audit failed:', issues);
    review.blocker = humanizeLeagueAuditIssues(loaded.snapshot, issues).slice(0, 3).join(' ');
    return review;
  }
  if (!selection.outboundA.length || !selection.outboundB.length) return review;
  try {
    const plan = await buildVerifiedTransactionIntent({ db, guildId, sheets, selections: groupTradeIntent(selection), loaded });
    await discord.validateGroupTradeRoles(plan, loaded.snapshot);
    review.plan = plan;
  } catch (error) {
    review.blocker = privateError(error, guildId).replace(/\n\nNo changes were made\.$/, '');
    // Show the proposed final rosters even when a Sheet or permission check blocks approval.
    try { review.plan = buildGroupTradePlan(loaded.snapshot, selection); } catch { /* no valid projection */ }
  }
  return review;
}

function install(map: Map<string, TradeReview | { busy: true }>, key: string, review: TradeReview) {
  map.set(key, review);
  setTimeout(() => { if (map.get(key) === review) map.delete(key); }, REVIEW_TTL).unref();
}

export async function openGroupTrade(
  interaction: ChatInputCommandInteraction, db: Database.Database, scope: object,
  teamA: string, teamB: string, reason?: string,
) {
  const guild = interaction.guild!;
  const key = `${guild.id}:${interaction.user.id}`;
  const map = reviewMap(scope);
  if (map.get(key)?.busy) {
    await interaction.editReply('Rat is still checking your open trade review. Check that message first.');
    return;
  }
  // Opening a new review invalidates older controls for the same staff member.
  const opening = { busy: true } as const;
  map.set(key, opening);
  try {
    const ports = services(guild);
    const loaded = await ports.sheets.load(await ports.discord.getMembers(), ports.freeAgentRoleId);
    const review = await buildReview(db, guild.id, loaded, { teamA, teamB, outboundA: [], outboundB: [], ...(reason ? { reason } : {}) }, ports);
    await interaction.editReply(reviewMessage(review));
    install(map, key, review);
  } catch (error) {
    map.delete(key);
    await interaction.editReply(privateError(error, guild.id));
  }
}

export async function handleGroupTradeInteraction(interaction: Interaction, db: Database.Database, scope: object): Promise<boolean> {
  if ((!interaction.isStringSelectMenu() && !interaction.isButton()) || !interaction.customId.startsWith('group-trade:')) return false;
  const guild = interaction.guild;
  const [, action, token] = interaction.customId.split(':');
  const map = reviewMap(scope);
  const key = `${guild?.id}:${interaction.user.id}`;
  const review = map.get(key);
  const reply = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  if (!guild || !review || !('token' in review) || review.token !== token || review.expires <= Date.now()) {
    await reply('This trade review is no longer current or belongs to another staff member. Open a fresh review.');
    return true;
  }
  if (review.busy) { await reply('Rat is already checking this trade. Check the original review message.'); return true; }
  review.busy = true;
  let queued = false;
  try {
    await interaction.deferUpdate();
    const actor = await guild.members.fetch({ user: interaction.user.id, force: true });
    if (!hasAccess(actor, 'OPERATIONS')) throw new LeagueMutationValidationError('You no longer have permission to approve league changes.');
    if (review.reference) {
      await interaction.followUp({ content: `Trade already saved. Reference: ${review.reference}. Check Saved actions for the result.`, flags: MessageFlags.Ephemeral });
    } else if (action === 'cancel' && interaction.isButton()) {
      map.delete(key);
      await interaction.editReply({ content: 'Trade review cancelled. No changes were made.', embeds: [], components: [] });
    } else if (action === 'confirm' && interaction.isButton() && review.plan && !review.blocker) {
      const ports = services(guild);
      const selections = groupTradeIntent(review.selection);
      const fingerprint = leagueTransactionPlanFingerprint(review.plan);
      // Fresh Sheets and targeted role checks at confirmation. Only the worker
      // requests another full guild snapshot, under the canonical mutation lock.
      const loaded = await ports.sheets.load(review.loaded.snapshot.discordMembers, ports.freeAgentRoleId);
      const fresh = await buildVerifiedTransactionIntent({ db, guildId: guild.id, sheets: ports.sheets, selections, loaded });
      if (leagueTransactionPlanFingerprint(fresh) !== fingerprint)
        throw new LeagueMutationValidationError('The trade changed after the preview. Select the players again and review the latest records.');
      await ports.discord.validateGroupTradeRoles(fresh, loaded.snapshot);
      await ports.sheets.assertUnchanged(loaded);
      const currentActor = await guild.members.fetch({ user: interaction.user.id, force: true });
      if (!hasAccess(currentActor, 'OPERATIONS') || review.expires <= Date.now() || map.get(key) !== review)
        throw new LeagueMutationValidationError('Your permission or trade review expired. Open a fresh review.');
      const job = leagueJobWorkerFor(scope, guild.id).enqueue('transaction', {
        selections, actorUserId: interaction.user.id, actorName: currentActor.displayName,
        approvedAt: new Date().toISOString(), expectedPlanFingerprint: fingerprint,
      }, `transaction:${interaction.user.id}:${selections}:${token}`);
      queued = true;
      review.reference = job.reference;
      await interaction.editReply({ content: `${leagueStatusLabel(job.status)}. Reference: ${job.reference}\nUse Saved actions to check this trade. Do not submit it again.`, embeds: [], components: [] });
    } else if ((action === 'a' || action === 'b') && interaction.isStringSelectMenu()) {
      const side = action === 'a' ? 'outboundA' : 'outboundB';
      const role = action === 'a' ? review.selection.teamA : review.selection.teamB;
      const eligible = new Set(review.loaded.snapshot.rosters.filter(row => row.teamRoleId === role).map(row => row.discordId));
      const selected = interaction.values;
      if (selected.length > 3 || new Set(selected).size !== selected.length || selected.some(id => !eligible.has(id)))
        throw new LeagueMutationValidationError('Choose up to three different players from the team shown.');
      const ports = services(guild);
      const loaded = await ports.sheets.load(await ports.discord.getMembers({ observation: true }), ports.freeAgentRoleId);
      const next = await buildReview(db, guild.id, loaded, { ...review.selection, [side]: selected }, ports);
      if (review.expires <= Date.now() || map.get(key) !== review)
        throw new LeagueMutationValidationError('Your permission or trade review expired. Open a fresh review.');
      await interaction.editReply(reviewMessage(next));
      install(map, key, next);
    } else {
      throw new LeagueMutationValidationError('This trade is not ready to confirm. Check both selections and the review.');
    }
  } catch (error) {
    if (queued) throw error;
    const content = privateError(error, guild.id);
    if (interaction.deferred || interaction.replied)
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    else await reply(content);
  } finally { review.busy = false; }
  return true;
}
