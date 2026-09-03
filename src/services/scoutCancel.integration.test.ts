import assert from 'node:assert/strict';
import test from 'node:test';
import { Collection, MessageFlags } from 'discord.js';
import { openDatabase, upsertDivision, createScoutSetup, setScoutSetupSignupMessage, getScoutSetupById, setScoutOperationsChannel } from '../db/index.js';
import { handleScoutCancelCommand, handleScoutCancelSelect, handleScoutCancelButton } from './scoutCancel.js';

process.env.ROLE_ALLFATHER_ID = 'admin';
process.env.ROLE_AESIR_ID = 'aesir';

function fixture() {
  const db = openDatabase(':memory:');
  setScoutOperationsChannel(db, 'guild', 'ops-category', 'ops');
  const divisions = ['vanaheim', 'alfheim'].map((key) => upsertDivision(db, { guildId: 'guild', divisionKey: key,
    displayName: key, roleId: key, managerRoleId: `${key}-manager`, captainRoleId: `${key}-captain`, categoryId: key }));
  const roles = new Collection<string, any>([['vanaheim-manager', {}]]);
  const guild: any = { id: 'guild', roles: { cache: new Collection() }, members: { fetch: async () => ({ guild, roles: { cache: roles } }) } };
  const replies: any[] = [];
  const edits: any[] = [];
  const client: any = { channels: { fetch: async () => ({ isTextBased: () => true, messages: { fetch: async () => ({
    edit: async (payload: any) => edits.push(payload), reactions: { removeAll: async () => undefined },
  }) } }) } };
  function create(index = 0) {
    const division = divisions[index]!;
    const setup = createScoutSetup(db, { guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'coordinator', signupChannelId: `signup-${index}`, resultsChannelId: `signup-${index}`,
      operationsChannelId: 'ops', divisionRoleId: division.roleId!, startAt: 2_000_000_000, roleLimit: 2,
      emojiByRole: { solo: 'solo', jungle: 'jungle', mid: 'mid', support: 'support', carry: 'carry' } });
    setScoutSetupSignupMessage(db, setup.id, `message-${setup.id}`);
    return setup;
  }
  function interaction(customId = '', values: string[] = []): any {
    let acknowledged = false;
    return { guild, guildId: 'guild', channelId: 'ops', client, user: { id: 'coordinator' }, customId, values,
      options: { getString: () => { throw new Error('No division selection should be requested'); } },
      deferReply: async (payload: any) => { assert.equal(acknowledged, false); acknowledged = true; assert.equal(payload.flags, MessageFlags.Ephemeral); },
      deferUpdate: async () => { assert.equal(acknowledged, false); acknowledged = true; },
      editReply: async (payload: any) => { assert.equal(acknowledged, true); replies.push(payload); },
    };
  }
  return { db, roles, create, replies, edits, interaction };
}
const options = (payload: any) => payload.components[0].toJSON().components[0].options;

test('cancel opens an authorized posting list directly for zero, one and multiple divisions', async () => {
  const f = fixture();
  try {
    await handleScoutCancelCommand(f.interaction(), f.db);
    assert.match(f.replies.at(-1).content, /no active scout postings you can cancel/i);
    const one = f.create();
    const other = f.create(1);
    await handleScoutCancelCommand(f.interaction(), f.db);
    assert.deepEqual(options(f.replies.at(-1)).map((o: any) => o.value), [`${one.id}:0`]);
    assert.match(options(f.replies.at(-1))[0].label, /vanaheim/);
    f.roles.set('admin', {});
    await handleScoutCancelCommand(f.interaction(), f.db);
    assert.deepEqual(options(f.replies.at(-1)).map((o: any) => o.value), [`${one.id}:0`, `${other.id}:0`]);
    assert.equal(getScoutSetupById(f.db, one.id)?.status, 'open', 'listing never cancels');
  } finally { f.db.close(); }
});

test('cancel pagination exposes every posting and excludes terminal and posting states', async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 27; i++) f.create();
    for (const status of ['posting', 'published', 'cancelled']) {
      const setup = f.create();
      f.db.prepare('UPDATE scout_setups SET status = ? WHERE id = ?').run(status, setup.id);
    }
    await handleScoutCancelCommand(f.interaction(), f.db);
    assert.equal(options(f.replies.at(-1)).length, 25);
    await handleScoutCancelButton(f.interaction('scout:cancelpage:1'), f.db);
    assert.equal(options(f.replies.at(-1)).length, 2);
    assert.match(f.replies.at(-1).content, /Page 2\/2/);
  } finally { f.db.close(); }
});

test('selection and confirmation recheck access, setup versions and publication state', async () => {
  const f = fixture();
  try {
    const setup = f.create();
    const select = () => handleScoutCancelSelect(f.interaction('scout:cancelpick:all', [`${setup.id}:0`]), f.db);
    await select();
    assert.match(f.replies.at(-1).content, /Confirm|Cancel/);
    assert.match(f.replies.at(-1).content, /discord.com\/channels/);
    assert.equal(getScoutSetupById(f.db, setup.id)?.status, 'open');
    f.roles.clear();
    await handleScoutCancelButton(f.interaction(`scout:cancelconfirm:${setup.id}:0`), f.db);
    assert.match(f.replies.at(-1).content, /permission/);
    assert.equal(getScoutSetupById(f.db, setup.id)?.status, 'open');
    f.roles.set('vanaheim-manager', {});
    f.db.prepare('UPDATE scout_setups SET version = 1 WHERE id = ?').run(setup.id);
    await select();
    assert.match(f.replies.at(-1).content, /changed/);
    await handleScoutCancelButton(f.interaction(`scout:cancelconfirm:${setup.id}:0`), f.db);
    assert.match(f.replies.at(-1).content, /stale/);
    f.db.prepare("UPDATE scout_setups SET status = 'published' WHERE id = ?").run(setup.id);
    await handleScoutCancelButton(f.interaction(`scout:cancelconfirm:${setup.id}:1`), f.db);
    assert.match(f.replies.at(-1).content, /cannot be cancelled/);
    assert.equal(f.edits.length, 0);
  } finally { f.db.close(); }
});

test('legacy controls, dismissal and confirmed cancellation retain the existing post-repair flow', async () => {
  const f = fixture();
  try {
    const setup = f.create();
    await handleScoutCancelSelect(f.interaction(`scout:cancelpick:${setup.divisionId}`, [String(setup.id)]), f.db);
    await handleScoutCancelButton(f.interaction(`scout:cancelkeep:${setup.id}:0`), f.db);
    assert.equal(getScoutSetupById(f.db, setup.id)?.status, 'open');
    await handleScoutCancelButton(f.interaction(`scout:cancelconfirm:${setup.id}:0`), f.db);
    assert.equal(getScoutSetupById(f.db, setup.id)?.status, 'cancelled');
    assert.equal(getScoutSetupById(f.db, setup.id)?.signupPostReconciled, true);
    assert.equal(f.edits.length, 1);
  } finally { f.db.close(); }
});
