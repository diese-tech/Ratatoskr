import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collection, type Client, type ButtonInteraction } from 'discord.js';
import { openDatabase, upsertDivision, createScoutSetup, getScoutSetupById, listScoutSignups,
  ensureScoutReadinessCard, cancelScoutSetupIfVersion } from '../db/index.js';
import { SCOUT_ROLES } from '../domain/index.js';
import { ensurePostedScoutSetup } from './scoutCreate.js';
import { handleScoutSignupReactionAdd, handleScoutSignupReactionRemove, refreshScoutMemberReadiness } from './scoutSignups.js';
import { refreshScoutStatusCard, reconcileScoutStatusCards } from './scoutCardLifecycle.js';
import { handleScoutReviewButton } from './scoutReview.js';
import { handleScoutPublishButton } from './scoutPublish.js';

process.env.ROLE_ALLFATHER_ID = 'admin';
process.env.ROLE_AESIR_ID = 'aesir';

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
          url: `https://discord.com/channels/guild/${id}/${nextId}`, components: payload.components,
          reactions: { cache: new Collection(), removeAll: async () => undefined },
          edit: async (next: any) => { message.content = next.content; message.components = next.components; return message; },
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
    if (remove) await handleScoutSignupReactionRemove(reaction, member.user, db);
    else await handleScoutSignupReactionAdd(reaction, member.user, db);
  };
  const fill = async (perRole = 2) => {
    for (const role of SCOUT_ROLES) for (let i = 0; i < perRole; i++) await react(`${role}-${i}`, role);
  };
  const interaction = (customId: string): any => ({ customId, guild, guildId: 'guild', channelId: 'ops', client, user: { id: 'staff' },
    deferUpdate: async () => undefined, deferReply: async () => undefined, editReply: async () => undefined });
  return { db, setup, client: client as Client, guild, members, roleCache, addMember, ops, signups, sent, react, fill, makeSetup, interaction,
    rejectSend: (code = 50013) => { rejectSend = code; },
    loseSend: () => { loseSend = true; }, denyDelete: (value: boolean) => { loseDelete = value; }, denyRead: (value: boolean) => { denyRead = value; } };
}

test('creation shows zero counts; reactions keep one card and readiness replaces it with one creator ping', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup);
    const original = f.ops.all.first()!;
    assert.match(original.content, /0\/10 unique/);
    assert.deepEqual(original.components, []);
    await f.react('solo-0', 'solo'); await f.react('solo-0', 'mid');
    assert.equal(f.ops.all.size, 1); assert.match(original.content, /1\/10 unique/);
    await f.fill();
    assert.equal(f.ops.all.size, 1);
    assert.ok(!f.ops.all.has(original.id));
    const ready = f.ops.all.first()!;
    assert.match(ready.content, /roster ready/); assert.match(ready.content, /10\/10 unique/);
    assert.equal(f.sent.filter((entry) => entry.channel === 'ops' && entry.payload.allowedMentions.users.length).length, 1);
    await f.react('extra-solo', 'solo');
    assert.match(ready.content, /Solo \*\*3\/2/);
    assert.match(ready.content, /unseated players: \*\*1/);
    await f.react('support-0', 'support', true);
    assert.match(ready.content, /draft needs attention: 1/);
  } finally { f.db.close(); }
});

test('eligibility loss gain and departure refresh existing cards without deleting signup history', async () => {
  const f = fixture(':memory:', 'eligible');
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup); await f.react('player', 'solo');
    const card = f.ops.all.first()!;
    f.addMember('player', []);
    await refreshScoutMemberReadiness(f.client, f.db, 'guild', { userId: 'player' });
    assert.match(card.content, /0\/10 unique/); assert.equal(listScoutSignups(f.db, f.setup.id).length, 1);
    f.addMember('player'); await refreshScoutMemberReadiness(f.client, f.db, 'guild', { userId: 'player' });
    assert.match(card.content, /1\/10 unique/);
    f.members.delete('player'); await refreshScoutMemberReadiness(f.client, f.db, 'guild', { userId: 'player' });
    assert.match(card.content, /0\/10 unique/);
  } finally { f.db.close(); }
});

test('two-game draft refresh uses 20/4 targets and publication retains a frozen snapshot', async () => {
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup); await f.fill(4);
    await handleScoutReviewButton(f.interaction(`scout:buildtwoconfirm:${f.setup.id}:0`) as ButtonInteraction, f.db);
    const card = f.ops.all.first()!;
    assert.match(card.content, /20\/20 unique/); assert.match(card.content, /Support \*\*4\/4/);
    await handleScoutPublishButton(f.interaction(`scout:publishconfirm:${f.setup.id}:1`) as ButtonInteraction, f.db);
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.status, 'published');
    assert.match(card.content, /Final recorded signup snapshot/); assert.match(card.content, /Roster: https:/);
    const content = card.content;
    f.members.clear(); await reconcileScoutStatusCards(f.client, f.db);
    assert.equal(card.content, content); assert.deepEqual(card.components, []);
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

test('denied temporary cleanup delays the ready panel and lost ready response does not repeat its ping', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const f = fixture();
  try {
    await ensurePostedScoutSetup(f.client, f.db, f.setup); f.denyDelete(true); await f.fill();
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.status, 'roster_ready');
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.controlMessageId, null);
    assert.equal(f.ops.all.size, 1);
    f.denyDelete(false); f.loseSend();
    await assert.rejects(refreshScoutStatusCard(f.client, f.db, f.setup.id), /Send response lost/);
    await refreshScoutStatusCard(f.client, f.db, f.setup.id);
    assert.equal(f.ops.all.size, 1);
    assert.equal(f.sent.filter((entry) => entry.channel === 'ops' && entry.payload.allowedMentions.users.length).length, 1);
    f.denyRead(true);
    await assert.rejects(refreshScoutStatusCard(f.client, f.db, f.setup.id));
    assert.equal(f.ops.all.size, 1);
    assert.ok(getScoutSetupById(f.db, f.setup.id)?.controlMessageId);
  } finally { f.db.close(); }
});

test('concurrent setups retain isolated cards and an open cancellation preserves its snapshot', async () => {
  const f = fixture();
  try {
    const other = f.makeSetup();
    await Promise.all([ensurePostedScoutSetup(f.client, f.db, f.setup), ensurePostedScoutSetup(f.client, f.db, other)]);
    await Promise.all([f.react('one', 'solo'), f.react('two', 'mid', false, other.id)]);
    assert.equal(f.ops.all.size, 2);
    const firstCardId = ensureScoutReadinessCard(f.db, f.setup.id).telemetry_message_id!;
    assert.match(f.ops.all.get(firstCardId).content, /Solo \*\*1\/2/);
    cancelScoutSetupIfVersion(f.db, f.setup.id, 0);
    await refreshScoutStatusCard(f.client, f.db, f.setup.id);
    assert.equal(f.ops.all.size, 2);
    assert.match(f.ops.all.get(firstCardId).content, /cancelled/);
    assert.match(f.ops.all.get(firstCardId).content, /Final recorded signup snapshot/);
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
    assert.match(f.ops.all.first()!.content, /9\/10 unique/);
    f.addMember('carry-1'); await refreshScoutMemberReadiness(f.client, f.db, 'guild', { userId: 'carry-1' });
    assert.equal(getScoutSetupById(f.db, f.setup.id)?.status, 'roster_ready');
    f.roleCache.delete('eligible');
    await refreshScoutMemberReadiness(f.client, f.db, 'guild', { eligibilityRoleId: 'eligible' });
    assert.match(f.ops.all.first()!.content, /Live readiness could not be verified/);
    assert.match(f.ops.all.first()!.content, /Last recorded signup snapshot/);
    assert.ok(!f.ops.all.first()!.content.includes('A complete roster can be formed'));
    assert.equal(listScoutSignups(f.db, f.setup.id).length, 10);
  } finally { f.db.close(); }
});

test('confirmed send rejections allow temporary and first ready cards to retry with one creator ping', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const f = fixture();
  try {
    f.rejectSend(); await ensurePostedScoutSetup(f.client, f.db, f.setup);
    assert.equal(f.ops.all.size, 0);
    await refreshScoutStatusCard(f.client, f.db, f.setup.id);
    assert.equal(f.ops.all.size, 1);
    f.rejectSend(); await f.fill();
    assert.equal(f.ops.all.size, 0);
    await refreshScoutStatusCard(f.client, f.db, f.setup.id);
    assert.match(f.ops.all.first()!.content, /roster ready/);
    assert.equal(f.sent.filter((entry) => entry.channel === 'ops' && entry.payload.allowedMentions.users.length).length, 1);
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

test('marker recovery paginates and ignores a different setup sharing its prefix', async (t) => {
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
