import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collection, type Client, type ButtonInteraction } from 'discord.js';
import { openDatabase, upsertDivision, createScoutSetup, getScoutSetupById, listScoutSignups,
  ensureScoutReadinessCard, readScoutReadinessSnapshot, cancelScoutSetupIfVersion,
  listScoutRosterSlots, swapPublishedScoutRosterSlotsIfVersion, replacePublishedScoutRosterSlotIfVersion,
  listDivisionScoutLifecycleBlockers, listOverlappingScoutSetups, listScoutEvents } from '../db/index.js';
import { getScoutCompletion, finishScoutSetupIfVersion } from '../db/repositories/scoutCompletions.js';
import { SCOUT_ROLES, type ScoutSignupRole } from '../domain/index.js';
import { ensurePostedScoutSetup } from './scoutCreate.js';
import {
  handleScoutSignupReactionAdd,
  handleScoutSignupReactionRemove,
  reconcileActiveScoutSignups,
  refreshScoutMemberReadiness,
} from './scoutSignups.js';
import { refreshScoutStatusCard as refreshScoutStatusCardWithDependencies } from './scoutCardLifecycle.js';
import { refreshScoutStatusCard, refreshScoutStatusCardSafely, reconcileScoutStatusCards } from './scoutCardCompatibility.js';
import { reportOperationalError } from './operationalErrors.js';
import { createSqliteScoutLifecycleCleanupStore, createSqliteScoutReadinessCardStore, createSqliteScoutSignupStore } from '../storage/index.js';
import { handleScoutReviewButton } from './scoutReview.js';
import { handleScoutPublishButton, handleScoutPublishedSlotSelect, handleScoutPublishedUserSelect } from './scoutPublish.js';
import { handleScoutCancelButton } from './scoutCancel.js';
import { handleScoutFinishButton, reconcileFinishedScoutPosts } from './scoutFinish.js';
import { processDueScoutLifecycleCleanups } from './scoutLifecycleCleanup.js';
import { sqliteScoutLifecycleCleanupDependencies } from './scoutLifecycleCleanupCompatibility.js';

process.env.ROLE_ALLFATHER_ID = 'admin';
process.env.ROLE_AESIR_ID = 'aesir';

function cardDisplayText(card: any): string {
  return [card.content, ...(card.embeds ?? []).flatMap((embed: any) => {
    const data = embed.toJSON?.() ?? embed;
    return [data.title, data.description];
  })].filter(Boolean).join('\n');
}

function fixture(path = ':memory:', eligibilityRoleId: string | null = null) {
  const db = openDatabase(path);
  const members = new Collection<string, any>();
  const roleCache = new Collection<string, any>([['eligible', { id: 'eligible', name: 'Eligible' }]]);
  const guild: any = { id: 'guild', roles: { cache: roleCache, fetch: async (id: string) => roleCache.get(id) ?? null },
    members: { cache: members, fetch: async (id: string) => {
      if (!members.has(id)) throw { code: 10007 };
      return members.get(id);
    } } };
  const addMember = (id: string, roles = ['eligible']) => {
    const member = { id, guild, user: { id, bot: false, send: async () => undefined }, displayName: id,
      roles: { cache: new Collection(roles.map((role) => [role, { id: role }])) } };
    members.set(id, member); return member;
  };
  addMember('staff', ['manager']);
  let nextId = 0;
  let loseSend = false;
  let loseDelete = false;
  let denyRead = false;
  let rejectSend: number | undefined;
  const sent: any[] = [];
  const channels = new Collection<string, any>();
  const client: any = { user: { id: 'bot' }, guilds: { fetch: async () => guild }, channels: { fetch: async (id: string) => channels.get(id) } };
  const signupDependencies = {
    storage: createSqliteScoutSignupStore(db),
    operationScope: db,
    refreshStatusCard: async (targetClient: Client, setupId: number) => refreshScoutStatusCardSafely(targetClient, db, setupId),
    reportError: async (context: any, error: unknown) => { await reportOperationalError(client, db, context, error); },
  };
  const cardDependencies = {
    storage: createSqliteScoutReadinessCardStore(db),
    operationScope: db,
    reportError: async (targetClient: Client, context: any, error: unknown) => reportOperationalError(targetClient, db, context, error),
  };
  const channel = (id: string) => {
    const messages = new Collection<string, any>();
    const result: any = { id, guildId: 'guild', guild, isTextBased: () => true, isSendable: () => true,
      messages: { fetch: async (query: any) => {
        if (id === 'ops' && denyRead) throw { code: 50013 };
        if (typeof query === 'string') {
          if (!messages.has(query)) throw { code: 10008 };
          return messages.get(query);
        }
        let entries = [...messages.entries()].reverse();
        if (query.before) entries = entries.slice(entries.findIndex(([key]) => key === query.before) + 1);
        return new Collection(entries.slice(0, query.limit));
      } },
      send: async (payload: any) => {
        if (id === 'ops' && rejectSend) { const code = rejectSend; rejectSend = undefined; throw { code }; }
        const message: any = { id: String(++nextId), author: client.user, content: payload.content, channelId: id, guildId: 'guild', guild,
          url: `https://discord.com/channels/guild/${id}/${nextId}`, components: payload.components, embeds: payload.embeds ?? [],
          reactions: { cache: new Collection(), removeAll: async () => undefined },
          edit: async (next: any) => { message.content = next.content; message.components = next.components; message.embeds = next.embeds ?? []; return message; },
          delete: async () => { if (loseDelete) throw { code: 50013 }; messages.delete(message.id); },
          react: async (role: string) => { message.reactions.cache.set(role, { emoji: { id: role }, partial: false, message,
            client, users: { fetch: async () => new Collection(), remove: async () => undefined } }); },
        };
        messages.set(message.id, message); sent.push({ channel: id, payload, id: message.id });
        if (id === 'ops' && loseSend) { loseSend = false; throw new Error('Send response lost'); }
        return message;
      }, all: messages };
    channels.set(id, result); return result;
  };
  const ops = channel('ops');
  const signups = channel('signups');
  const division = upsertDivision(db, { guildId: 'guild', divisionKey: 'vanaheim', displayName: 'Vanaheim', roleId: 'division', managerRoleId: 'manager', captainRoleId: 'captain', categoryId: 'category' });
  const makeSetup = () => createScoutSetup(db, { guildId: 'guild', divisionId: division.id, divisionKey: 'vanaheim', divisionDisplayName: 'Vanaheim',
    createdBy: 'staff', signupChannelId: 'signups', resultsChannelId: 'signups', operationsChannelId: 'ops', divisionRoleId: 'division',
    startAt: 2_000_000_000, roleLimit: 5, eligibilityRoleId, emojiByRole: { solo: 'solo', jungle: 'jungle', mid: 'mid', support: 'support', carry: 'carry' } });
  const setup = makeSetup();
  const react = async (id: string, role: string, remove = false, target = setup.id) => {
    const current = getScoutSetupById(db, target)!;
    const message = signups.all.get(current.signupMessageId!);
    const reaction = message.reactions.cache.get(role);
    const member = members.get(id) ?? addMember(id);
    if (remove) await handleScoutSignupReactionRemove(reaction, member.user, signupDependencies);
    else await handleScoutSignupReactionAdd(reaction, member.user, signupDependencies);
  };
  const fill = async (perRole = 2) => {
    for (const role of SCOUT_ROLES) for (let i = 0; i < perRole; i++) await react(`${role}-${i}`, role);
  };
  const interaction = (customId: string): any => ({ customId, guild, guildId: 'guild', channelId: 'ops', client, user: { id: 'staff' },
    message: ops.all.first() ?? { id: 'missing-ops-card' },
    deferUpdate: async () => undefined, deferReply: async () => undefined, editReply: async () => undefined });
  return { db, setup, client: client as Client, signupDependencies, cardDependencies, guild, members, roleCache, addMember, ops, signups, sent, react, fill, makeSetup, interaction, channel,
    rejectSend: (code = 50013) => { rejectSend = code; },
    loseSend: () => { loseSend = true; }, denyDelete: (value: boolean) => { loseDelete = value; }, denyRead: (value: boolean) => { denyRead = value; } };
}

test('creation shows open seats and reactions promote the same working card in place', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const original = f.ops.all.first()!;
    assert.match(cardDisplayText(original), /0\/10 seated/);
    assert.ok(original.components.flatMap((row: any) => row.toJSON().components)
      .some((component: any) => component.custom_id === `scout:cancel:${f.setup.id}:0`));
    await f.react('solo-0', 'solo'); await f.react('solo-0', 'mid');
    assert.equal(f.ops.all.size, 1); assert.match(cardDisplayText(original), /1\/10 seated/);
    await f.fill();
    assert.equal(f.ops.all.size, 1);
    assert.ok(f.ops.all.has(original.id), 'the working card is promoted in place');
    const ready = f.ops.all.first()!;
    assert.match(cardDisplayText(ready), /roster ready/i); assert.match(cardDisplayText(ready), /10\/10 seated/);
    assert.match(cardDisplayText(ready), /Created by <@staff>/);
    assert.equal(f.sent.filter((entry) => entry.channel === 'ops' && entry.payload.allowedMentions.users.length).length, 0);
    await f.react('extra-solo', 'solo');
    assert.match(cardDisplayText(ready), /Unseated signups \(1\)/);
    await f.react('support-0', 'support', true);
    assert.match(cardDisplayText(ready), /9\/10 seated/);
    assert.match(cardDisplayText(ready), /needs Support/);
  } finally { f.db.close(); }
});

test('an open Scout Ops card is one embed with its working roster and controls', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const card = f.ops.all.first()!;
    assert.equal(card.content, '');
    assert.equal(card.embeds.length, 1);
    const embed = card.embeds[0].toJSON?.() ?? card.embeds[0];
    assert.match(embed.title, /Vanaheim Scout · collecting signups/);
    assert.match(embed.description, /Start: <t:/);
    assert.match(embed.description, /0\/10 seated/);
    assert.match(embed.description, /Unseated signups \(0\)/);
    assert.match(embed.description, /Created by <@staff>/);
    assert.ok(card.components.flatMap((row: any) => row.toJSON().components)
      .some((component: any) => component.custom_id === `scout:cancel:${f.setup.id}:0`));
  } finally { f.db.close(); }
});

test('a legacy text-only Scout Ops card migrates in place and stays idempotent', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const card = f.ops.all.first()!;
    const cardId = card.id;
    card.content = cardDisplayText(card);
    card.embeds = [];
    const originalEdit = card.edit;
    let edits = 0;
    card.edit = async (payload: any) => { edits++; return originalEdit(payload); };

    await refreshScoutStatusCard(f.client, f.db, f.setup.id);
    assert.equal(card.id, cardId);
    assert.equal(f.ops.all.size, 1);
    assert.equal(card.content, '');
    assert.equal(card.embeds.length, 1);
    assert.equal(edits, 1);

    await refreshScoutStatusCard(f.client, f.db, f.setup.id);
    assert.equal(edits, 1);
  } finally { f.db.close(); }
});

test('a failed legacy-card edit retries on the same message without duplicate sends', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const card = f.ops.all.first()!;
    card.content = cardDisplayText(card);
    card.embeds = [];
    const originalEdit = card.edit;
    let first = true;
    card.edit = async (payload: any) => {
      if (first) { first = false; throw new Error('Discord edit response lost'); }
      return originalEdit(payload);
    };
    const sent = f.sent.length;

    await assert.rejects(refreshScoutStatusCard(f.client, f.db, f.setup.id), /edit response lost/);
    assert.equal(f.ops.all.size, 1);
    assert.equal(f.sent.length, sent);
    await refreshScoutStatusCard(f.client, f.db, f.setup.id);
    assert.equal(f.ops.all.size, 1);
    assert.equal(f.sent.length, sent);
    assert.equal(card.embeds.length, 1);
    assert.equal(card.content, '');
  } finally { f.db.close(); }
});

test('eligibility changes update the existing embed even when controls stay the same', async () => {
  const f = fixture(':memory:', 'eligible');
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const card = f.ops.all.first()!;
    const initialControls = JSON.stringify(card.components);
    f.addMember('support-player', []);
    await f.react('support-player', 'support');

    assert.equal(f.ops.all.size, 1);
    assert.equal(card.content, '');
    assert.equal(JSON.stringify(card.components), initialControls);
    const embed = card.embeds[0].toJSON?.() ?? card.embeds[0];
    assert.match(embed.description, /<@support-player> · Support — missing <@&eligible>/);
  } finally { f.db.close(); }
});

test('publishing keeps the Ops message and collapses it into one filled embed', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const card = f.ops.all.first()!;
    const cardId = card.id;
    await f.fill();
    await handleScoutPublishButton(f.interaction(`scout:publishconfirm:${f.setup.id}:${getScoutSetupById(f.db, f.setup.id)!.version}`), f.db);

    assert.equal(f.ops.all.size, 1);
    assert.equal(card.id, cardId);
    assert.equal(card.content, '');
    assert.equal(card.embeds.length, 1);
    const embed = card.embeds[0].toJSON?.() ?? card.embeds[0];
    assert.match(embed.title, /Scout filled/);
    assert.match(embed.description, /<t:2000000000:t>/);
    assert.match(embed.description, /Created by <@staff>/);
    assert.equal(card.components[0].toJSON().components[0].label, 'View roster');
  } finally { f.db.close(); }
});

test('replacement-needed status edits the filled Ops card into a distinct embed', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    await f.fill();
    await handleScoutPublishButton(f.interaction(`scout:publishconfirm:${f.setup.id}:${getScoutSetupById(f.db, f.setup.id)!.version}`), f.db);
    const card = f.ops.all.first()!;
    const cardId = card.id;
    const slot = listScoutRosterSlots(f.db, f.setup.id)[0]!;
    f.db.prepare('UPDATE scout_roster_slots SET replacement_needed = 1 WHERE id = ?').run(slot.id);
    await refreshScoutStatusCard(f.client, f.db, f.setup.id);

    assert.equal(f.ops.all.size, 1);
    assert.equal(card.id, cardId);
    assert.equal(card.embeds.length, 1);
    assert.match(cardDisplayText(card), /replacement needed/);
    assert.match(cardDisplayText(card), /Order (Solo|Jungle|Mid|Support|Carry)/);
    assert.match(cardDisplayText(card), /Created by <@staff>/);
    assert.equal(card.components[0].toJSON().components[0].label, 'View roster');
  } finally { f.db.close(); }
});

test('a published Scout awaiting roster-message recovery still has one Ops embed', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const card = f.ops.all.first()!;
    f.db.prepare("UPDATE scout_setups SET status = 'published', result_message_id = NULL WHERE id = ?")
      .run(f.setup.id);
    await refreshScoutStatusCard(f.client, f.db, f.setup.id);

    assert.equal(f.ops.all.size, 1);
    assert.equal(card.content, '');
    assert.equal(card.embeds.length, 1);
    const embed = card.embeds[0].toJSON?.() ?? card.embeds[0];
    assert.match(embed.title, /Vanaheim Scout published/);
    assert.match(embed.description, /Start: <t:/);
    assert.match(embed.description, /Created by <@staff>/);
  } finally { f.db.close(); }
});

test('automatic cancellation puts the existing Scout Ops card in its final attributed state without pinging', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const card = f.ops.all.first()!;
    const setup = getScoutSetupById(f.db, f.setup.id)!;
    const cleanup = createSqliteScoutLifecycleCleanupStore(f.db);

    assert.equal(
      (await cleanup.closeDueSetup(setup.id, setup.startAt + 10_800, 'bot')).status,
      'cancelled',
    );
    f.db.prepare('UPDATE scout_setups SET signup_post_reconciled = 1 WHERE id = ?').run(setup.id);
    await cleanup.markDiscordReconciled(setup.id, setup.startAt + 10_800);
    await refreshScoutStatusCard(f.client, f.db, setup.id);

    assert.equal(f.ops.all.size, 1);
    assert.match(cardDisplayText(card), /Cancelled by <@bot> automatically\./);
    assert.doesNotMatch(cardDisplayText(card), /automatically at/);
    assert.doesNotMatch(cardDisplayText(card), /Cancelled by <@staff>/);
    assert.deepEqual(card.components, []);
  } finally {
    f.db.close();
  }
});

test('cancelled Scout keeps its card and snapshot but shows no signup counts', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    await f.react('historical-player', 'solo');
    const card = f.ops.all.first()!;
    const cardId = card.id;
    const setup = getScoutSetupById(f.db, f.setup.id)!;
    assert.equal(readScoutReadinessSnapshot(ensureScoutReadinessCard(f.db, setup.id))?.players, 1);

    assert.equal(cancelScoutSetupIfVersion(f.db, setup.id, setup.version), 'cancelled');
    await refreshScoutStatusCard(f.client, f.db, setup.id);

    assert.equal(f.ops.all.size, 1);
    assert.equal(f.ops.all.first()!.id, cardId);
    assert.equal(card.embeds?.length, 1);
    const embed = card.embeds[0].toJSON?.() ?? card.embeds[0];
    assert.match(embed.title, /Scout cancelled/);
    assert.match(embed.description, /Start: <t:/);
    assert.match(embed.description, /Created by <@staff>/);
    assert.doesNotMatch(JSON.stringify(embed), /1\/10|Solo|Fill|Last recorded signup snapshot/);
    assert.equal(readScoutReadinessSnapshot(ensureScoutReadinessCard(f.db, setup.id))?.players, 1);
  } finally { f.db.close(); }
});

test('cancelled Scout without a saved snapshot is still a compact count-free embed', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const card = f.ops.all.first()!;
    f.db.prepare('UPDATE scout_readiness_cards SET snapshot_json = NULL WHERE setup_id = ?').run(f.setup.id);
    const setup = getScoutSetupById(f.db, f.setup.id)!;
    assert.equal(cancelScoutSetupIfVersion(f.db, setup.id, setup.version), 'cancelled');
    await refreshScoutStatusCard(f.client, f.db, setup.id);

    assert.equal(card.embeds.length, 1);
    assert.match(cardDisplayText(card), /Scout cancelled/);
    assert.match(cardDisplayText(card), /Signup: https:\/\/discord.com/);
    assert.doesNotMatch(cardDisplayText(card), /seated|unique eligible|Fill|snapshot/i);
    assert.equal(ensureScoutReadinessCard(f.db, setup.id).snapshot_json, null);
  } finally { f.db.close(); }
});

test('automatic finish keeps the current finished-by card presentation without timing filler', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const card = f.ops.all.first()!;
    const setup = getScoutSetupById(f.db, f.setup.id)!;
    f.db.prepare(`UPDATE scout_setups
      SET status = 'published', result_message_id = 'roster', signup_post_reconciled = 1
      WHERE id = ?`).run(setup.id);
    const cleanup = createSqliteScoutLifecycleCleanupStore(f.db);

    assert.equal(
      (await cleanup.closeDueSetup(setup.id, setup.startAt + 10_800, 'bot')).status,
      'finished',
    );
    f.db.prepare('UPDATE scout_completions SET posts_reconciled = 1 WHERE setup_id = ?').run(setup.id);
    await cleanup.markDiscordReconciled(setup.id, setup.startAt + 10_800);
    await refreshScoutStatusCard(f.client, f.db, setup.id);

    assert.equal(card.content, '');
    assert.equal(card.embeds.length, 1);
    const embed = card.embeds[0].toJSON?.() ?? card.embeds[0];
    assert.match(embed.title, /Scout finished/);
    assert.match(embed.description, /Finished by <@bot> automatically\./);
    assert.doesNotMatch(embed.description, /automatically at|Finished by <@staff>/);
  } finally {
    f.db.close();
  }
});

test('automatic cancellation edits existing Discord surfaces without sending a new notification', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const before = f.sent.length;
    const setup = getScoutSetupById(f.db, f.setup.id)!;
    f.addMember('late-signup');
    await f.signupDependencies.storage.addSignup(setup.id, 'late-signup', 'solo');
    assert.equal(readScoutReadinessSnapshot(ensureScoutReadinessCard(f.db, setup.id))?.players, 0);
    const storage = createSqliteScoutLifecycleCleanupStore(f.db);

    await processDueScoutLifecycleCleanups(
      sqliteScoutLifecycleCleanupDependencies(f.client, f.db, storage, f.db),
      setup.startAt + 10_800,
    );

    assert.equal(f.sent.length, before);
    assert.match(f.signups.all.get(setup.signupMessageId)!.content, /Cancelled by <@bot> automatically\./);
    assert.match(cardDisplayText(f.ops.all.first()!), /Cancelled by <@bot> automatically\./);
    assert.doesNotMatch(cardDisplayText(f.ops.all.first()!), /1\/10|unique eligible players/);
    assert.deepEqual(f.ops.all.first()!.components, []);
    assert.equal(readScoutReadinessSnapshot(ensureScoutReadinessCard(f.db, setup.id))?.players, 1);
    assert.equal((await storage.getCleanup(setup.id))?.discordState, 'reconciled');
  } finally {
    f.db.close();
  }
});

test('automatic finish completes pending roster repair without sending its queued notice', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const setup = getScoutSetupById(f.db, f.setup.id)!;
    const roster = await f.signups.send({ content: 'published roster', components: [], allowedMentions: { parse: [] } });
    f.db.prepare(`UPDATE scout_setups
      SET status = 'published', result_message_id = ?, signup_post_reconciled = 1
      WHERE id = ?`).run(roster.id, setup.id);
    f.db.prepare(`INSERT INTO scout_roster_updates
      (setup_id, version, notice) VALUES (?, ?, 'Queued roster change notice')`).run(setup.id, setup.version);
    const before = f.sent.length;
    const storage = createSqliteScoutLifecycleCleanupStore(f.db);

    await processDueScoutLifecycleCleanups(
      sqliteScoutLifecycleCleanupDependencies(f.client, f.db, storage, f.db),
      setup.startAt + 10_800,
    );

    assert.equal(f.sent.length, before);
    assert.equal(f.db.prepare('SELECT 1 FROM scout_roster_updates WHERE setup_id = ?').get(setup.id), undefined);
    assert.match(roster.content, /Finished by <@bot> automatically\./);
    assert.match(f.signups.all.get(setup.signupMessageId)!.content, /Finished by <@bot> automatically\./);
    assert.match(cardDisplayText(f.ops.all.first()!), /Finished by <@bot> automatically\./);
    assert.equal((await storage.getCleanup(setup.id))?.discordState, 'reconciled');
  } finally {
    f.db.close();
  }
});

test('automatic finish retains an uncertain roster notice marker for operator recovery', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const setup = getScoutSetupById(f.db, f.setup.id)!;
    const roster = await f.signups.send({ content: 'published roster', components: [], allowedMentions: { parse: [] } });
    f.db.prepare(`UPDATE scout_setups
      SET status = 'published', result_message_id = ?, signup_post_reconciled = 1
      WHERE id = ?`).run(roster.id, setup.id);
    f.db.prepare(`INSERT INTO scout_roster_updates
      (setup_id, version, notice, message_reconciled, notice_attempted)
      VALUES (?, ?, 'Uncertain roster change notice', 1, 1)`).run(setup.id, setup.version);
    const before = f.sent.length;
    const storage = createSqliteScoutLifecycleCleanupStore(f.db);
    const dependencies = sqliteScoutLifecycleCleanupDependencies(f.client, f.db, storage, f.db);

    await processDueScoutLifecycleCleanups(dependencies, setup.startAt + 10_800);
    await processDueScoutLifecycleCleanups(dependencies, setup.startAt + 10_815);

    assert.ok(getScoutCompletion(f.db, setup.id));
    assert.equal(f.sent.length, before);
    assert.ok(f.db.prepare('SELECT 1 FROM scout_roster_updates WHERE setup_id = ?').get(setup.id));
    assert.equal((await storage.getCleanup(setup.id))?.discordState, 'reconciled');
    assert.match(roster.content, /Finished by <@bot> automatically\./);
  } finally {
    f.db.close();
  }
});

test('a recovered past-dated signup card can officially cancel its setup and preserve its snapshot', async () => {
  const f = fixture();
  try {
    f.db.prepare('UPDATE scout_setups SET start_at = 1 WHERE id = ?').run(f.setup.id);
    await ensurePostedScoutSetup(f.client, f.db, getScoutSetupById(f.db, f.setup.id)!);
    await f.react('old-player', 'solo');
    const card = f.ops.all.first()!;
    card.components = []; // The deployed B2 card before this repair.
    await reconcileScoutStatusCards(f.client, f.db);
    const cancel = card.components.flatMap((row: any) => row.toJSON().components)
      .find((component: any) => component.custom_id?.startsWith('scout:cancel:'))?.custom_id;
    assert.equal(cancel, `scout:cancel:${f.setup.id}:1`);
    const replies: any[] = [];
    const interaction = f.interaction(cancel);
    interaction.editReply = async (payload: any) => replies.push(payload);
    await handleScoutCancelButton(interaction, f.db);
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.status, 'open', 'opening the private confirmation does not cancel');
    const confirm = replies.at(-1).components[0].toJSON().components[0].custom_id;
    await handleScoutCancelButton(f.interaction(confirm), f.db);
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.status, 'cancelled');
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.signupPostReconciled, true);
    assert.match(cardDisplayText(card), /cancelled/);
    assert.doesNotMatch(cardDisplayText(card), /1\/10 unique/);
    assert.equal(readScoutReadinessSnapshot(ensureScoutReadinessCard(f.db, f.setup.id))?.players, 1);
    assert.deepEqual(card.components, []);
    assert.match(f.signups.all.first()!.content, /cancelled/);
    await reconcileScoutStatusCards(f.client, f.db);
    assert.equal(f.ops.all.size, 1);
    assert.deepEqual(card.components, []);
  } finally { f.db.close(); }
});

for (const code of [10008, 50013]) test(`cancellation of an old missing or inaccessible signup post handles Discord ${code}`, async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    f.signups.messages.fetch = async () => { throw { code }; };
    await handleScoutCancelButton(f.interaction(`scout:cancelconfirm:${f.setup.id}:0`), f.db);
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.status, 'cancelled');
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.signupPostReconciled, code === 10008);
    assert.match(cardDisplayText(f.ops.all.first()!), /cancelled/, 'the staff card closes even while public cleanup must retry');
    if (code === 50013) {
      assert.match(cardDisplayText(f.ops.all.first()!), /public post cleanup is pending/);
      assert.equal(f.ops.all.first()!.components[0].toJSON().components[0].label, 'Retry post cleanup');
    }
  } finally { f.db.close(); }
});

test('eligibility loss gain and departure refresh existing cards without deleting signup history', async () => {
  const f = fixture(':memory:', 'eligible');
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup); await f.react('player', 'solo');
    const card = f.ops.all.first()!;
    f.addMember('player', []);
    await refreshScoutMemberReadiness(f.client, f.signupDependencies, 'guild', { userId: 'player' });
    assert.match(cardDisplayText(card), /0\/10 seated/); assert.equal(listScoutSignups(f.db, f.setup.id).length, 1);
    f.addMember('player'); await refreshScoutMemberReadiness(f.client, f.signupDependencies, 'guild', { userId: 'player' });
    assert.match(cardDisplayText(card), /1\/10 seated/);
    f.members.delete('player'); await refreshScoutMemberReadiness(f.client, f.signupDependencies, 'guild', { userId: 'player' });
    assert.match(cardDisplayText(card), /0\/10 seated/);
  } finally { f.db.close(); }
});

test('working card explains why an unseated signup is ineligible', async () => {
  const f = fixture(':memory:', 'eligible');
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    f.addMember('support-player', []);
    await f.react('support-player', 'support');

    const card = f.ops.all.first()!;
    assert.match(cardDisplayText(card), /Unseated signups \(0\)/);
    assert.match(cardDisplayText(card), /Ineligible signups \(1\)/);
    assert.match(cardDisplayText(card), /<@support-player> · Support — missing <@&eligible>/);
  } finally { f.db.close(); }
});

test('long ineligible signup lists keep a reason and omission marker within embed limits', async () => {
  const f = fixture(':memory:', 'eligible');
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    for (let index = 0; index < 40; index++) {
      const userId = `ineligible-player-${String(index).padStart(18, '0')}`;
      f.addMember(userId, []);
      f.db.prepare('INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, ?, ?)')
        .run(f.setup.id, userId, SCOUT_ROLES[index % SCOUT_ROLES.length]);
    }
    await refreshScoutStatusCard(f.client, f.db, f.setup.id);

    const card = f.ops.all.first()!;
    assert.equal(card.embeds.length, 1);
    assert.ok(card.embeds[0].description.length <= 4_096);
    assert.match(cardDisplayText(card), /missing <@&eligible>/);
    assert.match(cardDisplayText(card), /additional ineligible signup\(s\) omitted/);
  } finally { f.db.close(); }
});

test('Seat player and Refresh draft explain excluded ineligible signups', async () => {
  const f = fixture(':memory:', 'eligible');
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    f.addMember('support-player', []);
    await f.react('support-player', 'support');
    const version = getScoutSetupById(f.db, f.setup.id)!.version;
    const replies: any[] = [];
    const seat = f.interaction(`scout:seat:${f.setup.id}:${version}:0`);
    seat.editReply = async (payload: any) => replies.push(payload);

    await handleScoutReviewButton(seat as ButtonInteraction, f.db);
    assert.match(replies.at(-1).content, /no eligible unseated signups/i);
    assert.match(replies.at(-1).content, /<@support-player> · Support — missing <@&eligible>/);

    const refresh = f.interaction(`scout:refresh:${f.setup.id}:${version}`);
    refresh.editReply = async (payload: any) => replies.push(payload);
    await handleScoutReviewButton(refresh as ButtonInteraction, f.db);
    assert.match(replies.at(-1).content, /working roster is already current/i);
    assert.match(replies.at(-1).content, /<@support-player> · Support — missing <@&eligible>/);
  } finally { f.db.close(); }
});

test('ineligible explanations stay within Discord reply limits', async () => {
  const f = fixture(':memory:', 'eligible');
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    for (let index = 0; index < 30; index++) {
      const userId = `ineligible-player-${String(index).padStart(18, '0')}`;
      f.addMember(userId, []);
      f.db.prepare('INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, ?, ?)')
        .run(f.setup.id, userId, SCOUT_ROLES[index % SCOUT_ROLES.length]);
    }
    const replies: any[] = [];
    for (const action of ['seat', 'refresh']) {
      const interaction = f.interaction(`scout:${action}:${f.setup.id}:0${action === 'seat' ? ':0' : ''}`);
      interaction.editReply = async (payload: any) => replies.push(payload);
      await handleScoutReviewButton(interaction as ButtonInteraction, f.db);
      assert.ok(replies.at(-1).content.length <= 2_000);
      assert.match(replies.at(-1).content, /additional ineligible signup/);
    }
  } finally { f.db.close(); }
});

test('two-game draft renders both complete games and publication collapses Ops to stable navigation', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup); await f.fill(4);
    await handleScoutReviewButton(f.interaction(`scout:buildtwoconfirm:${f.setup.id}:${getScoutSetupById(f.db, f.setup.id)!.version}`) as ButtonInteraction, f.db);
    const card = f.ops.all.first()!;
    assert.equal((cardDisplayText(card).match(/10\/10 seated/g) ?? []).length, 2);
    assert.match(cardDisplayText(card), /Unseated signups \(0\)/);
    await handleScoutPublishButton(f.interaction(`scout:publishconfirm:${f.setup.id}:${getScoutSetupById(f.db, f.setup.id)!.version}`) as ButtonInteraction, f.db);
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.status, 'published');
    assert.match(cardDisplayText(card), /Scout filled/);
    const presentation = cardDisplayText(card);
    f.members.clear(); await reconcileScoutStatusCards(f.client, f.db);
    assert.equal(cardDisplayText(card), presentation);
    assert.equal(card.components[1].toJSON().components[0].label, 'Finish scout');
  } finally { f.db.close(); }
});

test('recovered published cards expose player edits and finishing durably closes both posts without deleting history', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup); await f.fill();
    await handleScoutPublishButton(f.interaction(`scout:publishconfirm:${f.setup.id}:${getScoutSetupById(f.db, f.setup.id)!.version}`), f.db);
    const card = f.ops.all.first()!;
    const signup = f.signups.all.get(getScoutSetupById(f.db, f.setup.id)!.signupMessageId!)!;
    const roster = f.signups.all.get(getScoutSetupById(f.db, f.setup.id)!.resultMessageId!)!;
    card.components = [];
    await reconcileScoutStatusCards(f.client, f.db);
    const manage = roster.components[0].toJSON().components;
    const finish = card.components[1].toJSON().components;
    assert.deepEqual(manage.map((button: any) => button.label), ['Swap players', 'Replace player', 'Ping roster', 'Change host', 'Change organizer']);
    const replies: any[] = [];
    const edit = f.interaction(manage[0].custom_id);
    edit.editReply = async (payload: any) => replies.push(payload);
    await handleScoutPublishButton(edit, f.db);
    assert.match(replies.at(-1).content, /first published player/i, 'existing private roster editor opens directly from Scout Ops');
    const replace = f.interaction(manage[1].custom_id);
    replace.editReply = async (payload: any) => replies.push(payload);
    await handleScoutPublishButton(replace, f.db);
    assert.match(replies.at(-1).content, /slot to replace/i, 'published replacement opens from the canonical Scout Ops card');
    const copiedFinish = f.interaction(finish[0].custom_id);
    copiedFinish.message = { id: 'copied-finish-control' };
    copiedFinish.editReply = async (payload: any) => replies.push(payload);
    await handleScoutFinishButton(copiedFinish, f.db);
    assert.match(replies.at(-1).content, /permission/);
    assert.equal(getScoutCompletion(f.db, f.setup.id), undefined);
    const press = f.interaction(finish[0].custom_id);
    press.editReply = async (payload: any) => replies.push(payload);
    await handleScoutFinishButton(press, f.db);
    assert.equal(getScoutCompletion(f.db, f.setup.id), undefined);
    const confirm = replies.at(-1).components[0].toJSON().components[0].custom_id;
    const confirmInteraction = f.interaction(confirm);
    confirmInteraction.message = { id: 'ephemeral-finish-confirm' };
    await handleScoutFinishButton(confirmInteraction, f.db);
    assert.equal(getScoutCompletion(f.db, f.setup.id)?.finished_by, 'staff');
    assert.equal(getScoutCompletion(f.db, f.setup.id)?.posts_reconciled, 1);
    assert.match(cardDisplayText(card), /finished/);
    assert.match(cardDisplayText(card), /Scout finished/);
    assert.match(cardDisplayText(card), /Created by <@staff>/);
    assert.match(signup.content, /finished/i); assert.match(roster.content, /finished/i);
    assert.equal(card.components[0].toJSON().components[0].label, 'View final roster');
    assert.equal(roster.components[0].toJSON().components[0].label, 'View original signup');
    assert.equal(listScoutSignups(f.db, f.setup.id).length, 10);
    const slots = listScoutRosterSlots(f.db, f.setup.id);
    const currentVersion = getScoutSetupById(f.db, f.setup.id)!.version;
    assert.equal(swapPublishedScoutRosterSlotsIfVersion(f.db, f.setup.id, currentVersion, slots[0]!.id, slots[1]!.id), false);
    assert.equal(replacePublishedScoutRosterSlotIfVersion(f.db, f.setup.id, currentVersion, slots[0]!.id, 'new-player'), 'stale');
    assert.deepEqual(listScoutRosterSlots(f.db, f.setup.id), slots, 'even current-version writes cannot change a finished roster');
    assert.deepEqual(listOverlappingScoutSetups(f.db, 'guild', 'staff', f.setup.startAt), []);
    assert.equal(f.signups.all.size, 2, 'no extra public post or deletion');
    await handleScoutPublishButton(edit, f.db);
    assert.match(replies.at(-1).content, /finished/i);
    await reconcileFinishedScoutPosts(f.client, f.db); await reconcileScoutStatusCards(f.client, f.db);
    assert.equal(f.ops.all.size, 1); assert.equal(card.components[0].toJSON().components[0].label, 'View final roster');
  } finally { f.db.close(); }
});

test('finish confirmation rechecks permission, channel, version and pending roster delivery', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup); await f.fill();
    await handleScoutPublishButton(f.interaction(`scout:publishconfirm:${f.setup.id}:${getScoutSetupById(f.db, f.setup.id)!.version}`), f.db);
    const publishedVersion = getScoutSetupById(f.db, f.setup.id)!.version;
    const press = f.interaction(`scout:finishconfirm:${f.setup.id}:${publishedVersion}`);
    f.addMember('staff', []);
    await handleScoutFinishButton(press, f.db);
    assert.equal(getScoutCompletion(f.db, f.setup.id), undefined);
    f.addMember('staff', ['manager']); press.channelId = 'wrong-ops';
    await handleScoutFinishButton(press, f.db);
    assert.equal(getScoutCompletion(f.db, f.setup.id), undefined);
    press.channelId = 'ops';
    f.db.prepare('UPDATE scout_setups SET version = ? WHERE id = ?').run(publishedVersion + 1, f.setup.id);
    await handleScoutFinishButton(press, f.db);
    assert.equal(getScoutCompletion(f.db, f.setup.id), undefined);
    const currentVersion = publishedVersion + 1;
    f.db.prepare("INSERT INTO scout_roster_updates (setup_id, version, notice) VALUES (?, ?, 'Pending notice')").run(f.setup.id, currentVersion);
    assert.equal(finishScoutSetupIfVersion(f.db, f.setup.id, currentVersion, 'staff'), 'pending');
    await handleScoutFinishButton(f.interaction(`scout:finishconfirm:${f.setup.id}:${currentVersion}`), f.db);
    assert.equal(getScoutCompletion(f.db, f.setup.id), undefined);
    f.db.prepare('DELETE FROM scout_roster_updates WHERE setup_id = ?').run(f.setup.id);
    f.db.prepare('UPDATE scout_setups SET signup_post_reconciled = 0 WHERE id = ?').run(f.setup.id);
    assert.equal(finishScoutSetupIfVersion(f.db, f.setup.id, currentVersion, 'staff'), 'pending');
    f.db.prepare('UPDATE scout_setups SET signup_post_reconciled = 1 WHERE id = ?').run(f.setup.id);
    assert.equal(finishScoutSetupIfVersion(f.db, f.setup.id, currentVersion, 'staff'), 'finished');
    assert.equal(finishScoutSetupIfVersion(f.db, f.setup.id, currentVersion, 'other'), 'already_finished');
    assert.equal(getScoutCompletion(f.db, f.setup.id)?.finished_by, 'staff');
  } finally { f.db.close(); }
});

test('Scout Ops edits and finish retain a legacy two-game roster destination and isolate other setups', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup); await f.fill(4);
    await handleScoutReviewButton(f.interaction(`scout:buildtwoconfirm:${f.setup.id}:${getScoutSetupById(f.db, f.setup.id)!.version}`), f.db);
    await handleScoutPublishButton(f.interaction(`scout:publishconfirm:${f.setup.id}:${getScoutSetupById(f.db, f.setup.id)!.version}`), f.db);
    const other = f.makeSetup();
    const legacy = f.channel('legacy-results');
    const published = getScoutSetupById(f.db, f.setup.id)!;
    const roster = f.signups.all.get(published.resultMessageId!)!;
    f.signups.all.delete(roster.id); legacy.all.set(roster.id, roster);
    f.db.prepare("UPDATE scout_setups SET results_channel_id = 'legacy-results' WHERE id = ?").run(f.setup.id);
    const before = listScoutRosterSlots(f.db, f.setup.id);
    const one = before.find((slot) => slot.gameNumber === 1)!;
    const two = before.find((slot) => slot.gameNumber === 2)!;
    const swap = f.interaction(`scout:publishedswapsecond:${f.setup.id}:${getScoutSetupById(f.db, f.setup.id)!.version}:${one.id}`);
    swap.values = [String(two.id)];
    await handleScoutPublishedSlotSelect(swap, f.db);
    assert.equal(listScoutRosterSlots(f.db, f.setup.id).find((slot) => slot.id === one.id)?.userId, two.userId);
    f.addMember('replacement');
    const replace = f.interaction(`scout:publisheduser:${f.setup.id}:${getScoutSetupById(f.db, f.setup.id)!.version}:${two.id}`);
    replace.values = ['replacement'];
    await handleScoutPublishedUserSelect(replace, f.db);
    assert.equal(listScoutRosterSlots(f.db, f.setup.id).find((slot) => slot.id === two.id)?.userId, 'replacement');
    assert.match(roster.content, /replacement/);
    const card = f.ops.all.first()!;
    assert.equal(card.components[0].toJSON().components[0].label, 'View roster');
    assert.equal(legacy.all.size, 2, 'legacy swap notice stays in the original roster channel; canonical replacement only edits the roster');
    await handleScoutFinishButton(f.interaction(`scout:finishconfirm:${f.setup.id}:${getScoutSetupById(f.db, f.setup.id)!.version}`), f.db);
    assert.equal(getScoutCompletion(f.db, f.setup.id)?.posts_reconciled, 1);
    assert.equal(roster.components[0].toJSON().components[0].label, 'View original signup');
    assert.equal(card.components[0].toJSON().components[0].label, 'View final roster');
    assert.equal(f.signups.all.size, 1); assert.equal(legacy.all.size, 2);
    assert.equal(getScoutCompletion(f.db, other.id), undefined);
    assert.equal(getScoutSetupById(f.db, other.id)?.status, 'posting');
  } finally { f.db.close(); }
});

for (const code of [10008, 50013]) test(`finished post cleanup handles Discord ${code} and survives restart`, async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const directory = mkdtempSync(join(tmpdir(), 'scout-finish-'));
  const path = join(directory, 'db.sqlite');
  const f = fixture(path);
  await ensurePostedScoutSetup(f.client, f.db, f.setup); await f.fill();
  await handleScoutPublishButton(f.interaction(`scout:publishconfirm:${f.setup.id}:${getScoutSetupById(f.db, f.setup.id)!.version}`), f.db);
  const fetch = f.signups.messages.fetch;
  f.signups.messages.fetch = async () => { throw { code }; };
  await handleScoutFinishButton(f.interaction(`scout:finishconfirm:${f.setup.id}:${getScoutSetupById(f.db, f.setup.id)!.version}`), f.db);
  assert.equal(getScoutCompletion(f.db, f.setup.id)?.posts_reconciled, code === 10008 ? 1 : 0);
  assert.equal(listDivisionScoutLifecycleBlockers(f.db, 'guild', f.setup.divisionId).length, code === 10008 ? 0 : 1);
  assert.match(cardDisplayText(f.ops.all.first()!), /finished/);
  f.db.close();
  const reopened = openDatabase(path);
  try {
    f.signups.messages.fetch = fetch;
    await reconcileFinishedScoutPosts(f.client, reopened); await reconcileScoutStatusCards(f.client, reopened);
    assert.equal(getScoutCompletion(reopened, f.setup.id)?.posts_reconciled, 1);
    assert.deepEqual(listDivisionScoutLifecycleBlockers(reopened, 'guild', f.setup.divisionId), []);
    assert.equal(f.ops.all.size, 1); assert.equal(f.ops.all.first()!.components[0].toJSON().components[0].label, 'View final roster');
    assert.equal(finishScoutSetupIfVersion(reopened, f.setup.id, 0, 'staff'), 'already_finished');
  } finally { reopened.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('private Finish cleanup retry reconciles posts without finishing the Scout twice', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup); await f.fill();
    await handleScoutPublishButton(f.interaction(`scout:publishconfirm:${f.setup.id}:${getScoutSetupById(f.db, f.setup.id)!.version}`), f.db);

    const publicFinish = f.ops.all.first()!.components.flatMap((row: any) => row.toJSON().components)
      .find((component: any) => component.custom_id?.startsWith('scout:finish:'));
    const confirmationReplies: any[] = [];
    const publicEntry = f.interaction(publicFinish.custom_id);
    publicEntry.editReply = async (payload: any) => confirmationReplies.push(payload);
    await handleScoutFinishButton(publicEntry, f.db);

    const confirmId = confirmationReplies.at(-1).components[0].toJSON().components[0].custom_id;
    const originalSignupFetch = f.signups.messages.fetch;
    f.signups.messages.fetch = async () => { throw { code: 50013 }; };
    const failureReplies: any[] = [];
    const confirm = f.interaction(confirmId);
    confirm.message = { id: 'private-finish-confirmation' };
    confirm.editReply = async (payload: any) => failureReplies.push(payload);
    await handleScoutFinishButton(confirm, f.db);

    const firstCompletion = getScoutCompletion(f.db, f.setup.id)!;
    const finishedVersion = getScoutSetupById(f.db, f.setup.id)!.version;
    assert.equal(firstCompletion.posts_reconciled, 0);
    assert.equal(listScoutEvents(f.db, f.setup.id).filter((event) => event.eventType === 'scout_finished').length, 1);

    const retryId = failureReplies.at(-1).components[0].toJSON().components[0].custom_id;
    f.signups.messages.fetch = originalSignupFetch;
    const retryReplies: any[] = [];
    const retry = f.interaction(retryId);
    retry.message = { id: 'private-finish-cleanup-retry' };
    retry.editReply = async (payload: any) => retryReplies.push(payload);
    await handleScoutFinishButton(retry, f.db);

    assert.equal(getScoutCompletion(f.db, f.setup.id)?.posts_reconciled, 1);
    assert.equal(getScoutCompletion(f.db, f.setup.id)?.finished_at, firstCompletion.finished_at);
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.version, finishedVersion);
    assert.equal(listScoutEvents(f.db, f.setup.id).filter((event) => event.eventType === 'scout_finished').length, 1);
    assert.match(retryReplies.at(-1).content, /Scout finished/);
  } finally { f.db.close(); }
});

test('lost temporary send response survives disk restart and concurrent refreshes without duplicate cards', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const directory = mkdtempSync(join(tmpdir(), 'scout-card-'));
  const path = join(directory, 'db.sqlite');
  const f = fixture(path);
  f.loseSend(); await ensurePostedScoutSetup(f.client, f.db, f.setup);
  assert.equal(f.ops.all.size, 1); assert.equal(ensureScoutReadinessCard(f.db, f.setup.id).telemetry_message_id, null);
  f.db.close();
  const db = openDatabase(path);
  try {
    await Promise.all([refreshScoutStatusCard(f.client, db, f.setup.id), refreshScoutStatusCard(f.client, db, f.setup.id)]);
    assert.equal(f.ops.all.size, 1);
    assert.equal(ensureScoutReadinessCard(db, f.setup.id).telemetry_message_id, f.ops.all.first()!.id);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('readiness promotion reuses the working card without a second send', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const workingCardId = f.ops.all.first()!.id;
    await f.fill();
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.status, 'roster_ready');
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.controlMessageId, workingCardId);
    assert.equal(f.ops.all.size, 1);
    await refreshScoutStatusCardWithDependencies(f.client, f.cardDependencies, f.setup.id);
    assert.equal(f.ops.all.size, 1);
    assert.equal(f.sent.filter((entry) => entry.channel === 'ops').length, 1);
  } finally { f.db.close(); }
});

test('working-card creation awaits its durable attempt marker before Discord send', async () => {
  const f = fixture();
  f.db.prepare("UPDATE scout_setups SET status = 'open' WHERE id = ?").run(f.setup.id);
  let releaseWrite!: () => void;
  let announceWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const writeStarted = new Promise<void>((resolve) => { announceWrite = resolve; });
  const sqliteStorage = f.cardDependencies.storage;
  f.cardDependencies.storage = {
    ...sqliteStorage,
    async patchCard(setupId, changes) {
      if (changes.telemetry_attempted === 1 && changes.telemetry_message_id === null) {
        announceWrite();
        await writeGate;
      }
      return sqliteStorage.patchCard(setupId, changes);
    },
  };
  const refreshing = refreshScoutStatusCardWithDependencies(f.client, f.cardDependencies, f.setup.id);
  try {
    await writeStarted;
    assert.equal(f.ops.all.size, 0);
    assert.equal(ensureScoutReadinessCard(f.db, f.setup.id).telemetry_attempted, 0);
    releaseWrite();
    await refreshing;
    assert.equal(f.ops.all.size, 1);
    assert.equal(ensureScoutReadinessCard(f.db, f.setup.id).telemetry_message_id, f.ops.all.first()!.id);
  } finally {
    releaseWrite();
    await refreshing;
    f.db.close();
  }
});

test('concurrent setups retain isolated cards and an open cancellation preserves its snapshot', async () => {
  const f = fixture();
  try {
    const other = f.makeSetup();
    await Promise.all([ensurePostedScoutSetup(f.client, f.db, f.setup), ensurePostedScoutSetup(f.client, f.db, other)]);
    await Promise.all([f.react('one', 'solo'), f.react('two', 'mid', false, other.id)]);
    assert.equal(f.ops.all.size, 2);
    const firstCardId = ensureScoutReadinessCard(f.db, f.setup.id).telemetry_message_id!;
    assert.match(cardDisplayText(f.ops.all.get(firstCardId)), /1\/10 seated/);
    cancelScoutSetupIfVersion(f.db, f.setup.id, getScoutSetupById(f.db, f.setup.id)!.version);
    await refreshScoutStatusCard(f.client, f.db, f.setup.id);
    assert.equal(f.ops.all.size, 2);
    assert.match(cardDisplayText(f.ops.all.get(firstCardId)), /cancelled/);
    assert.doesNotMatch(cardDisplayText(f.ops.all.get(firstCardId)), /Last recorded signup snapshot|1\/10/);
    assert.equal(readScoutReadinessSnapshot(ensureScoutReadinessCard(f.db, f.setup.id))?.players, 1);
    assert.equal(getScoutSetupById(f.db, other.id)?.status, 'open');
  } finally { f.db.close(); }
});

test('eligibility gain can trigger readiness and a missing role shows an actionable stale-data warning', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const f = fixture(':memory:', 'eligible');
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    f.addMember('carry-1', []); await f.fill();
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.status, 'open');
    assert.match(cardDisplayText(f.ops.all.first()!), /9\/10 seated/);
    f.addMember('carry-1'); await refreshScoutMemberReadiness(f.client, f.signupDependencies, 'guild', { userId: 'carry-1' });
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.status, 'roster_ready');
    f.roleCache.delete('eligible');
    await refreshScoutMemberReadiness(
      f.client, f.signupDependencies, 'guild', { eligibilityRoleId: 'eligible' },
    );
    assert.match(cardDisplayText(f.ops.all.first()!), /Live eligibility could not be verified/);
    assert.ok(!cardDisplayText(f.ops.all.first()!).includes('A complete roster can be formed'));
    assert.equal(listScoutSignups(f.db, f.setup.id).length, 10);
  } finally { f.db.close(); }
});

test('startup reconciliation rebuilds persisted signups and the working roster from reactions', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const member = f.addMember('offline-support');
    const signupMessage = f.signups.all.get(getScoutSetupById(f.db, f.setup.id)!.signupMessageId!)!;
    signupMessage.reactions.cache.get('support').users.fetch = async () => new Collection<string, any>([
      ['bot', { id: 'bot', bot: true }],
      [member.id, member.user],
    ]);

    await reconcileActiveScoutSignups(f.client, f.signupDependencies);

    assert.deepEqual(
      listScoutSignups(f.db, f.setup.id).map(({ userId, role }) => ({ userId, role })),
      [{ userId: 'offline-support', role: 'support' }],
    );
    assert.match(cardDisplayText(f.ops.all.first()!), /1\/10 seated/);
    assert.match(cardDisplayText(f.ops.all.first()!), /Support: <@offline-support>/);
  } finally {
    f.db.close();
  }
});

test('eligibility warning plus a large working roster stays within Discord limits', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const f = fixture(':memory:', 'eligible');
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    for (let index = 0; index < 100; index++) {
      f.db.prepare('INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, ?, ?)')
        .run(f.setup.id, `51${String(index).padStart(16, '0')}`, SCOUT_ROLES[index % SCOUT_ROLES.length]);
    }
    f.roleCache.delete('eligible');
    await refreshScoutMemberReadiness(
      f.client, f.signupDependencies, 'guild', { eligibilityRoleId: 'eligible' },
    );

    const embed = f.ops.all.first()!.embeds[0];
    assert.match(embed.description, /Live eligibility could not be verified/);
    assert.ok(embed.description.length <= 4_096);
  } finally { f.db.close(); }
});

test('a rejected first working-card send retries and later readiness stays on that card', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const f = fixture();
  try {
    f.rejectSend(); await ensurePostedScoutSetup(f.client, f.db, f.setup);
    assert.equal(f.ops.all.size, 0);
    await refreshScoutStatusCard(f.client, f.db, f.setup.id);
    assert.equal(f.ops.all.size, 1);
    await f.fill();
    assert.equal(f.ops.all.size, 1);
    await refreshScoutStatusCard(f.client, f.db, f.setup.id);
    assert.match(cardDisplayText(f.ops.all.first()!), /roster ready/);
    assert.equal(f.sent.filter((entry) => entry.channel === 'ops').length, 1);
  } finally { f.db.close(); }
});

test('a rejected replacement ready card retries without forgetting the prior creator notification', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup); await f.fill();
    f.ops.all.clear(); f.rejectSend();
    await assert.rejects(refreshScoutStatusCard(f.client, f.db, f.setup.id));
    await refreshScoutStatusCard(f.client, f.db, f.setup.id);
    assert.equal(f.ops.all.size, 1);
    assert.equal(f.sent.filter((entry) => entry.channel === 'ops' && entry.payload.allowedMentions.users.length).length, 1);
  } finally { f.db.close(); }
});

test('an ambiguous replacement ready send stays pending if history cannot confirm delivery', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup); await f.fill();
    f.ops.all.clear(); f.loseSend();
    await assert.rejects(refreshScoutStatusCard(f.client, f.db, f.setup.id), /Send response lost/);
    const sent = f.sent.length;
    f.ops.all.clear(); // No evidence in history does not establish that the send failed.
    await assert.rejects(refreshScoutStatusCard(f.client, f.db, f.setup.id), /send is uncertain/);
    assert.equal(f.sent.length, sent);
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.controlMessageId, null);
    assert.equal(ensureScoutReadinessCard(f.db, f.setup.id).creator_notification_attempted, 1);
  } finally { f.db.close(); }
});

test('component recovery paginates and ignores unrelated visible marker text', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const f = fixture();
  try {
    f.loseSend(); await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const original = f.ops.all.first()!;
    for (let i = 0; i < 105; i++) await f.ops.send({ content: `\`SCOUT-TELEMETRY-${f.setup.id}0\``, components: [] });
    await refreshScoutStatusCard(f.client, f.db, f.setup.id);
    assert.equal(ensureScoutReadinessCard(f.db, f.setup.id).telemetry_message_id, original.id);
    assert.equal(f.ops.all.size, 106);
  } finally { f.db.close(); }
});

test("card recovery never adopts another setup's card whose version number equals this setup's id", async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const f = fixture();
  try {
    // Setup A (id 1): publish it, then bump its version to 2 so its persistent
    // control card's button custom IDs embed "...:1:2" -- its version number
    // now numerically equals the id Setup B is about to get.
    await ensurePostedScoutSetup(f.client, f.db, f.setup); await f.fill();
    await handleScoutPublishButton(
      f.interaction(`scout:publishconfirm:${f.setup.id}:${getScoutSetupById(f.db, f.setup.id)!.version}`), f.db);
    f.db.prepare('UPDATE scout_setups SET version = 2 WHERE id = ?').run(f.setup.id);
    await refreshScoutStatusCard(f.client, f.db, f.setup.id);
    const setupACard = f.ops.all.first()!;
    assert.match(JSON.stringify(setupACard.components), new RegExp(`scout:[a-z]+:${f.setup.id}:2(?::|")`));

    // Setup B (id 2): its own telemetry send response is lost, and that real
    // (but unconfirmed) message is then removed from history entirely, so
    // the only Ops message a version/id mix-up could latch onto is Setup A's.
    const setupB = f.makeSetup();
    const before = new Set(f.ops.all.keys());
    f.loseSend();
    await ensurePostedScoutSetup(f.client, f.db, setupB);
    const lostId = [...f.ops.all.keys()].find((id) => !before.has(id))!;
    f.ops.all.delete(lostId);

    await assert.rejects(refreshScoutStatusCard(f.client, f.db, setupB.id), /telemetry send is uncertain/);

    assert.equal(ensureScoutReadinessCard(f.db, setupB.id).telemetry_message_id, null);
    assert.equal(getScoutSetupById(f.db, f.setup.id)!.controlMessageId, setupACard.id);
  } finally { f.db.close(); }
});

test('a delayed staff-card edit does not block subsequent signup persistence', async () => {
  const f = fixture();
  let release!: () => void;
  let editing!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { editing = resolve; });
  let first: Promise<void> | undefined;
  let second: Promise<void> | undefined;
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const card = f.ops.all.first()!;
    const edit = card.edit;
    card.edit = async (payload: any) => { editing(); await gate; return edit(payload); };
    first = f.react('first', 'solo'); await started;
    second = f.react('second', 'mid');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(listScoutSignups(f.db, f.setup.id).length, 2);
  } finally { release(); await Promise.all([first, second]); f.db.close(); }
});

test('a signup reaction awaits durable async storage before roster and card refresh', async () => {
  const f = fixture();
  let releaseWrite!: () => void;
  let announceWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const writeStarted = new Promise<void>((resolve) => { announceWrite = resolve; });
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const card = f.ops.all.first()!;
    const sqliteStorage = f.signupDependencies.storage;
    f.signupDependencies.storage = {
      ...sqliteStorage,
      async addSignup(setupId: number, userId: string, role: ScoutSignupRole) {
        announceWrite();
        await writeGate;
        return sqliteStorage.addSignup(setupId, userId, role);
      },
    };

    const handling = f.react('delayed', 'solo');
    await writeStarted;
    assert.equal(listScoutSignups(f.db, f.setup.id).length, 0);
    assert.match(cardDisplayText(card), /0\/10 seated/);
    releaseWrite();
    await handling;
    assert.equal(listScoutSignups(f.db, f.setup.id).length, 1);
    assert.match(cardDisplayText(card), /1\/10 seated/);
  } finally {
    releaseWrite();
    f.db.close();
  }
});

test('cancellation retains the last known snapshot when final eligibility cannot be verified', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const f = fixture(':memory:', 'eligible');
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup); await f.react('player', 'solo');
    const saved = ensureScoutReadinessCard(f.db, f.setup.id).snapshot_json;
    f.roleCache.clear();
    await handleScoutCancelButton(f.interaction(`scout:cancelconfirm:${f.setup.id}:${getScoutSetupById(f.db, f.setup.id)!.version}`), f.db);
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.status, 'cancelled');
    assert.equal(ensureScoutReadinessCard(f.db, f.setup.id).snapshot_json, saved);
    assert.doesNotMatch(cardDisplayText(f.ops.all.first()!), /Last recorded signup snapshot|1\/10/);
    f.roleCache.set('eligible', { id: 'eligible' }); f.members.clear();
    await reconcileScoutStatusCards(f.client, f.db);
    assert.equal(ensureScoutReadinessCard(f.db, f.setup.id).snapshot_json, saved);
  } finally { f.db.close(); }
});

test('a delayed open snapshot cannot overwrite the terminal cancellation snapshot', async () => {
  const f = fixture();
  let releaseWrite!: () => void;
  let announceWrite!: () => void;
  const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
  const writeStarted = new Promise<void>((resolve) => { announceWrite = resolve; });
  const sqliteStorage = f.cardDependencies.storage;
  let delaySnapshot = true;
  let refreshing: Promise<unknown> | undefined;
  let cancelling: Promise<unknown> | undefined;
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    f.addMember('first');
    f.db.prepare("INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, 'first', 'solo')").run(f.setup.id);
    f.cardDependencies.storage = {
      ...sqliteStorage,
      async patchSnapshotIfStatus(setupId, expectedStatus, snapshotJson) {
        if (delaySnapshot) {
          delaySnapshot = false;
          announceWrite();
          await writeGate;
        }
        return sqliteStorage.patchSnapshotIfStatus(setupId, expectedStatus, snapshotJson);
      },
    };
    refreshing = refreshScoutStatusCardWithDependencies(f.client, f.cardDependencies, f.setup.id);
    await writeStarted;

    f.addMember('second');
    f.db.prepare("INSERT INTO scout_signups (setup_id, user_id, role) VALUES (?, 'second', 'mid')").run(f.setup.id);
    const version = getScoutSetupById(f.db, f.setup.id)!.version;
    cancelling = handleScoutCancelButton(f.interaction(`scout:cancelconfirm:${f.setup.id}:${version}`), f.db);
    for (let attempt = 0; attempt < 10 && getScoutSetupById(f.db, f.setup.id)?.status !== 'cancelled'; attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.status, 'cancelled');
    assert.equal(readScoutReadinessSnapshot(ensureScoutReadinessCard(f.db, f.setup.id))?.players, 2);

    releaseWrite();
    await Promise.all([refreshing, cancelling]);
    assert.equal(readScoutReadinessSnapshot(ensureScoutReadinessCard(f.db, f.setup.id))?.players, 2);
  } finally {
    releaseWrite();
    await Promise.all([refreshing, cancelling]);
    f.db.close();
  }
});

for (const terminal of ['cancelled', 'published'] as const) {
  test(`${terminal} captures committed signups even while an older card edit is delayed`, async () => {
    const f = fixture();
    let release!: () => void;
    let editing!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { editing = resolve; });
    const pending: Promise<unknown>[] = [];
    try {
      await ensurePostedScoutSetup(f.client, f.db, f.setup);
      if (terminal === 'published') await f.fill();
      const card = f.ops.all.first()!;
      const edit = card.edit;
      card.edit = async (payload: any) => { editing(); await gate; return edit(payload); };
      pending.push(f.react('first-extra', 'solo')); await started;
      pending.push(f.react('second-extra', 'mid'));
      await new Promise<void>((resolve) => setImmediate(resolve));
      const count = terminal === 'published' ? 12 : 2;
      assert.equal(listScoutSignups(f.db, f.setup.id).length, count);
      pending.push(terminal === 'published'
        ? handleScoutPublishButton(f.interaction(`scout:publishconfirm:${f.setup.id}:${getScoutSetupById(f.db, f.setup.id)!.version}`), f.db)
        : handleScoutCancelButton(f.interaction(`scout:cancelconfirm:${f.setup.id}:${getScoutSetupById(f.db, f.setup.id)!.version}`), f.db));
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(getScoutSetupById(f.db, f.setup.id)?.status, terminal);
      // The final snapshot is durable before Discord card delivery can finish.
      assert.equal(readScoutReadinessSnapshot(ensureScoutReadinessCard(f.db, f.setup.id))?.players, count);
      release(); await Promise.all(pending);
      if (terminal === 'published') assert.match(cardDisplayText(card), /Scout filled/);
      else assert.doesNotMatch(cardDisplayText(card), new RegExp(`${count}/10 unique`));
      const presentation = cardDisplayText(card);
      f.members.clear(); await reconcileScoutStatusCards(f.client, f.db);
      assert.equal(cardDisplayText(card), presentation);
    } finally { release(); await Promise.all(pending); f.db.close(); }
  });
}
