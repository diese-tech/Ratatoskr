import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collection, MessageFlags, type ButtonInteraction, type Client, type UserSelectMenuInteraction, type StringSelectMenuInteraction } from 'discord.js';
import { openDatabase, upsertDivision, createScoutSetup, setScoutSetupSignupMessage,
  listScoutRosterSlots, getScoutSetupById, tryCreateInitialScoutRoster, addScoutSignup,
  claimScoutPublish, setScoutResultMessage, getScoutRosterUpdate,
  replacePublishedScoutRosterSlotIfVersion, listDivisionScoutLifecycleBlockers, expandScoutRosterToTwoGamesIfVersion,
  listDueScoutNotifications } from '../db/index.js';
import { SCOUT_ROLES, SCOUT_TEAMS } from '../domain/index.js';
import { handleScoutPublishButton, handleScoutPublishedSlotSelect, handleScoutPublishedUserSelect, reconcilePendingScoutRosterUpdates } from './scoutPublish.js';
import { handleScoutReviewButton, handleScoutReviewStringSelect, handleScoutReviewUserSelect } from './scoutReview.js';
import { handleScoutCoordinationButton } from './scoutCoordination.js';

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
  const roster = { id: 'roster', content: '', components: [] as any[], author: { id: 'bot' },
    url: 'https://discord.com/channels/guild/signups/roster',
    edit: async (payload: any) => { roster.content = payload.content; roster.components = payload.components ?? roster.components; if (editFailure) throw new Error('edit response lost'); return roster; } };
  messages.set('roster', roster);
  const channel = { id: 'signups', isTextBased: () => true, isSendable: () => true,
    messages: { fetch: async (query: any) => typeof query === 'string' ? messages.get(query) : messages },
    send: async (payload: any) => { const message = { id: `notice-${messages.size}`, url: `https://discord.com/channels/guild/signups/notice-${messages.size}`, content: payload.content, components: payload.components ?? [], author: { id: 'bot' } };
      messages.set(message.id, message); if (noticeFailure) throw new Error('send response lost'); return message; } };
  const opsMessages = new Collection<string, any>();
  const opsChannel = { id: 'ops', guildId: 'guild', isTextBased: () => true, isSendable: () => true,
    messages: { fetch: async (query: any) => typeof query === 'string' ? opsMessages.get(query) : opsMessages },
    send: async (payload: any) => {
      const message: any = { id: `ops-${opsMessages.size + 1}`, content: payload.content, components: payload.components ?? [], author: { id: 'bot' },
        edit: async (next: any) => { message.content = next.content; message.components = next.components; return message; },
      };
      opsMessages.set(message.id, message);
      return message;
    } };
  const client = { user: { id: 'bot' }, channels: { fetch: async (id: string) => id === 'ops' ? opsChannel : channel } } as unknown as Client;
  const ineligible = new Set<string>();
  const roleCache = new Collection<string, any>([['eligible', { id: 'eligible' }]]);
  const guild: any = { id: 'guild', roles: { cache: roleCache, fetch: async (id: string) => roleCache.get(id) }, members: { fetch: async (id: string) => ({
    id, guild, displayName: `Player ${id}`, user: { id, bot: false }, roles: { cache: new Collection([
      ...(id === 'staff' ? [['manager', {}] as const] : []),
      ...(!ineligible.has(id) ? [['eligible', {}] as const] : []),
    ]) },
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
  let privateInteractionCount = 0;
  function privateInteraction(customId: string, values: string[] = []) {
    const next = interaction(customId, values);
    next.message = { id: `ephemeral-${++privateInteractionCount}` };
    return next;
  }
  return { db, setup, division, replies, messages, roster, client, interaction, privateInteraction,
    setIneligible: (userId: string) => { ineligible.add(userId); },
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
    assert.doesNotMatch(f.messages.get(setup.resultMessageId!)!.content, /SCOUT-/);
    assert.match(JSON.stringify(f.messages.get(setup.resultMessageId!)!.components), /scout:publishedswap:1:/);
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
    await handleScoutPublishedUserSelect(f.privateInteraction(`scout:publisheduser:${f.setup.id}:0:${slot.id}`, ['replacement']) as unknown as UserSelectMenuInteraction, f.db);
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
    assert.doesNotMatch(f.roster.content, /SCOUT-/);
    assert.equal(getScoutRosterUpdate(recovered, f.setup.id), undefined);
    assert.equal(f.messages.size, 2);
    await reconcilePendingScoutRosterUpdates(f.client, recovered);
    assert.equal(f.messages.size, 2);
  } finally { recovered.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('lost canonical edit response converges without undoing state or emitting a legacy notice', async () => {
  const f = publishedFixture();
  try {
    const slot = listScoutRosterSlots(f.db, f.setup.id)[0]!;
    f.failEdit(true);
    await handleScoutPublishedUserSelect(f.privateInteraction(`scout:publisheduser:${f.setup.id}:0:${slot.id}`, ['replacement']) as unknown as UserSelectMenuInteraction, f.db);
    assert.equal(getScoutRosterUpdate(f.db, f.setup.id)?.message_reconciled, 0);
    f.failEdit(false);
    await reconcilePendingScoutRosterUpdates(f.client, f.db);
    assert.equal(getScoutRosterUpdate(f.db, f.setup.id), undefined);
    assert.equal(f.messages.size, 1);
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
      ...f.privateInteraction(`scout:publisheduser:${f.setup.id}:${version}:${slot.id}`, ['replacement']), ...changes,
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
      await handleScoutPublishedSlotSelect(f.privateInteraction(menu.custom_id, [option.value]) as unknown as StringSelectMenuInteraction, f.db);
      const userMenu = f.replies.at(-1).components[0].toJSON().components[0];
      await handleScoutPublishedUserSelect(f.privateInteraction(userMenu.custom_id, ['replacement']) as unknown as UserSelectMenuInteraction, f.db);
      const after = listScoutRosterSlots(f.db, f.setup.id);
      assert.equal(after.find((s) => s.id === selected.id)?.userId, 'replacement');
      assert.deepEqual(after.filter((s) => s.id !== selected.id).map((s) => [s.id, s.userId]), before.filter((s) => s.id !== selected.id).map((s) => [s.id, s.userId]));
      assert.match(f.roster.content, /replacement/);
      assert.equal(f.messages.size, 1, 'the canonical roster edit replaces legacy change notices');
      assert.equal((f.db.prepare("SELECT kind FROM scout_notifications WHERE setup_id = ? ORDER BY id DESC LIMIT 1")
        .get(f.setup.id) as { kind: string }).kind, 'replacement_notice');
      const first = after.find((s) => s.id !== selected.id)!;
      await handleScoutPublishButton(f.interaction(`scout:publishedswap:${f.setup.id}:${version + 1}`) as unknown as ButtonInteraction, f.db);
      const firstMenu = f.replies.at(-1).components[0].toJSON().components[0];
      await handleScoutPublishedSlotSelect(f.privateInteraction(firstMenu.custom_id, [String(first.id)]) as unknown as StringSelectMenuInteraction, f.db);
      const secondMenu = f.replies.at(-1).components[0].toJSON().components[0];
      assert.equal(secondMenu.options.length, gameCount * 10 - 1);
      await handleScoutPublishedSlotSelect(f.privateInteraction(secondMenu.custom_id, [String(selected.id)]) as unknown as StringSelectMenuInteraction, f.db);
      const swapped = listScoutRosterSlots(f.db, f.setup.id);
      assert.equal(swapped.find((s) => s.id === first.id)?.userId, 'replacement');
      assert.equal(swapped.find((s) => s.id === selected.id)?.userId, first.userId);
      assert.equal(getScoutRosterUpdate(f.db, f.setup.id), undefined);
      const swappedVersion = getScoutSetupById(f.db, f.setup.id)!.version;
      await handleScoutPublishedSlotSelect(
        f.privateInteraction(secondMenu.custom_id, [String(selected.id)]) as unknown as StringSelectMenuInteraction, f.db,
      );
      assert.match(f.replies.at(-1).content, /stale/);
      assert.equal(getScoutSetupById(f.db, f.setup.id)!.version, swappedVersion);
      assert.deepEqual(listScoutRosterSlots(f.db, f.setup.id), swapped);
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

test('published off-role replacement keeps private warning, cancel, confirm, and replay safe', async () => {
  const f = publishedFixture();
  try {
    const candidate = 'off-role-candidate';
    f.db.prepare("INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, ?, 'jungle')")
      .run(f.setup.id, candidate);
    const target = listScoutRosterSlots(f.db, f.setup.id).find((slot) => slot.role === 'carry')!;
    await handleScoutPublishButton(
      f.interaction(`scout:publishedreplace:${f.setup.id}:0`) as unknown as ButtonInteraction, f.db,
    );
    const slotMenu = f.replies.at(-1).components[0].toJSON().components[0];
    await handleScoutPublishedSlotSelect(
      f.privateInteraction(slotMenu.custom_id, [String(target.id)]) as unknown as StringSelectMenuInteraction, f.db,
    );
    const candidateMenu = f.replies.at(-1).components[0].toJSON().components[0];
    const option = candidateMenu.options.find((item: any) => item.value === candidate);
    assert.match(option.label, /off-role/);
    await handleScoutPublishedSlotSelect(
      f.privateInteraction(candidateMenu.custom_id, [candidate]) as unknown as StringSelectMenuInteraction, f.db,
    );
    let warningControls = f.replies.at(-1).components[0].toJSON().components;
    const back = warningControls.find((component: any) => component.label === 'Cancel').custom_id;
    await handleScoutPublishButton(f.privateInteraction(back) as unknown as ButtonInteraction, f.db);
    assert.match(f.replies.at(-1).content, /cancelled/);
    assert.equal(getScoutSetupById(f.db, f.setup.id)!.version, 0);

    await handleScoutPublishedSlotSelect(
      f.privateInteraction(candidateMenu.custom_id, [candidate]) as unknown as StringSelectMenuInteraction, f.db,
    );
    warningControls = f.replies.at(-1).components[0].toJSON().components;
    const confirm = warningControls.find((component: any) => component.label === 'Replace anyway').custom_id;
    await handleScoutPublishButton(f.privateInteraction(confirm) as unknown as ButtonInteraction, f.db);
    assert.equal(listScoutRosterSlots(f.db, f.setup.id).find((slot) => slot.id === target.id)?.userId, candidate);
    assert.equal(getScoutSetupById(f.db, f.setup.id)!.version, 1);
    assert.equal(listDueScoutNotifications(f.db, Number.MAX_SAFE_INTEGER)
      .filter((notification) => notification.kind === 'replacement_notice').length, 1);

    await handleScoutPublishButton(f.privateInteraction(confirm) as unknown as ButtonInteraction, f.db);
    assert.match(f.replies.at(-1).content, /stale/);
    assert.equal(getScoutSetupById(f.db, f.setup.id)!.version, 1);
    assert.equal(listDueScoutNotifications(f.db, Number.MAX_SAFE_INTEGER)
      .filter((notification) => notification.kind === 'replacement_notice').length, 1);
  } finally {
    f.db.close();
  }
});

test('published off-role confirmation rechecks eligibility after its private warning', async () => {
  const f = publishedFixture();
  try {
    const candidate = 'eligibility-lost';
    f.db.prepare("UPDATE scout_setups SET eligibility_role_id = 'eligible' WHERE id = ?").run(f.setup.id);
    f.db.prepare("INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, ?, 'jungle')")
      .run(f.setup.id, candidate);
    const target = listScoutRosterSlots(f.db, f.setup.id).find((slot) => slot.role === 'carry')!;
    await handleScoutPublishButton(
      f.interaction(`scout:publishedreplace:${f.setup.id}:0`) as unknown as ButtonInteraction, f.db,
    );
    const slotMenu = f.replies.at(-1).components[0].toJSON().components[0];
    await handleScoutPublishedSlotSelect(
      f.privateInteraction(slotMenu.custom_id, [String(target.id)]) as unknown as StringSelectMenuInteraction, f.db,
    );
    const candidateMenu = f.replies.at(-1).components[0].toJSON().components[0];
    await handleScoutPublishedSlotSelect(
      f.privateInteraction(candidateMenu.custom_id, [candidate]) as unknown as StringSelectMenuInteraction, f.db,
    );
    const confirm = f.replies.at(-1).components[0].toJSON().components
      .find((component: any) => component.label === 'Replace anyway').custom_id;
    f.setIneligible(candidate);
    await handleScoutPublishButton(f.privateInteraction(confirm) as unknown as ButtonInteraction, f.db);

    assert.match(f.replies.at(-1).content, /no longer eligible/);
    assert.notEqual(listScoutRosterSlots(f.db, f.setup.id).find((slot) => slot.id === target.id)?.userId, candidate);
    assert.equal(getScoutSetupById(f.db, f.setup.id)!.version, 0);
    assert.equal(listDueScoutNotifications(f.db, Number.MAX_SAFE_INTEGER)
      .filter((notification) => notification.kind === 'replacement_notice').length, 0);
  } finally {
    f.db.close();
  }
});

test('Ping roster uses the final canonical controls after a published replacement and swap', async () => {
  const f = publishedFixture();
  try {
    const before = listScoutRosterSlots(f.db, f.setup.id);
    const replaced = before.find((slot) => slot.team === 'team_two' && slot.role === 'carry')!;
    await handleScoutPublishButton(
      f.interaction(`scout:publishedreplace:${f.setup.id}:0`) as unknown as ButtonInteraction, f.db,
    );
    const replaceMenu = f.replies.at(-1).components[0].toJSON().components[0];
    await handleScoutPublishedSlotSelect(
      f.interaction(replaceMenu.custom_id, [String(replaced.id)]) as unknown as StringSelectMenuInteraction, f.db,
    );
    const replacementMenu = f.replies.at(-1).components[0].toJSON().components[0];
    await handleScoutPublishedUserSelect(
      f.interaction(replacementMenu.custom_id, ['replacement']) as unknown as UserSelectMenuInteraction, f.db,
    );

    let controls = f.roster.components[0].toJSON().components;
    const swapId = controls.find((component: any) => component.label === 'Swap players').custom_id;
    await handleScoutPublishButton(f.interaction(swapId) as unknown as ButtonInteraction, f.db);
    const firstMenu = f.replies.at(-1).components[0].toJSON().components[0];
    const first = listScoutRosterSlots(f.db, f.setup.id).find((slot) => slot.id !== replaced.id)!;
    await handleScoutPublishedSlotSelect(
      f.interaction(firstMenu.custom_id, [String(first.id)]) as unknown as StringSelectMenuInteraction, f.db,
    );
    const secondMenu = f.replies.at(-1).components[0].toJSON().components[0];
    await handleScoutPublishedSlotSelect(
      f.interaction(secondMenu.custom_id, [String(replaced.id)]) as unknown as StringSelectMenuInteraction, f.db,
    );

    controls = f.roster.components[0].toJSON().components;
    const pingId = controls.find((component: any) => component.label === 'Ping roster').custom_id;
    assert.match(pingId, new RegExp(`:${getScoutSetupById(f.db, f.setup.id)!.version}$`));
    await handleScoutCoordinationButton(f.interaction(pingId) as unknown as ButtonInteraction, f.db);
    const pingConfirmId = f.replies.at(-1).components[0].toJSON().components[0].custom_id;
    const pingConfirm = f.interaction(pingConfirmId);
    pingConfirm.message = { id: 'ephemeral-ping-confirm' };
    await handleScoutCoordinationButton(pingConfirm as unknown as ButtonInteraction, f.db);

    assert.match(f.replies.at(-1).content, /queued/);
    assert.equal(listDueScoutNotifications(f.db, Number.MAX_SAFE_INTEGER)
      .filter((notification) => notification.kind === 'manual_roster').length, 1);
  } finally {
    f.db.close();
  }
});

test('published management entry buttons reject copied noncanonical controls', async () => {
  for (const action of ['publishedreplace', 'publishedswap']) {
    const f = publishedFixture();
    try {
      const copied = f.interaction(`scout:${action}:${f.setup.id}:0`);
      copied.message = { id: 'copied-management-control' };
      await handleScoutPublishButton(copied as unknown as ButtonInteraction, f.db);

      assert.match(f.replies.at(-1).content, /permission/);
      assert.equal(getScoutSetupById(f.db, f.setup.id)?.version, 0);
      assert.equal(getScoutRosterUpdate(f.db, f.setup.id), undefined);
    } finally {
      f.db.close();
    }
  }
});
