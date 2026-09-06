import assert from 'node:assert/strict';
import test from 'node:test';
import { Collection, type ButtonInteraction, type Client } from 'discord.js';
import { closeDatabase, openDatabase } from '../db/client.js';
import { upsertDivision } from '../db/repositories/divisions.js';
import {
  createScoutSetup,
  getScoutSetupById,
  listScoutRosterSlots,
  prepareScoutPublication,
  reconcileScoutWorkingRoster,
  setScoutResultMessage,
  setScoutSetupSignupMessage,
} from '../db/repositories/scoutSetups.js';
import { listScoutGameHosts } from '../db/repositories/scoutGameHosts.js';
import { SCOUT_ROLES, SCOUT_TEAMS } from '../domain/index.js';
import { handleScoutAvailabilityButton } from './scoutAvailability.js';
import { handleScoutCoordinationButton } from './scoutCoordination.js';

function fixture() {
  const db = openDatabase(':memory:');
  const division = upsertDivision(db, {
    guildId: 'guild', divisionKey: 'alfheim', displayName: 'Alfheim', roleId: 'division-role',
    managerRoleId: 'manager-role', captainRoleId: 'captain-role', categoryId: 'category',
  });
  const setup = createScoutSetup(db, {
    guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
    divisionDisplayName: division.displayName, createdBy: 'organizer', signupChannelId: 'signups',
    resultsChannelId: 'results', operationsChannelId: 'ops', divisionRoleId: 'division-role',
    emojiByRole: { solo: 's', jungle: 'j', mid: 'm', support: 'p', carry: 'c', fill: 'f' },
    startAt: 2_000_000_000, roleLimit: 4,
  });
  setScoutSetupSignupMessage(db, setup.id, 'signup');
  db.prepare('UPDATE scout_setups SET game_count = 2 WHERE id = ?').run(setup.id);
  const slots = [1, 2].flatMap((gameNumber) => SCOUT_ROLES.flatMap((role) =>
    SCOUT_TEAMS.map((team, index) => ({ gameNumber, team, role, userId: `g${gameNumber}-${role}-${index}` }))));
  const insert = db.prepare('INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, ?, ?)');
  for (const slot of slots) insert.run(setup.id, slot.userId, slot.role);
  assert.equal(reconcileScoutWorkingRoster(db, {
    setupId: setup.id, expectedVersion: 0, slots, source: 'signup',
  }), 'updated');
  assert.equal(prepareScoutPublication(db, {
    setupId: setup.id, expectedVersion: 1, now: 1_000, random: () => 0,
  }).status, 'claimed');
  assert.equal(setScoutResultMessage(db, setup.id, 'roster'), true);

  const resultMessages = new Collection<string, any>();
  const roster: any = {
    id: 'roster', content: '', components: [], author: { id: 'bot' },
    edit: async (payload: any) => {
      roster.content = payload.content;
      roster.components = payload.components;
      return roster;
    },
  };
  resultMessages.set(roster.id, roster);
  const opsMessages = new Collection<string, any>();
  const channel = (id: string) => ({
    id, guildId: 'guild', isTextBased: () => true, isSendable: () => true,
    messages: { fetch: async (query: any) => {
      const messages = id === 'ops' ? opsMessages : resultMessages;
      return typeof query === 'string' ? messages.get(query) : messages;
    } },
    send: async (payload: any) => {
      const message: any = {
        id: `${id}-${opsMessages.size + 1}`, author: { id: 'bot' }, content: payload.content,
        components: payload.components,
        edit: async (next: any) => { message.content = next.content; message.components = next.components; return message; },
      };
      (id === 'ops' ? opsMessages : resultMessages).set(message.id, message);
      return message;
    },
  });
  const guild: any = { id: 'guild' };
  const client = {
    user: { id: 'bot' },
    channels: { fetch: async (id: string) => channel(id) },
  } as unknown as Client;
  const replies: any[] = [];
  const interaction = (customId: string, userId: string, messageId = 'roster') => ({
    customId, client, guild, guildId: 'guild', channelId: 'signups', user: { id: userId },
    message: { id: messageId },
    deferReply: async () => undefined,
    deferUpdate: async () => undefined,
    editReply: async (payload: any) => { replies.push(payload); },
  } as unknown as ButtonInteraction);
  return { db, setupId: setup.id, roster, replies, interaction };
}

function notificationCount(db: ReturnType<typeof openDatabase>, kind: string) {
  return (db.prepare('SELECT COUNT(*) AS count FROM scout_notifications WHERE kind = ?')
    .get(kind) as { count: number }).count;
}

test("Can't play is bound to the canonical message and actor, remains idempotent, and tracks multiple seats", async () => {
  const f = fixture();
  try {
    const initial = getScoutSetupById(f.db, f.setupId)!;
    const available = listScoutRosterSlots(f.db, f.setupId)
      .filter((slot) => !listScoutGameHosts(f.db, f.setupId).some((host) => host.lobbyHostUserId === slot.userId));
    const first = available.find((slot) => slot.gameNumber === 1)!;
    const second = available.find((slot) => slot.gameNumber === 2)!;

    await handleScoutAvailabilityButton(
      f.interaction(`scout:cantplay:${f.setupId}:${initial.version}`, first.userId, 'copied-control'), f.db,
    );
    assert.equal(listScoutRosterSlots(f.db, f.setupId).some((slot) => slot.replacementNeeded), false);
    await handleScoutAvailabilityButton(
      f.interaction(`scout:cantplay:${f.setupId}:${initial.version}`, 'not-rostered'), f.db,
    );
    assert.equal(listScoutRosterSlots(f.db, f.setupId).some((slot) => slot.replacementNeeded), false);

    await handleScoutAvailabilityButton(
      f.interaction(`scout:cantplay:${f.setupId}:${initial.version}`, first.userId), f.db,
    );
    const firstConfirm = f.replies.at(-1).components[0].toJSON().components[0].custom_id;
    await handleScoutAvailabilityButton(f.interaction(firstConfirm, first.userId), f.db);
    assert.match(f.roster.content, /replacement needed/);
    assert.equal(listScoutRosterSlots(f.db, f.setupId).filter((slot) => slot.replacementNeeded).length, 1);
    assert.equal(notificationCount(f.db, 'availability_alert'), 1);

    const afterFirst = getScoutSetupById(f.db, f.setupId)!;
    await handleScoutAvailabilityButton(
      f.interaction(`scout:cantplay:${f.setupId}:${afterFirst.version}`, first.userId), f.db,
    );
    const repeatConfirm = f.replies.at(-1).components[0].toJSON().components[0].custom_id;
    await handleScoutAvailabilityButton(f.interaction(repeatConfirm, first.userId), f.db);
    assert.equal(notificationCount(f.db, 'availability_alert'), 1);

    await handleScoutAvailabilityButton(
      f.interaction(`scout:cantplay:${f.setupId}:${afterFirst.version}`, second.userId), f.db,
    );
    const secondConfirm = f.replies.at(-1).components[0].toJSON().components[0].custom_id;
    await handleScoutAvailabilityButton(f.interaction(secondConfirm, second.userId), f.db);
    assert.equal(listScoutRosterSlots(f.db, f.setupId).filter((slot) => slot.replacementNeeded).length, 2);
  } finally {
    closeDatabase(f.db);
  }
});

test("Ping organizer is limited to the current Host's encoded game and uses a per-game cooldown", async () => {
  const f = fixture();
  try {
    const setup = getScoutSetupById(f.db, f.setupId)!;
    const hosts = listScoutGameHosts(f.db, f.setupId);
    const gameOneHost = hosts.find((host) => host.gameNumber === 1)!;
    await handleScoutCoordinationButton(
      f.interaction(`scout:pingorganizer:${f.setupId}:${setup.version}:2`, gameOneHost.lobbyHostUserId), f.db,
    );
    assert.equal(notificationCount(f.db, 'host_organizer'), 0);
    await handleScoutCoordinationButton(
      f.interaction(`scout:pingorganizer:${f.setupId}:${setup.version}:1`, gameOneHost.lobbyHostUserId), f.db,
    );
    await handleScoutCoordinationButton(
      f.interaction(`scout:pingorganizer:${f.setupId}:${setup.version}:1`, gameOneHost.lobbyHostUserId), f.db,
    );
    assert.equal(notificationCount(f.db, 'host_organizer'), 1);
    assert.match(f.replies.at(-1).content, /recently/);
  } finally {
    closeDatabase(f.db);
  }
});
