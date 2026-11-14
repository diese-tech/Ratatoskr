import { buildFlowCatalog, createUiRuntime, decodeActionId, isActionId, type PolicyRequest } from 'fluxcord';
import { createUiBridge } from 'fluxcord/discord';
import { MessageFlags, type ButtonInteraction, type ChatInputCommandInteraction, type Client, type Guild,
  type Interaction, type InteractionEditReplyOptions, type InteractionReplyOptions } from 'discord.js';
import type Database from 'better-sqlite3';
import { getLeagueAuditState } from '../db/repositories/leagueAudits.js';
import { hasAccess } from './authorization.js';
import type { LeagueAccountReplacementService } from './leagueAccountReplacement.js';
import type { LeagueJobWorker } from './leagueJobWorker.js';
import type { LeagueSheetsService } from './leagueSheets.js';
import type { DiscordLeagueGateway } from './leagueDiscord.js';
import { LeagueMutationValidationError, isOneWayTrade } from '../domain/leagueOperations.js';
import { validateOneWayTradePreview } from './leagueTransactions.js';
import { buildVerifiedTransactionIntent } from './leagueReinstatement.js';
import { LeagueOpsReviewService } from './leagueOpsReview.js';
import { createLeagueOpsFlow } from './leagueOpsFlow.js';
import { previewLeagueAuditResolution } from './leagueAuditResolution.js';

type Host = { open(interaction: ButtonInteraction): Promise<void>; dispatch(interaction: Interaction): Promise<void>; stop(): void };
const hosts = new WeakMap<object, Map<string, Host>>();
export async function authorizeLeagueOpsUi(request: Pick<PolicyRequest, 'actorId' | 'ownerId' | 'guildId'>,
  guildId: string, authorize: (actor: string) => Promise<unknown>): Promise<boolean> {
  if (request.guildId !== guildId || request.ownerId !== request.actorId) return false;
  try { await authorize(request.actorId); return true; } catch { return false; }
}
// The shipped bridge only types command senders, but its transport needs these
// three methods. Adapt the already-deferred status-card button without a second
// reply or any channel-send path; all mounts remain ephemeral webhook messages.
export function deferredLeagueOpsSender(interaction: ButtonInteraction): ChatInputCommandInteraction {
  return {
    createdTimestamp: interaction.createdTimestamp,
    editReply: (options: InteractionEditReplyOptions) => interaction.editReply({ ...options, allowedMentions: { parse: [] } }),
    reply: async (options: InteractionReplyOptions) => {
      const { withResponse: _withResponse, ...payload } = options;
      const flags = MessageFlags.IsComponentsV2;
      return { resource: { message: await interaction.editReply({ ...payload, flags, allowedMentions: { parse: [] } } as InteractionEditReplyOptions) } };
    },
  } as unknown as ChatInputCommandInteraction;
}
export function registerLeagueOpsUi(input: { scope: object; db: Database.Database; client: Client; guild: Guild;
  worker: LeagueJobWorker; replacement: LeagueAccountReplacementService; sheets: Pick<LeagueSheetsService, 'load'> & Partial<Pick<LeagueSheetsService, 'readTransactionHistory' | 'prepare' | 'assertOneWayTradeDestination'>>;
  discord: Pick<DiscordLeagueGateway, 'getMembers'> & Partial<Pick<DiscordLeagueGateway, 'validateOneWayTradeRoles' | 'validateDisplayName'>>; freeAgentRoleId: string }): () => void {
  const authorize = async (actor: string) => {
    const member = await input.guild.members.fetch({ user: actor, force: true });
    if (!hasAccess(member, 'OPERATIONS')) throw Error('League administrator access is required.');
    return member.displayName;
  };
  const service = new LeagueOpsReviewService({ ...input, guildId: input.guild.id, authorize,
    readTransactionHistory: input.sheets.readTransactionHistory?.bind(input.sheets),
    roleLabel: id => `${input.guild.roles.cache.get(id)?.name ?? 'Unknown team role'} (${id})`,
    previewTransaction: async (selections, absentPlayerId) => {
      const loaded = await input.sheets.load(await input.discord.getMembers(), input.freeAgentRoleId);
      if (absentPlayerId && loaded.snapshot.discordMembers.some(member => member.discordId === absentPlayerId))
        throw new LeagueMutationValidationError('This player has rejoined. Review their current roster state before choosing an exit.');
      const plan = await buildVerifiedTransactionIntent({ db: input.db, guildId: input.guild.id, sheets: input.sheets, selections, loaded });
      if (isOneWayTrade(plan)) {
        if (!input.sheets.prepare || !input.discord.validateDisplayName)
          throw new Error('One-way trade preview checks are unavailable.');
        await validateOneWayTradePreview(loaded, plan, {
          prepare: input.sheets.prepare.bind(input.sheets),
          assertOneWayTradeDestination: input.sheets.assertOneWayTradeDestination?.bind(input.sheets),
        }, {
          validateDisplayName: input.discord.validateDisplayName.bind(input.discord),
          validateOneWayTradeRoles: input.discord.validateOneWayTradeRoles?.bind(input.discord),
        });
      }
      return plan;
    },
    previewRepair: async (finding, action) => previewLeagueAuditResolution(
      await input.sheets.load(await input.discord.getMembers(), input.freeAgentRoleId), finding, action) });
  const sessions = new Map<string, { actor: string; messageId: string }>();
  const panel = createLeagueOpsFlow(service, id => sessions.delete(id));
  const bridge = createUiBridge(input.client);
  const runtime = createUiRuntime({ platform: bridge.platform, sendToChannel: async () => { throw Error('League Ops panels must stay private.'); },
    flows: buildFlowCatalog([{ module: 'league-ops', flow: panel }]),
    policy: { authorize: async request => ({ allowed: await authorizeLeagueOpsUi(request, input.guild.id, authorize),
      denyMessage: 'Only the staff member who opened this view can use it, and they must still have league staff access.' }) },
    onError: async () => { await bridge.platform.replyToActor('Rat could not finish this review. Use the main button on the latest League Status message and start again. If you confirmed a change, inspect Saved actions before requesting any new approval.'); } });
  const host: Host = {
    open: async interaction => {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        await authorize(interaction.user.id);
        const state = getLeagueAuditState(input.db, input.guild.id);
        if (!state?.currentMessageId || interaction.message.id !== state.currentMessageId) {
          await interaction.editReply('This message was replaced. Use the main button on the latest League Status message.');
          return;
        }
        const snapshot = await service.snapshot(interaction.user.id);
        const handle = await runtime.mount(panel, { ownerId: interaction.user.id,
          to: { reply: bridge.replySender(deferredLeagueOpsSender(interaction), { ephemeral: true }) } });
        sessions.set(handle.sessionId, { actor: interaction.user.id, messageId: handle.messageId });
        await handle.redraw(data => { data.snapshot = snapshot; });
      } catch {
        await interaction.editReply('League tools are unavailable, or your staff access changed. Reopen the private tools from the latest League Status message. If it is still unavailable, ask an admin to check the bot.');
      }
    },
    dispatch: async interaction => {
      if (!interaction.isMessageComponent() && !interaction.isModalSubmit()) return;
      let address;
      try { address = decodeActionId(interaction.customId.split('~')[0]!); }
      catch { await interaction.reply({ content: 'These controls are out of date. Use the main button on the latest League Status message.', flags: MessageFlags.Ephemeral }); return; }
      const session = sessions.get(address.sessionId);
      if (!session || session.actor !== interaction.user.id || interaction.guildId !== input.guild.id
        || interaction.message?.id !== session.messageId) {
        await interaction.reply({ content: 'This view expired or belongs to another staff member. Use the main button on the latest League Status message to open your own view.', flags: MessageFlags.Ephemeral });
        return;
      }
      await bridge.dispatch(interaction, runtime.dispatch);
    },
    stop: () => { runtime.stopSweeper(); sessions.clear(); },
  };
  let guilds = hosts.get(input.scope);
  if (!guilds) { guilds = new Map(); hosts.set(input.scope, guilds); }
  guilds.get(input.guild.id)?.stop();
  guilds.set(input.guild.id, host);
  return () => { host.stop(); guilds!.delete(input.guild.id); };
}
export async function handleLeagueOpsUi(interaction: Interaction, scope: object): Promise<boolean> {
  const entry = interaction.isButton() && interaction.customId.startsWith('league-ops:open:');
  const control = (interaction.isMessageComponent() || interaction.isModalSubmit()) && isActionId(interaction.customId);
  if (!entry && !control) return false;
  const host = interaction.guildId ? hosts.get(scope)?.get(interaction.guildId) : undefined;
  if (!host) {
    if (interaction.isRepliable()) await interaction.reply({ content: 'Rat is starting up or these controls expired. Use the main button on the latest League Status message. Opening these tools makes no roster changes.', flags: MessageFlags.Ephemeral });
    return true;
  }
  if (entry && interaction.isButton()) await host.open(interaction);
  else await host.dispatch(interaction);
  return true;
}
