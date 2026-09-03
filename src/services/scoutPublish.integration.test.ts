import assert from 'node:assert/strict';
import test from 'node:test';
import { Collection, MessageFlags, type ButtonInteraction, type Client, type UserSelectMenuInteraction } from 'discord.js';
import { openDatabase, upsertDivision, createScoutSetup, setScoutSetupSignupMessage,
  listScoutRosterSlots, getScoutSetupById, tryCreateInitialScoutRoster, addScoutSignup,
  claimScoutPublish, setScoutResultMessage } from '../db/index.js';
import { SCOUT_ROLES, SCOUT_TEAMS } from '../domain/index.js';
import { handleScoutPublishButton, handleScoutPublishedUserSelect } from './scoutPublish.js';

process.env.ROLE_ALLFATHER_ID = 'admin';
process.env.ROLE_AESIR_ID = 'aesir';

export function publishedFixture(path = ':memory:') {
  const db = openDatabase(path);
  const division = upsertDivision(db, { guildId: 'guild', divisionKey: 'vanaheim', displayName: 'Vanaheim',
    roleId: 'division', managerRoleId: 'manager', captainRoleId: 'captain', categoryId: 'category' });
  const setup = createScoutSetup(db, { guildId: 'guild', divisionId: division.id, divisionKey: 'vanaheim',
    divisionDisplayName: 'Vanaheim', createdBy: 'staff', signupChannelId: 'signups', resultsChannelId: 'old-results',
    operationsChannelId: 'ops', divisionRoleId: 'division', startAt: 2_000_000_000, roleLimit: 2,
    emojiByRole: { solo: 'solo', jungle: 'jungle', mid: 'mid', support: 'support', carry: 'carry' } });
  setScoutSetupSignupMessage(db, setup.id, 'signup');
  const slots = SCOUT_ROLES.flatMap((role) => SCOUT_TEAMS.map((team, i) => ({ team, role, userId: `${role}-${i}` })));
  for (const slot of slots) addScoutSignup(db, setup.id, slot.userId, slot.role);
  tryCreateInitialScoutRoster(db, setup.id, slots);
  claimScoutPublish(db, setup.id, 0);
  setScoutResultMessage(db, setup.id, 'roster');
  const replies: any[] = [];
  const messages = new Collection<string, any>();
  let editFailure = false;
  let noticeFailure = false;
  const roster = { id: 'roster', content: '', author: { id: 'bot' },
    edit: async (payload: any) => { roster.content = payload.content; if (editFailure) throw new Error('edit response lost'); return roster; } };
  messages.set('roster', roster);
  const channel = { id: 'signups', isTextBased: () => true, isSendable: () => true,
    messages: { fetch: async (query: any) => typeof query === 'string' ? messages.get(query) : messages },
    send: async (payload: any) => { const message = { id: `notice-${messages.size}`, content: payload.content, author: { id: 'bot' } };
      messages.set(message.id, message); if (noticeFailure) throw new Error('send response lost'); return message; } };
  const client = { user: { id: 'bot' }, channels: { fetch: async (id: string) => { assert.equal(id, 'signups'); return channel; } } } as unknown as Client;
  const guild: any = { id: 'guild', roles: { cache: new Collection() }, members: { fetch: async (id: string) => ({
    id, guild, user: { id, bot: false }, roles: { cache: new Collection(id === 'staff' ? [['manager', {}]] : []) },
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
