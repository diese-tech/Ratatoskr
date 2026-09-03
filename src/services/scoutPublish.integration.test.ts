import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collection, MessageFlags, type ButtonInteraction, type Client, type UserSelectMenuInteraction, type StringSelectMenuInteraction } from 'discord.js';
import { openDatabase, upsertDivision, createScoutSetup, setScoutSetupSignupMessage,
  listScoutRosterSlots, getScoutSetupById, tryCreateInitialScoutRoster, addScoutSignup,
  claimScoutPublish, setScoutResultMessage, getScoutRosterUpdate,
  replacePublishedScoutRosterSlotIfVersion, listDivisionScoutLifecycleBlockers, expandScoutRosterToTwoGamesIfVersion } from '../db/index.js';
import { SCOUT_ROLES, SCOUT_TEAMS } from '../domain/index.js';
import { handleScoutPublishButton, handleScoutPublishedSlotSelect, handleScoutPublishedUserSelect, reconcilePendingScoutRosterUpdates } from './scoutPublish.js';
import { handleScoutReviewButton, handleScoutReviewStringSelect, handleScoutReviewUserSelect } from './scoutReview.js';

process.env.ROLE_ALLFATHER_ID = 'admin';
process.env.ROLE_AESIR_ID = 'aesir';

export function publishedFixture(path = ':memory:', gameCount = 1, published = true) {
  const db = openDatabase(path);
  const division = upsertDivision(db, { guildId: 'guild', divisionKey: 'vanaheim', displayName: 'Vanaheim',
    roleId: 'division', managerRoleId: 'manager', captainRoleId: 'captain', categoryId: 'category' });
  const setup = createScoutSetup(db, { guildId: 'guild', divisionId: division.id, divisionKey: 'vanaheim',
    divisionDisplayName: 'Vanaheim', createdBy: 'staff', signupChannelId: 'signups', resultsChannelId: 'old-results',
    operationsChannelId: 'ops', divisionRoleId: 'division', startAt: 2_000_000_000, roleLimit: 2,
    emojiByRole: { solo: 'solo', jungle: 'jungle', mid: 'mid', support: 'support', carry: 'carry' } });
  setScoutSetupSignupMessage(db, setup.id, 'signup');
  const slots = Array.from({ length: gameCount }, (_, game) => game + 1).flatMap((gameNumber) =>
    SCOUT_ROLES.flatMap((role) => SCOUT_TEAMS.map((team, i) => ({ gameNumber, team, role, userId: `g${gameNumber}-${role}-${i}` }))));
  for (const slot of slots) addScoutSignup(db, setup.id, slot.userId, slot.role);
  tryCreateInitialScoutRoster(db, setup.id, slots.filter((slot) => slot.gameNumber === 1));
  if (gameCount === 2) expandScoutRosterToTwoGamesIfVersion(db, setup.id, 0, slots);
  if (published) {
    claimScoutPublish(db, setup.id, gameCount - 1);
    setScoutResultMessage(db, setup.id, 'roster');
  }
  const replies: any[] = [];
  const messages = new Collection<string, any>();
  let editFailure = false;
  let noticeFailure = false;
  const roster = { id: 'roster', content: '', author: { id: 'bot' },
    edit: async (payload: any) => { roster.content = payload.content; if (editFailure) throw new Error('edit response lost'); return roster; } };
  messages.set('roster', roster);
  const channel = { id: 'signups', isTextBased: () => true, isSendable: () => true,
    messages: { fetch: async (query: any) => typeof query === 'string' ? messages.get(query) : messages },
    send: async (payload: any) => { const message = { id: `notice-${messages.size}`, url: `https://discord.com/channels/guild/signups/notice-${messages.size}`, content: payload.content, author: { id: 'bot' } };
      messages.set(message.id, message); if (noticeFailure) throw new Error('send response lost'); return message; } };
  const client = { user: { id: 'bot' }, channels: { fetch: async (id: string) => { assert.equal(id, 'signups'); return channel; } } } as unknown as Client;
  const guild: any = { id: 'guild', roles: { cache: new Collection() }, members: { fetch: async (id: string) => ({
    id, guild, displayName: `Player ${id}`, user: { id, bot: false }, roles: { cache: new Collection(id === 'staff' ? [['manager', {}]] : []) },
  }) } };
  function interaction(customId: string, values: string[] = []) {
    let acknowledged = false;
    return { customId, values, client, guild, guildId: 'guild', user: { id: 'staff' }, channelId: 'signups',
      message: { id: 'roster' },
      deferReply: async (payload: any) => { assert.equal(acknowledged, false, 'double acknowledgement'); acknowledged = true; assert.equal(payload.flags, MessageFlags.Ephemeral); },
      deferUpdate: async () => { assert.equal(acknowledged, false, 'double acknowledgement'); acknowledged = true; },
      reply: async (payload: any) => { assert.equal(acknowledged, false, 'double acknowledgement'); acknowledged = true; replies.push(payload); },
      update: async (payload: any) => { assert.equal(acknowledged, false, 'double acknowledgement'); acknowledged = true; replies.push(payload); },
      editReply: async (payload: any) => { assert.equal(acknowledged, true, 'must acknowledge before work'); replies.push(payload); },
    };
  }
  return { db, setup, division, replies, messages, roster, client, interaction,
    failEdit: (value: boolean) => { editFailure = value; }, failNotice: (value: boolean) => { noticeFailure = value; } };
}

test('first publication sends a separate roster into signups and preserves the original signup post', async () => {
  const f = publishedFixture(':memory:', 1, false);
  const signup = { id: 'signup', content: 'Original signup',
    edit: async (payload: any) => { signup.content = payload.content; return signup; } };
  f.messages.clear();
  f.messages.set('signup', signup);
  try {
    const publish = f.interaction(`scout:publishconfirm:${f.setup.id}:0`);
    publish.channelId = 'ops';
    await handleScoutPublishButton(publish as unknown as ButtonInteraction, f.db);
    const setup = getScoutSetupById(f.db, f.setup.id)!;
    assert.equal(setup.status, 'published');
    assert.equal(setup.resultsChannelId, 'signups');
    assert.equal(setup.signupMessageId, 'signup');
    assert.notEqual(setup.resultMessageId, setup.signupMessageId);
    assert.equal(setup.signupPostReconciled, true);
    assert.equal(f.messages.size, 2);
    assert.match(signup.content, /Roster published: https:\/\/discord.com\/channels\/guild\/signups\//);
    assert.match(f.messages.get(setup.resultMessageId!)!.content, /SCOUT-RESULT-1/);
    const retry = f.interaction(`scout:publishconfirm:${f.setup.id}:0`);
    retry.channelId = 'ops';
    await handleScoutPublishButton(retry as unknown as ButtonInteraction, f.db);
    assert.equal(f.messages.size, 2, 'a stale confirmation cannot create another roster');
  } finally { f.db.close(); }
});

test('published Swap opens a private selector with exactly one acknowledgement', async () => {
  const f = publishedFixture();
  try {
    assert.equal(await handleScoutPublishButton(f.interaction(`scout:publishedswap:${f.setup.id}:0`) as unknown as ButtonInteraction, f.db), true);
    assert.match(f.replies.at(-1).content, /first published player/i);
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.version, 0);
  } finally { f.db.close(); }
});

test('ambiguous published edit retains canonical replacement for recovery', async () => {
  const f = publishedFixture();
  try {
    const slot = listScoutRosterSlots(f.db, f.setup.id)[0]!;
    f.failEdit(true);
    await handleScoutPublishedUserSelect(f.interaction(`scout:publisheduser:${f.setup.id}:0:${slot.id}`, ['replacement']) as unknown as UserSelectMenuInteraction, f.db);
    assert.equal(listScoutRosterSlots(f.db, f.setup.id).find((s) => s.id === slot.id)?.userId, 'replacement');
    assert.match(f.replies.at(-1).content, /saved.*pending|pending.*saved/i);
  } finally { f.db.close(); }
});

test('database restart after commit recovers the original roster and sends its notice once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ratatoskr-published-'));
  const path = join(dir, 'state.db');
  const f = publishedFixture(path);
  const slot = listScoutRosterSlots(f.db, f.setup.id)[0]!;
  assert.equal(replacePublishedScoutRosterSlotIfVersion(f.db, f.setup.id, 0, slot.id, 'after-crash'), 'updated');
  f.db.close(); // crash before the first Discord edit
  const recovered = openDatabase(path);
  try {
    assert.equal(getScoutRosterUpdate(recovered, f.setup.id)?.version, 1);
    await reconcilePendingScoutRosterUpdates(f.client, recovered);
    assert.match(f.roster.content, /after-crash/);
    assert.match(f.roster.content, /SCOUT-RESULT-1/);
    assert.equal(getScoutRosterUpdate(recovered, f.setup.id), undefined);
    assert.equal(f.messages.size, 2);
    await reconcilePendingScoutRosterUpdates(f.client, recovered);
    assert.equal(f.messages.size, 2);
  } finally { recovered.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('lost edit and notice responses converge without undoing state or duplicating notices', async () => {
  const f = publishedFixture();
  try {
    const slot = listScoutRosterSlots(f.db, f.setup.id)[0]!;
    f.failEdit(true);
    await handleScoutPublishedUserSelect(f.interaction(`scout:publisheduser:${f.setup.id}:0:${slot.id}`, ['replacement']) as unknown as UserSelectMenuInteraction, f.db);
    assert.equal(getScoutRosterUpdate(f.db, f.setup.id)?.message_reconciled, 0);
    f.failEdit(false);
    f.failNotice(true);
    await reconcilePendingScoutRosterUpdates(f.client, f.db);
    assert.equal(getScoutRosterUpdate(f.db, f.setup.id)?.notice_attempted, 1);
    assert.equal(f.messages.size, 2, 'Discord accepted the notice before the response was lost');
    await reconcilePendingScoutRosterUpdates(f.client, f.db);
    assert.equal(getScoutRosterUpdate(f.db, f.setup.id), undefined);
    assert.equal(f.messages.size, 2);
    assert.equal(listScoutRosterSlots(f.db, f.setup.id).find((s) => s.id === slot.id)?.userId, 'replacement');
  } finally { f.db.close(); }
});

test('uncertain notice absence retains pending state and blocks teardown instead of resending', async () => {
  const f = publishedFixture();
  try {
    const slot = listScoutRosterSlots(f.db, f.setup.id)[0]!;
    replacePublishedScoutRosterSlotIfVersion(f.db, f.setup.id, 0, slot.id, 'replacement');
    f.db.prepare('UPDATE scout_roster_updates SET notice_attempted = 1').run();
    await reconcilePendingScoutRosterUpdates(f.client, f.db);
    await reconcilePendingScoutRosterUpdates(f.client, f.db);
    assert.equal(f.messages.size, 1);
    assert.ok(getScoutRosterUpdate(f.db, f.setup.id));
    assert.equal(listDivisionScoutLifecycleBlockers(f.db, 'guild', f.division.id).length, 1);
  } finally { f.db.close(); }
});

test('missing messages, wrong channel, unauthorized members and stale selections do not mutate rosters', async () => {
  const f = publishedFixture();
  try {
    const slot = listScoutRosterSlots(f.db, f.setup.id)[0]!;
    const call = (changes: Record<string, unknown>, version = 0) => handleScoutPublishedUserSelect({
      ...f.interaction(`scout:publisheduser:${f.setup.id}:${version}:${slot.id}`, ['replacement']), ...changes,
    } as unknown as UserSelectMenuInteraction, f.db);
    await call({ channelId: 'other-division' });
    await call({ user: { id: 'outsider' } });
    await call({}, 9);
    f.messages.delete('roster');
    await call({});
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.version, 0);
    assert.equal(getScoutRosterUpdate(f.db, f.setup.id), undefined);
    assert.equal(listScoutRosterSlots(f.db, f.setup.id).find((s) => s.id === slot.id)?.userId, slot.userId);
  } finally { f.db.close(); }
});

for (const gameCount of [1, 2]) {
  test(`${gameCount}-game published selectors use names and replace/swap only exact selected slots`, async () => {
    const f = publishedFixture(':memory:', gameCount);
    try {
      const version = gameCount - 1;
      const before = listScoutRosterSlots(f.db, f.setup.id);
      const selected = before.find((s) => s.gameNumber === gameCount && s.team === 'team_two' && s.role === 'carry')!;
      await handleScoutPublishButton(f.interaction(`scout:publishedreplace:${f.setup.id}:${version}`) as unknown as ButtonInteraction, f.db);
      const menu = f.replies.at(-1).components[0].toJSON().components[0];
      assert.equal(menu.options.length, gameCount * 10);
      assert.equal(new Set(menu.options.map((o: any) => o.value)).size, gameCount * 10);
      const option = menu.options.find((o: any) => o.value === String(selected.id));
      assert.match(option.label, new RegExp(`^G${gameCount} • Chaos • Carry — Player`));
      await handleScoutPublishedSlotSelect(f.interaction(menu.custom_id, [option.value]) as unknown as StringSelectMenuInteraction, f.db);
      const userMenu = f.replies.at(-1).components[0].toJSON().components[0];
      await handleScoutPublishedUserSelect(f.interaction(userMenu.custom_id, ['replacement']) as unknown as UserSelectMenuInteraction, f.db);
      const after = listScoutRosterSlots(f.db, f.setup.id);
      assert.equal(after.find((s) => s.id === selected.id)?.userId, 'replacement');
      assert.deepEqual(after.filter((s) => s.id !== selected.id).map((s) => [s.id, s.userId]), before.filter((s) => s.id !== selected.id).map((s) => [s.id, s.userId]));
      assert.match(f.roster.content, /replacement/);
      assert.ok([...f.messages.values()].some((m) => m.content.includes(`Game ${gameCount} Chaos Carry`) && m.content.includes(selected.userId) && m.content.includes('replacement')));
      const first = after.find((s) => s.id !== selected.id)!;
      await handleScoutPublishButton(f.interaction(`scout:publishedswap:${f.setup.id}:${version + 1}`) as unknown as ButtonInteraction, f.db);
      const firstMenu = f.replies.at(-1).components[0].toJSON().components[0];
      await handleScoutPublishedSlotSelect(f.interaction(firstMenu.custom_id, [String(first.id)]) as unknown as StringSelectMenuInteraction, f.db);
      const secondMenu = f.replies.at(-1).components[0].toJSON().components[0];
      assert.equal(secondMenu.options.length, gameCount * 10 - 1);
      await handleScoutPublishedSlotSelect(f.interaction(secondMenu.custom_id, [String(selected.id)]) as unknown as StringSelectMenuInteraction, f.db);
      const swapped = listScoutRosterSlots(f.db, f.setup.id);
      assert.equal(swapped.find((s) => s.id === first.id)?.userId, 'replacement');
      assert.equal(swapped.find((s) => s.id === selected.id)?.userId, first.userId);
      assert.equal(getScoutRosterUpdate(f.db, f.setup.id), undefined);
    } finally { f.db.close(); }
  });

  test(`${gameCount}-game draft menus retain named slot identity through replacement`, async () => {
    const f = publishedFixture(':memory:', gameCount);
    try {
      f.db.prepare("UPDATE scout_setups SET status = 'roster_ready', result_message_id = NULL WHERE id = ?").run(f.setup.id);
      const version = gameCount - 1;
      const before = listScoutRosterSlots(f.db, f.setup.id);
      const selected = before.find((s) => s.gameNumber === gameCount && s.team === 'team_two' && s.role === 'carry')!;
      const draft = (customId: string, values: string[] = []) => ({ ...f.interaction(customId, values), channelId: 'ops', users: new Collection() });
      await handleScoutReviewButton(draft(`scout:edit:replace:${f.setup.id}:${version}`) as unknown as ButtonInteraction, f.db);
      const menu = f.replies.at(-1).components[0].toJSON().components[0];
      assert.equal(menu.options.length, gameCount * 10);
      assert.ok(menu.options.every((o: any) => o.label.includes('Player')));
      await handleScoutReviewStringSelect(draft(menu.custom_id, [String(selected.id)]) as unknown as StringSelectMenuInteraction, f.db);
      const userMenu = f.replies.at(-1).components.at(-1).toJSON().components[0];
      await handleScoutReviewUserSelect(draft(userMenu.custom_id, ['draft-substitute']) as unknown as UserSelectMenuInteraction, f.db);
      const after = listScoutRosterSlots(f.db, f.setup.id);
      assert.equal(after.find((s) => s.id === selected.id)?.userId, 'draft-substitute');
      assert.deepEqual(after.filter((s) => s.id !== selected.id).map((s) => [s.id, s.userId]), before.filter((s) => s.id !== selected.id).map((s) => [s.id, s.userId]));
    } finally { f.db.close(); }
  });
}
