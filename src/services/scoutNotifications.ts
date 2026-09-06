import type Database from 'better-sqlite3';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
} from 'discord.js';
import {
  claimScoutNotificationAttempt,
  getScoutCompletion,
  getScoutCoordination,
  getScoutSetupById,
  listAttemptedScoutNotifications,
  listDueScoutNotifications,
  listScoutEvents,
  listScoutGameHosts,
  listScoutRosterSlots,
  markScoutNotificationSent,
  skipScheduledScoutNotification,
  type ScoutNotification,
  type ScoutNotificationPayload,
} from '../db/index.js';
import { SCOUT_ROLE_LABELS } from '../domain/index.js';
import { reportOperationalError } from './operationalErrors.js';

type NotificationResolution =
  | { status: 'deliver'; payload: ScoutNotificationPayload }
  | { status: 'skip'; reason: string };

function rosterUrl(setup: NonNullable<ReturnType<typeof getScoutSetupById>>): string | undefined {
  return setup.resultMessageId
    ? `https://discord.com/channels/${setup.guildId}/${setup.resultsChannelId}/${setup.resultMessageId}`
    : undefined;
}

function rosterLink(setup: NonNullable<ReturnType<typeof getScoutSetupById>>) {
  const url = rosterUrl(setup);
  return url ? [{ label: 'View roster', url }] : [];
}

export function resolveScoutNotification(
  db: Database.Database,
  notification: ScoutNotification,
): NotificationResolution {
  const setup = getScoutSetupById(db, notification.setupId);
  if (!setup) return { status: 'skip', reason: 'missing_setup' };
  if (getScoutCompletion(db, setup.id)) return { status: 'skip', reason: 'finished' };
  if (setup.status === 'cancelled') return { status: 'skip', reason: 'cancelled' };
  if (setup.status !== 'published' || !setup.resultMessageId || !setup.signupPostReconciled) {
    return { status: 'skip', reason: 'unpublished' };
  }
  const slots = listScoutRosterSlots(db, setup.id);
  const hosts = listScoutGameHosts(db, setup.id);
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

  const coordination = getScoutCoordination(db, setup.id);
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
    const event = listScoutEvents(db, setup.id)
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

const setupTails = new WeakMap<Database.Database, Map<number, Promise<void>>>();
async function serializeForSetup(db: Database.Database, setupId: number, work: () => Promise<void>) {
  let tails = setupTails.get(db);
  if (!tails) { tails = new Map(); setupTails.set(db, tails); }
  const previous = tails.get(setupId) ?? Promise.resolve();
  const current = previous.then(work, work);
  tails.set(setupId, current);
  try { await current; } finally { if (tails.get(setupId) === current) tails.delete(setupId); }
}

async function deliverScoutNotification(
  client: Client,
  db: Database.Database,
  notification: ScoutNotification,
  now: number,
): Promise<void> {
  const resolution = resolveScoutNotification(db, notification);
  if (resolution.status === 'skip') {
    skipScheduledScoutNotification(db, notification.id, resolution.reason);
    return;
  }
  if (!claimScoutNotificationAttempt(db, notification.id, now, resolution.payload)) return;
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
    markScoutNotificationSent(db, notification.id, message.id, now);
  } catch (error) {
    const setup = getScoutSetupById(db, notification.setupId);
    await reportOperationalError(client, db, {
      guildId: setup?.guildId ?? 'unknown', setupId: notification.setupId,
      division: setup?.divisionDisplayName, action: 'Scout notification delivery',
      next: 'Delivery is uncertain and will not be retried automatically.',
    }, error);
  }
}

export async function processDueScoutNotifications(
  client: Client,
  db: Database.Database,
  now = Math.floor(Date.now() / 1_000),
  limit = 25,
): Promise<void> {
  const due = listDueScoutNotifications(db, now, limit);
  for (const notification of due) {
    await serializeForSetup(db, notification.setupId,
      () => deliverScoutNotification(client, db, notification, now));
  }
}

export async function reportUncertainScoutNotifications(client: Client, db: Database.Database): Promise<void> {
  for (const notification of listAttemptedScoutNotifications(db)) {
    const setup = getScoutSetupById(db, notification.setupId);
    await reportOperationalError(client, db, {
      guildId: setup?.guildId ?? 'unknown', setupId: notification.setupId,
      division: setup?.divisionDisplayName, action: 'Scout notification recovery',
      next: `Notification ${notification.kind} is delivery-uncertain and was not resent.`,
    }, new Error('A persisted attempted scout notification has no confirmed Discord message ID.'));
  }
}

export async function startScoutNotificationWorker(client: Client, db: Database.Database) {
  await reportUncertainScoutNotifications(client, db);
  await processDueScoutNotifications(client, db);
  const interval = setInterval(() => {
    void processDueScoutNotifications(client, db).catch((error) =>
      reportOperationalError(client, db, { guildId: 'unknown', action: 'Scout notification worker' }, error));
  }, 15_000);
  interval.unref();
  return () => clearInterval(interval);
}
