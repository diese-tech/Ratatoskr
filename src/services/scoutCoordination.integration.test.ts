import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Collection,
  type ButtonInteraction,
  type Client,
  type StringSelectMenuInteraction,
  type UserSelectMenuInteraction,
} from 'discord.js';
import { closeDatabase, openDatabase } from '../db/client.js';
import { setDivisionStatus, upsertDivision } from '../db/repositories/divisions.js';
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
import { getScoutCoordination } from '../db/repositories/scoutCoordination.js';
import { finishScoutSetupIfVersion } from '../db/repositories/scoutCompletions.js';
import { SCOUT_ROLES, SCOUT_TEAMS } from '../domain/index.js';
import { handleScoutAvailabilityButton } from './scoutAvailability.js';
import {
  handleScoutCoordinationButton,
  handleScoutCoordinationStringSelect,
  handleScoutCoordinationUserSelect,
} from './scoutCoordination.js';

process.env.ROLE_ALLFATHER_ID = 'admin';
process.env.ROLE_AESIR_ID = 'aesir';

function fixture(gameCount = 2) {
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
  db.prepare('UPDATE scout_setups SET game_count = ? WHERE id = ?').run(gameCount, setup.id);
  const slots = Array.from({ length: gameCount }, (_, index) => index + 1).flatMap((gameNumber) => SCOUT_ROLES.flatMap((role) =>
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
  const guild: any = { id: 'guild', roles: { cache: new Collection() } };
  const members = new Collection<string, any>();
  const addMember = (userId: string, roles: string[] = [], bot = false) => {
    const member = {
      id: userId,
      guild,
      displayName: `Player ${userId}`,
      user: { id: userId, bot, username: userId },
      roles: { cache: new Collection(roles.map((roleId) => [roleId, { id: roleId }])) },
    };
    members.set(userId, member);
    return member;
  };
  for (const slot of slots) addMember(slot.userId, ['division-role']);
  addMember('manager', ['manager-role']);
  addMember('organizer');
  guild.members = { fetch: async (userId: string) => {
    const member = members.get(userId);
    if (!member) throw new Error('Unknown member');
    return member;
  } };
  const client = {
    user: { id: 'bot' },
    channels: { fetch: async (id: string) => channel(id) },
  } as unknown as Client;
  const replies: any[] = [];
  const interaction = (customId: string, userId: string, messageId = 'roster', values: string[] = []) => ({
    customId, client, guild, guildId: 'guild', channelId: 'signups', user: { id: userId },
    message: { id: messageId }, values,
    users: new Collection(values.flatMap((value) => {
      const member = members.get(value);
      return member ? [[value, member.user] as const] : [];
    })),
    deferReply: async () => undefined,
    deferUpdate: async () => undefined,
    editReply: async (payload: any) => { replies.push(payload); },
  } as unknown as ButtonInteraction);
  return { db, setupId: setup.id, roster, replies, interaction, addMember, members };
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
    const confirmationMessageId = 'ephemeral-confirm';
    assert.notEqual(confirmationMessageId, initial.resultMessageId);
    await handleScoutAvailabilityButton(f.interaction(firstConfirm, first.userId, confirmationMessageId), f.db);
    assert.match(f.roster.content, /replacement needed/);
    assert.equal(listScoutRosterSlots(f.db, f.setupId).filter((slot) => slot.replacementNeeded).length, 1);
    assert.equal(notificationCount(f.db, 'availability_alert'), 1);
    const afterFirst = getScoutSetupById(f.db, f.setupId)!;
    assert.match(JSON.stringify(f.roster.components), new RegExp(`scout:cantplay:${f.setupId}:${afterFirst.version}`));

    await handleScoutAvailabilityButton(f.interaction(firstConfirm, first.userId, confirmationMessageId), f.db);
    assert.match(f.replies.at(-1).content, /already marked/);
    assert.equal(listScoutRosterSlots(f.db, f.setupId).filter((slot) => slot.replacementNeeded).length, 1);
    assert.equal(notificationCount(f.db, 'availability_alert'), 1);

    await handleScoutAvailabilityButton(
      f.interaction(`scout:cantplay:${f.setupId}:${afterFirst.version}`, first.userId), f.db,
    );
    const repeatConfirm = f.replies.at(-1).components[0].toJSON().components[0].custom_id;
    await handleScoutAvailabilityButton(f.interaction(repeatConfirm, first.userId, 'ephemeral-repeat'), f.db);
    assert.equal(notificationCount(f.db, 'availability_alert'), 1);

    await handleScoutAvailabilityButton(
      f.interaction(`scout:cantplay:${f.setupId}:${afterFirst.version}`, second.userId), f.db,
    );
    const secondConfirm = f.replies.at(-1).components[0].toJSON().components[0].custom_id;
    await handleScoutAvailabilityButton(f.interaction(secondConfirm, second.userId, 'ephemeral-second'), f.db);
    assert.equal(listScoutRosterSlots(f.db, f.setupId).filter((slot) => slot.replacementNeeded).length, 2);
  } finally {
    closeDatabase(f.db);
  }
});

test("Can't play rejects an ephemeral confirmation after another canonical availability change", async () => {
  const f = fixture();
  try {
    const initial = getScoutSetupById(f.db, f.setupId)!;
    const hosts = new Set(listScoutGameHosts(f.db, f.setupId).map((host) => host.lobbyHostUserId));
    const [first, second] = listScoutRosterSlots(f.db, f.setupId)
      .filter((slot) => !hosts.has(slot.userId));

    await handleScoutAvailabilityButton(
      f.interaction(`scout:cantplay:${f.setupId}:${initial.version}`, first!.userId), f.db,
    );
    const firstConfirm = f.replies.at(-1).components[0].toJSON().components[0].custom_id;
    await handleScoutAvailabilityButton(
      f.interaction(`scout:cantplay:${f.setupId}:${initial.version}`, second!.userId), f.db,
    );
    const staleConfirm = f.replies.at(-1).components[0].toJSON().components[0].custom_id;

    await handleScoutAvailabilityButton(f.interaction(firstConfirm, first!.userId, 'ephemeral-first'), f.db);
    assert.equal(getScoutSetupById(f.db, f.setupId)!.version, initial.version + 1);
    await handleScoutAvailabilityButton(f.interaction(staleConfirm, second!.userId, 'ephemeral-stale'), f.db);

    assert.match(f.replies.at(-1).content, /roster changed/);
    assert.equal(listScoutRosterSlots(f.db, f.setupId).filter((slot) => slot.replacementNeeded).length, 1);
    assert.equal(notificationCount(f.db, 'availability_alert'), 1);
  } finally {
    closeDatabase(f.db);
  }
});

test("Can't play Never mind works from the ephemeral confirmation without changing the roster", async () => {
  const f = fixture();
  try {
    const setup = getScoutSetupById(f.db, f.setupId)!;
    const player = listScoutRosterSlots(f.db, f.setupId)[0]!;
    await handleScoutAvailabilityButton(
      f.interaction(`scout:cantplay:${f.setupId}:${setup.version}`, player.userId), f.db,
    );
    const back = f.replies.at(-1).components[0].toJSON().components[1].custom_id;
    await handleScoutAvailabilityButton(f.interaction(back, player.userId, 'ephemeral-back'), f.db);

    assert.match(f.replies.at(-1).content, /not changed/);
    assert.equal(getScoutSetupById(f.db, f.setupId)!.version, setup.version);
    assert.equal(listScoutRosterSlots(f.db, f.setupId).some((slot) => slot.replacementNeeded), false);
    assert.equal(notificationCount(f.db, 'availability_alert'), 0);
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
      f.interaction(`scout:pingorganizer:${f.setupId}:${setup.version}:1`, gameOneHost.lobbyHostUserId, 'copied-control'), f.db,
    );
    await handleScoutCoordinationButton(
      f.interaction(`scout:pingorganizer:${f.setupId}:${setup.version - 1}:1`, gameOneHost.lobbyHostUserId), f.db,
    );
    await handleScoutCoordinationButton(
      f.interaction(`scout:pingorganizer:${f.setupId}:${setup.version}:1`, 'manager'), f.db,
    );
    assert.equal(notificationCount(f.db, 'host_organizer'), 0);
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

test('Ping roster requires canonical entry and keeps private confirm, back, and replay safe', async () => {
  const f = fixture();
  try {
    const setup = getScoutSetupById(f.db, f.setupId)!;
    const id = `scout:pingroster:${f.setupId}:${setup.version}`;
    await handleScoutCoordinationButton(f.interaction(id, 'manager', 'copied-control'), f.db);
    assert.match(f.replies.at(-1).content, /not authorized|stale/);
    assert.equal(notificationCount(f.db, 'manual_roster'), 0);

    await handleScoutCoordinationButton(f.interaction(id, 'manager'), f.db);
    const controls = f.replies.at(-1).components[0].toJSON().components;
    const confirm = controls.find((component: any) => component.label === 'Ping roster').custom_id;
    const back = controls.find((component: any) => component.label === 'Cancel').custom_id;
    await handleScoutCoordinationButton(f.interaction(back, 'manager', 'ephemeral-ping-back'), f.db);
    assert.match(f.replies.at(-1).content, /cancelled/);
    assert.equal(notificationCount(f.db, 'manual_roster'), 0);

    await handleScoutCoordinationButton(f.interaction(confirm, 'manager', 'ephemeral-ping-confirm'), f.db);
    assert.match(f.replies.at(-1).content, /queued/);
    await handleScoutCoordinationButton(f.interaction(confirm, 'manager', 'ephemeral-ping-confirm'), f.db);
    assert.match(f.replies.at(-1).content, /recently/);
    assert.equal(notificationCount(f.db, 'manual_roster'), 1);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM scout_events WHERE setup_id = ? AND event_type = 'manual_roster_ping_scheduled'")
      .get(f.setupId) as { count: number }).count, 1);
  } finally {
    closeDatabase(f.db);
  }
});

test('Ping roster confirmation fails closed after a legitimate host change advances the version', async () => {
  const f = fixture();
  try {
    const setup = getScoutSetupById(f.db, f.setupId)!;
    await handleScoutCoordinationButton(
      f.interaction(`scout:pingroster:${f.setupId}:${setup.version}`, 'manager'), f.db,
    );
    const confirm = f.replies.at(-1).components[0].toJSON().components[0].custom_id;

    await handleScoutCoordinationButton(
      f.interaction(`scout:changehost:${f.setupId}:${setup.version}`, 'manager'), f.db,
    );
    const hostMenu = f.replies.at(-1).components[0].toJSON().components[0];
    const currentHost = listScoutGameHosts(f.db, f.setupId).find((host) => host.gameNumber === 1)!;
    const nextHost = hostMenu.options.find((option: any) =>
      option.value.startsWith('1|') && option.value !== `1|${currentHost.lobbyHostUserId}`).value;
    await handleScoutCoordinationStringSelect(
      f.interaction(hostMenu.custom_id, 'manager', 'ephemeral-host-selector', [nextHost]) as unknown as StringSelectMenuInteraction,
      f.db,
    );
    assert.equal(getScoutSetupById(f.db, f.setupId)!.version, setup.version + 1);

    await handleScoutCoordinationButton(f.interaction(confirm, 'manager', 'ephemeral-stale-ping'), f.db);
    assert.match(f.replies.at(-1).content, /stale/);
    assert.equal(notificationCount(f.db, 'manual_roster'), 0);
  } finally {
    closeDatabase(f.db);
  }
});

test('Change host accepts its private selector and advances only the selected game', async () => {
  const f = fixture(1);
  try {
    const setup = getScoutSetupById(f.db, f.setupId)!;
    const before = listScoutGameHosts(f.db, f.setupId);
    await handleScoutCoordinationButton(
      f.interaction(`scout:changehost:${f.setupId}:${setup.version}`, 'manager') as ButtonInteraction,
      f.db,
    );
    const menu = f.replies.at(-1).components[0].toJSON().components[0];
    const gameOneHost = before.find((host) => host.gameNumber === 1)!;
    const option = menu.options.find((candidate: any) =>
      candidate.value.startsWith('1|') && candidate.value !== `1|${gameOneHost.lobbyHostUserId}`);
    assert.ok(option);

    await handleScoutCoordinationStringSelect(
      f.interaction(menu.custom_id, 'manager', 'ephemeral-host-selector', [option.value]) as unknown as StringSelectMenuInteraction,
      f.db,
    );

    assert.match(f.replies.at(-1).content, /Lobby Host changed/);
    const after = listScoutGameHosts(f.db, f.setupId);
    assert.equal(after.find((host) => host.gameNumber === 1)?.lobbyHostUserId, option.value.split('|')[1]);
    assert.equal(after.find((host) => host.gameNumber === 2)?.lobbyHostUserId,
      before.find((host) => host.gameNumber === 2)?.lobbyHostUserId);
    const current = getScoutSetupById(f.db, f.setupId)!;
    assert.equal(current.version, setup.version + 1);
    assert.match(f.roster.content, new RegExp(`<@${option.value.split('|')[1]}>`));
    assert.match(JSON.stringify(f.roster.components), new RegExp(`scout:changehost:${f.setupId}:${current.version}`));
    assert.equal(notificationCount(f.db, 'host_change'), 1);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM scout_events WHERE setup_id = ? AND event_type = 'lobby_host_changed'")
      .get(f.setupId) as { count: number }).count, 1);

    await handleScoutCoordinationStringSelect(
      f.interaction(menu.custom_id, 'manager', 'ephemeral-host-selector', [option.value]) as unknown as StringSelectMenuInteraction,
      f.db,
    );
    assert.match(f.replies.at(-1).content, /stale or unauthorized/);
    assert.equal(getScoutSetupById(f.db, f.setupId)!.version, current.version);
    assert.equal(notificationCount(f.db, 'host_change'), 1);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM scout_events WHERE setup_id = ? AND event_type = 'lobby_host_changed'")
      .get(f.setupId) as { count: number }).count, 1);
  } finally {
    closeDatabase(f.db);
  }
});

test('Change organizer accepts its private selector and refreshes current controls', async () => {
  const f = fixture();
  try {
    f.addMember('new-organizer');
    const setup = getScoutSetupById(f.db, f.setupId)!;
    await handleScoutCoordinationButton(
      f.interaction(`scout:changeorganizer:${f.setupId}:${setup.version}`, 'manager') as ButtonInteraction,
      f.db,
    );
    const menu = f.replies.at(-1).components[0].toJSON().components[0];

    await handleScoutCoordinationUserSelect(
      f.interaction(menu.custom_id, 'manager', 'ephemeral-organizer-selector', ['new-organizer']) as unknown as UserSelectMenuInteraction,
      f.db,
    );

    assert.match(f.replies.at(-1).content, /Organizer changed/);
    assert.equal(getScoutCoordination(f.db, f.setupId)?.organizerUserId, 'new-organizer');
    const current = getScoutSetupById(f.db, f.setupId)!;
    assert.equal(current.version, setup.version + 1);
    assert.match(JSON.stringify(f.roster.components), new RegExp(`scout:changeorganizer:${f.setupId}:${current.version}`));
    assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM scout_events WHERE setup_id = ? AND event_type = 'organizer_changed'")
      .get(f.setupId) as { count: number }).count, 1);

    await handleScoutCoordinationUserSelect(
      f.interaction(menu.custom_id, 'manager', 'ephemeral-organizer-selector', ['new-organizer']) as unknown as UserSelectMenuInteraction,
      f.db,
    );
    assert.match(f.replies.at(-1).content, /stale or invalid/);
    assert.equal(getScoutSetupById(f.db, f.setupId)!.version, current.version);
    assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM scout_events WHERE setup_id = ? AND event_type = 'organizer_changed'")
      .get(f.setupId) as { count: number }).count, 1);
  } finally {
    closeDatabase(f.db);
  }
});

test('Change organizer rejects departed users and bots', async () => {
  for (const target of ['departed-user', 'bot-user']) {
    const f = fixture();
    try {
      if (target === 'bot-user') f.addMember(target, [], true);
      const setup = getScoutSetupById(f.db, f.setupId)!;
      await handleScoutCoordinationButton(
        f.interaction(`scout:changeorganizer:${f.setupId}:${setup.version}`, 'manager') as ButtonInteraction,
        f.db,
      );
      const menu = f.replies.at(-1).components[0].toJSON().components[0];
      await handleScoutCoordinationUserSelect(
        f.interaction(menu.custom_id, 'manager', 'ephemeral-organizer-selector', [target]) as unknown as UserSelectMenuInteraction,
        f.db,
      );

      assert.match(f.replies.at(-1).content, /stale or invalid/);
      assert.equal(getScoutCoordination(f.db, f.setupId)?.organizerUserId, 'organizer');
      assert.equal(getScoutSetupById(f.db, f.setupId)!.version, setup.version);
      assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM scout_events WHERE setup_id = ? AND event_type = 'organizer_changed'")
        .get(f.setupId) as { count: number }).count, 0);
    } finally {
      closeDatabase(f.db);
    }
  }
});

for (const action of ['changehost', 'changeorganizer'] as const) {
  test(`${action} entry rejects copied controls but accepts the canonical Scout Ops card`, async () => {
    const f = fixture();
    try {
      const setup = getScoutSetupById(f.db, f.setupId)!;
      await handleScoutCoordinationButton(
        f.interaction(`scout:${action}:${f.setupId}:${setup.version}`, 'manager', 'copied-control') as ButtonInteraction,
        f.db,
      );
      assert.match(f.replies.at(-1).content, /not authorized|stale/);

      f.db.prepare("UPDATE scout_setups SET control_message_id = 'ops-card' WHERE id = ?").run(f.setupId);
      const opsEntry: any = f.interaction(`scout:${action}:${f.setupId}:${setup.version}`, 'manager', 'ops-card');
      opsEntry.channelId = 'ops';
      await handleScoutCoordinationButton(opsEntry as ButtonInteraction, f.db);
      assert.match(f.replies.at(-1).content, action === 'changehost' ? /current player/ : /new setup Organizer/);
    } finally {
      closeDatabase(f.db);
    }
  });
}

test('Change host rejects malformed, unknown, and wrong-game private targets', async () => {
  for (const target of ['3|g1-solo-1', '1|unknown-player', '1|g2-solo-1']) {
    const f = fixture();
    try {
      const setup = getScoutSetupById(f.db, f.setupId)!;
      const before = listScoutGameHosts(f.db, f.setupId);
      await handleScoutCoordinationButton(
        f.interaction(`scout:changehost:${f.setupId}:${setup.version}`, 'manager') as ButtonInteraction,
        f.db,
      );
      const menu = f.replies.at(-1).components[0].toJSON().components[0];
      await handleScoutCoordinationStringSelect(
        f.interaction(menu.custom_id, 'manager', 'ephemeral-host-selector', [target]) as unknown as StringSelectMenuInteraction,
        f.db,
      );

      assert.deepEqual(listScoutGameHosts(f.db, f.setupId), before);
      assert.equal(getScoutSetupById(f.db, f.setupId)!.version, setup.version);
      assert.equal(notificationCount(f.db, 'host_change'), 0);
      assert.equal((f.db.prepare("SELECT COUNT(*) AS count FROM scout_events WHERE setup_id = ? AND event_type = 'lobby_host_changed'")
        .get(f.setupId) as { count: number }).count, 0);
    } finally {
      closeDatabase(f.db);
    }
  }
});

for (const flow of ['host', 'organizer'] as const) {
  test(`Change ${flow} private continuation rechecks authorization, context, and lifecycle`, async () => {
    const scenarios = ['revoked', 'guild', 'channel', 'unpublished', 'finished', 'missing-result', 'unreconciled', 'archived'] as const;
    for (const scenario of scenarios) {
      const f = fixture();
      try {
        f.addMember('new-organizer');
        const setup = getScoutSetupById(f.db, f.setupId)!;
        await handleScoutCoordinationButton(
          f.interaction(`scout:change${flow}:${f.setupId}:${setup.version}`, 'manager') as ButtonInteraction,
          f.db,
        );
        const menu = f.replies.at(-1).components[0].toJSON().components[0];
        let value = 'new-organizer';
        if (flow === 'host') {
          const currentHost = listScoutGameHosts(f.db, f.setupId).find((host) => host.gameNumber === 1)!;
          value = menu.options.find((option: any) =>
            option.value.startsWith('1|') && option.value !== `1|${currentHost.lobbyHostUserId}`).value;
        }
        const continuation: any = f.interaction(
          menu.custom_id,
          'manager',
          `ephemeral-${flow}-${scenario}`,
          [value],
        );

        if (scenario === 'revoked') f.members.get('manager')!.roles.cache.clear();
        else if (scenario === 'guild') continuation.guildId = 'other-guild';
        else if (scenario === 'channel') continuation.channelId = 'other-channel';
        else if (scenario === 'unpublished') f.db.prepare("UPDATE scout_setups SET status = 'cancelled' WHERE id = ?").run(f.setupId);
        else if (scenario === 'finished') assert.equal(
          finishScoutSetupIfVersion(f.db, f.setupId, setup.version, 'manager'), 'finished',
        );
        else if (scenario === 'missing-result') f.db.prepare('UPDATE scout_setups SET result_message_id = NULL WHERE id = ?').run(f.setupId);
        else if (scenario === 'unreconciled') f.db.prepare('UPDATE scout_setups SET signup_post_reconciled = 0 WHERE id = ?').run(f.setupId);
        else setDivisionStatus(f.db, 'guild', 'alfheim', 'archived');

        const beforeVersion = getScoutSetupById(f.db, f.setupId)!.version;
        const beforeHosts = listScoutGameHosts(f.db, f.setupId);
        const beforeOrganizer = getScoutCoordination(f.db, f.setupId)?.organizerUserId;
        const eventType = flow === 'host' ? 'lobby_host_changed' : 'organizer_changed';
        const beforeEvents = (f.db.prepare('SELECT COUNT(*) AS count FROM scout_events WHERE setup_id = ? AND event_type = ?')
          .get(f.setupId, eventType) as { count: number }).count;

        if (flow === 'host') {
          await handleScoutCoordinationStringSelect(continuation as StringSelectMenuInteraction, f.db);
        } else {
          await handleScoutCoordinationUserSelect(continuation as UserSelectMenuInteraction, f.db);
        }

        assert.equal(getScoutSetupById(f.db, f.setupId)!.version, beforeVersion, scenario);
        assert.deepEqual(listScoutGameHosts(f.db, f.setupId), beforeHosts, scenario);
        assert.equal(getScoutCoordination(f.db, f.setupId)?.organizerUserId, beforeOrganizer, scenario);
        assert.equal(notificationCount(f.db, 'host_change'), 0, scenario);
        assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM scout_events WHERE setup_id = ? AND event_type = ?')
          .get(f.setupId, eventType) as { count: number }).count, beforeEvents, scenario);
      } finally {
        closeDatabase(f.db);
      }
    }
  });
}
