import type { Client, Message } from 'discord.js';
import type Database from 'better-sqlite3';
import {
  getScoutSetupById,
  listRosterReadyScoutSetups,
  listTerminalScoutSetupsWithControlPanels,
  replaceScoutControlMessage,
  setScoutControlMessage,
  type ScoutSetup,
} from '../db/index.js';
import { scoutReviewButtonRow } from './scoutReview.js';

export function scoutControlPanelMarker(setupId: number): string {
  return `SCOUT-CONTROL-${setupId}`;
}

export function renderScoutControlPanelPrompt(setup: ScoutSetup, notifyCreator = true) {
  return {
    content: [
      `<@${setup.createdBy}>`,
      `**${setup.divisionDisplayName} roster ready — setup #${setup.id}**`,
      `Start: <t:${setup.startAt}:F>`,
      'Review and balance the roster here, then publish it to the division results channel.',
      `\`${scoutControlPanelMarker(setup.id)}\``,
    ].join('\n'),
    components: [scoutReviewButtonRow(setup.id)],
    allowedMentions: { parse: [] as never[], users: notifyCreator ? [setup.createdBy] : [], roles: [] as string[] },
  };
}

async function findRecoverableControlMessage(
  channel: { messages: { fetch(options: { limit: number; before?: string }): Promise<{
    size: number;
    find(predicate: (message: Message) => boolean): Message | undefined;
    last(): Message | undefined;
  }> } },
  botUserId: string | undefined,
  setupId: number,
): Promise<Message | undefined> {
  if (!botUserId) return undefined;
  const marker = scoutControlPanelMarker(setupId);
  let before: string | undefined;
  while (true) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const found = page.find((message) => message.author.id === botUserId && message.content.includes(marker));
    if (found || page.size < 100) return found;
    before = page.last()?.id;
    if (!before) return undefined;
  }
}

export async function ensureScoutControlPanel(
  client: Client,
  db: Database.Database,
  setupId: number,
): Promise<'created' | 'recovered' | 'existing' | 'not_ready'> {
  const setup = getScoutSetupById(db, setupId);
  if (!setup || setup.status !== 'roster_ready' || !setup.operationsChannelId) return 'not_ready';

  const channel = await client.channels.fetch(setup.operationsChannelId);
  if (!channel?.isTextBased() || !channel.isSendable()) {
    throw new Error(`Scout setup #${setup.id} has no sendable operations channel.`);
  }

  if (setup.controlMessageId) {
    const existing = await channel.messages.fetch(setup.controlMessageId).catch(() => undefined);
    if (existing) return 'existing';
  }

  const persistMessage = (messageId: string) => setup.controlMessageId
    ? replaceScoutControlMessage(db, setup.id, setup.controlMessageId, messageId)
    : setScoutControlMessage(db, setup.id, messageId);

  const recovered = await findRecoverableControlMessage(channel, client.user?.id, setup.id);
  if (recovered && persistMessage(recovered.id)) return 'recovered';

  const sent = await channel.send(renderScoutControlPanelPrompt(setup, !setup.controlMessageId));
  if (persistMessage(sent.id)) return 'created';

  await sent.delete().catch(() => undefined);
  return 'existing';
}

export async function reconcileScoutControlPanels(client: Client, db: Database.Database): Promise<void> {
  for (const setup of listRosterReadyScoutSetups(db)) {
    try {
      await ensureScoutControlPanel(client, db, setup.id);
    } catch (error) {
      console.error(`Scout control panel reconciliation failed for setup #${setup.id}`, error);
    }
  }
  for (const setup of listTerminalScoutSetupsWithControlPanels(db)) {
    const content = setup.status === 'cancelled'
      ? `🚫 **${setup.divisionDisplayName} scout setup #${setup.id} cancelled**`
      : setup.resultMessageId
        ? `✅ **${setup.divisionDisplayName} scout setup #${setup.id} published**\nhttps://discord.com/channels/${setup.guildId}/${setup.resultsChannelId}/${setup.resultMessageId}`
        : undefined;
    if (!content) continue;
    const updated = await updateScoutControlPanel(client, setup, content);
    if (!updated) console.error(`Scout terminal control panel reconciliation failed for setup #${setup.id}`);
  }
}

export async function updateScoutControlPanel(
  client: Client,
  setup: Pick<ScoutSetup, 'operationsChannelId' | 'controlMessageId'>,
  content: string,
): Promise<boolean> {
  if (!setup.operationsChannelId || !setup.controlMessageId) return false;
  const channel = await client.channels.fetch(setup.operationsChannelId).catch(() => undefined);
  if (!channel?.isTextBased()) return false;
  const message = await channel.messages.fetch(setup.controlMessageId).catch(() => undefined);
  if (!message) return false;
  return message.edit({ content, components: [], allowedMentions: { parse: [] } }).then(() => true, () => false);
}
