import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
} from 'discord.js';
import type { ScoutNotification, ScoutNotificationPayload, ScoutSetup } from '../db/types.js';
import { SCOUT_ROLE_LABELS } from '../domain/index.js';
import type { ScoutNotificationDeliveryStore } from '../storage/index.js';
import { tryAcquireDivisionOperation } from './divisionOperation.js';
import type { OperationContext } from './operationalErrors.js';

type NotificationResolution =
  | { status: 'deliver'; payload: ScoutNotificationPayload }
  | { status: 'skip'; reason: string };

export type ScoutNotificationDeliveryDependencies = {
  storage: ScoutNotificationDeliveryStore;
  operationScope: object;
  reportError: (context: OperationContext, error: unknown) => Promise<void>;
};

function rosterUrl(setup: ScoutSetup): string | undefined {
  return setup.resultMessageId
    ? `https://discord.com/channels/${setup.guildId}/${setup.resultsChannelId}/${setup.resultMessageId}`
    : undefined;
}

function rosterLink(setup: ScoutSetup) {
  const url = rosterUrl(setup);
  return url ? [{ label: 'View roster', url }] : [];
}

export async function resolveScoutNotification(
  storage: ScoutNotificationDeliveryStore,
  notification: ScoutNotification,
): Promise<NotificationResolution> {
  const setup = await storage.getSetup(notification.setupId);
  if (!setup) return { status: 'skip', reason: 'missing_setup' };
  if (await storage.hasCompletion(setup.id)) return { status: 'skip', reason: 'finished' };
  if (setup.status === 'cancelled') return { status: 'skip', reason: 'cancelled' };
  if (setup.status !== 'published' || !setup.resultMessageId || !setup.signupPostReconciled) {
    return { status: 'skip', reason: 'unpublished' };
  }
  const [slots, hosts] = await Promise.all([
    storage.listRosterSlots(setup.id),
    storage.listGameHosts(setup.id),
  ]);
  const links = rosterLink(setup);

  if (notification.kind === 't30' || notification.kind === 'manual_roster') {
    if (slots.length !== setup.gameCount * 10 || hosts.length !== setup.gameCount) {
      return { status: 'skip', reason: 'incomplete_current_roster' };
    }
    const rosterIds = [...new Set(slots.map((slot) => slot.userId))];
    const hostLine = setup.gameCount === 1
      ? `**Lobby Host:** <@${hosts[0]!.lobbyHostUserId}>${notification.kind === 't30' ? ', please get everyone rallied and the lobby ready.' : ''}`
      : hosts.map((host) => `**Game ${host.gameNumber} Lobby Host:** <@${host.lobbyHostUserId}>`).join('\n');
    const heading = notification.kind === 't30'
      ? `**${setup.divisionDisplayName} Scout starts in 30 minutes.**`
      : `**Reminder: ${setup.divisionDisplayName} Scout starts at <t:${setup.startAt}:t>.**`;
    return {
      status: 'deliver',
      payload: {
        content: `${rosterIds.map((id) => `<@${id}>`).join(' ')}\n${heading}\n${hostLine}`,
        links,
        allowedUserIds: rosterIds,
      },
    };
  }

  const coordination = await storage.getCoordination(setup.id);
  if (notification.kind === 'host_organizer') {
    const host = hosts.find((candidate) => candidate.gameNumber === notification.gameNumber);
    if (!host || !coordination || notification.channelId !== setup.operationsChannelId) {
      return { status: 'skip', reason: 'invalid_host_escalation' };
    }
    return {
      status: 'deliver',
      payload: {
        content: `<@${coordination.organizerUserId}> · **Organizer needed for the <t:${setup.startAt}:t> ${setup.divisionDisplayName} Scout.**\nRequested by Game ${host.gameNumber} Lobby Host <@${host.lobbyHostUserId}>.`,
        links,
        allowedUserIds: [coordination.organizerUserId],
      },
    };
  }

  if (notification.kind === 'availability_alert') {
    const slotId = Number(notification.dedupeKey.split(':').at(-1));
    const slot = slots.find((candidate) => candidate.id === slotId && candidate.replacementNeeded);
    if (!slot || !coordination || notification.channelId !== setup.operationsChannelId) {
      return { status: 'skip', reason: 'resolved_availability' };
    }
    return {
      status: 'deliver',
      payload: {
        content: `<@${coordination.organizerUserId}> · ⚠️ **Replacement needed · <t:${setup.startAt}:t> ${setup.divisionDisplayName} Scout**\n<@${slot.userId}> can no longer play **${setup.gameCount === 2 ? `Game ${slot.gameNumber} · ` : ''}${slot.team === 'team_one' ? 'Order' : 'Chaos'} · ${SCOUT_ROLE_LABELS[slot.role]}**.`,
        links,
        allowedUserIds: [coordination.organizerUserId],
      },
    };
  }

  if (notification.kind === 'replacement_notice') {
    const version = Number(notification.dedupeKey.split(':').at(-1));
    const event = (await storage.listEvents(setup.id))
      .find((candidate) => candidate.setupVersion === version && candidate.eventType === 'player_replaced');
    const incomingUserId = event?.payload.incomingUserId;
    const outgoingUserId = event?.payload.outgoingUserId;
    const gameNumber = event?.payload.gameNumber;
    const team = event?.payload.team;
    const role = event?.payload.role;
    if (typeof incomingUserId !== 'string' || typeof outgoingUserId !== 'string' ||
        typeof gameNumber !== 'number' || (team !== 'team_one' && team !== 'team_two') ||
        typeof role !== 'string') return { status: 'skip', reason: 'missing_replacement_context' };
    return {
      status: 'deliver',
      payload: {
        content: `**<@${incomingUserId}>, you're in for the <t:${setup.startAt}:t> ${setup.divisionDisplayName} Scout.**\n${setup.gameCount === 2 ? `Game ${gameNumber} · ` : ''}${team === 'team_one' ? 'Order' : 'Chaos'} · ${SCOUT_ROLE_LABELS[role as keyof typeof SCOUT_ROLE_LABELS]} · replacing <@${outgoingUserId}>`,
        links,
        allowedUserIds: [incomingUserId],
      },
    };
  }

  if (notification.kind === 'host_change') {
    const host = hosts.find((candidate) => candidate.gameNumber === notification.gameNumber);
    if (!host) return { status: 'skip', reason: 'missing_host' };
    return {
      status: 'deliver',
      payload: {
        content: `**${setup.gameCount === 2 ? `Game ${host.gameNumber} ` : ''}Lobby Host updated:** <@${host.lobbyHostUserId}>`,
        links,
        allowedUserIds: [host.lobbyHostUserId],
      },
    };
  }
  return { status: 'skip', reason: 'unsupported_kind' };
}

const setupTails = new WeakMap<object, Map<number, Promise<void>>>();
async function serializeForSetup(scope: object, setupId: number, work: () => Promise<void>) {
  let tails = setupTails.get(scope);
  if (!tails) { tails = new Map(); setupTails.set(scope, tails); }
  const previous = tails.get(setupId) ?? Promise.resolve();
  const current = previous.then(work, work);
  tails.set(setupId, current);
  try { await current; } finally { if (tails.get(setupId) === current) tails.delete(setupId); }
}

async function deliverScoutNotification(
  client: Client,
  dependencies: ScoutNotificationDeliveryDependencies,
  notification: ScoutNotification,
  now: number,
): Promise<void> {
  const resolution = await resolveScoutNotification(dependencies.storage, notification);
  if (resolution.status === 'skip') {
    await dependencies.storage.skip(notification.id, resolution.reason);
    return;
  }
  if (!await dependencies.storage.claimAttempt(notification.id, now, resolution.payload)) return;
  try {
    const channel = await client.channels.fetch(notification.channelId);
    if (!channel?.isSendable()) throw new Error('Scout notification channel is unavailable or not sendable.');
    const components = resolution.payload.links.length
      ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...resolution.payload.links.map((link) =>
        new ButtonBuilder().setLabel(link.label).setStyle(ButtonStyle.Link).setURL(link.url)))]
      : [];
    const message = await channel.send({
      content: resolution.payload.content,
      components,
      allowedMentions: { parse: [], users: resolution.payload.allowedUserIds, roles: [] },
    });
    await dependencies.storage.markSent(notification.id, message.id, now);
  } catch (error) {
    const setup = await dependencies.storage.getSetup(notification.setupId);
    await dependencies.reportError({
      guildId: setup?.guildId ?? 'unknown', setupId: notification.setupId,
      division: setup?.divisionDisplayName, action: 'Scout notification delivery',
      next: 'Delivery is uncertain and will not be retried automatically.',
    }, error);
  }
}

export async function processDueScoutNotifications(
  client: Client,
  dependencies: ScoutNotificationDeliveryDependencies,
  now = Math.floor(Date.now() / 1_000),
  limit = 25,
): Promise<void> {
  const due = await dependencies.storage.listDueNotifications(now, limit);
  for (const notification of due) {
    await serializeForSetup(dependencies.operationScope, notification.setupId, async () => {
      const setup = await dependencies.storage.getSetup(notification.setupId);
      if (!setup) {
        await deliverScoutNotification(client, dependencies, notification, now);
        return;
      }
      const release = tryAcquireDivisionOperation(dependencies.operationScope, setup.guildId, setup.divisionKey);
      if (!release) return;
      try { await deliverScoutNotification(client, dependencies, notification, now); }
      finally { release(); }
    });
  }
}

export async function reportUncertainScoutNotifications(
  dependencies: ScoutNotificationDeliveryDependencies,
): Promise<void> {
  for (const notification of await dependencies.storage.listAttemptedNotifications()) {
    const setup = await dependencies.storage.getSetup(notification.setupId);
    await dependencies.reportError({
      guildId: setup?.guildId ?? 'unknown', setupId: notification.setupId,
      division: setup?.divisionDisplayName, action: 'Scout notification recovery',
      next: `Notification ${notification.kind} is delivery-uncertain and was not resent.`,
    }, new Error('A persisted attempted scout notification has no confirmed Discord message ID.'));
  }
}

export async function startScoutNotificationWorker(
  client: Client,
  dependencies: ScoutNotificationDeliveryDependencies,
) {
  await reportUncertainScoutNotifications(dependencies);
  await processDueScoutNotifications(client, dependencies);
  const interval = setInterval(() => {
    void processDueScoutNotifications(client, dependencies).catch((error) =>
      dependencies.reportError({ guildId: 'unknown', action: 'Scout notification worker' }, error));
  }, 15_000);
  interval.unref();
  return () => clearInterval(interval);
}
