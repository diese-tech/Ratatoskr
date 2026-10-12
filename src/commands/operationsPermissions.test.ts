import assert from 'node:assert/strict';
import test from 'node:test';
import { Collection } from 'discord.js';
import { LEGACY_YSL_VALKYRIE_ROLE_ID } from '../config/staff-role-ids.js';

Object.assign(process.env, { ROLE_ALLFATHER_ID: 'allfather', ROLE_AESIR_ID: 'aesir', DISCORD_TOKEN: 'test', DISCORD_CLIENT_ID: 'test', DISCORD_GUILD_ID: 'guild' });
delete process.env.ROLE_VALKYRIE_ID;
const { handleDivisionCommand } = await import('./division.js');
const { handleSeasonCommand } = await import('./season.js');
const { handleServerCommand } = await import('./server.js');
const { handleScoutCommand, handleScoutConfigRoleSelect, SCOUT_CONFIG_ROLES_CUSTOM_ID } = await import('./scout.js');
const { hasScoutDivisionManagementAccess } = await import('../services/scoutAuthorization.js');
const { hasAccess } = await import('../services/authorization.js');
const { openDatabase } = await import('../db/client.js');

test('Valkyrie has global Scout game access without structural ADMIN or division-specific roles', () => {
  const db = openDatabase(':memory:');
  try {
    const member = { roles: { cache: new Collection([[LEGACY_YSL_VALKYRIE_ROLE_ID, {}]]) }, guild: { id: 'guild', roles: { cache: new Collection() } } } as never;
    assert.equal(hasAccess(member, 'ADMIN'), false);
    for (const division of ['one', 'two'])
      assert.equal(hasScoutDivisionManagementAccess(db, member, undefined, { managerRoleId: `${division}-manager`, captainRoleId: `${division}-captain` }, hasAccess(member, 'OPERATIONS')), true);
  } finally { db.close(); }
});

test('Valkyrie is denied league structure and Scout configuration before storage or Discord mutations', async () => {
  for (const subcommand of ['add', 'archive', 'delete', 'create', 'close', 'apply', 'config', 'roles']) {
    const replies: string[] = [];
    const member = { roles: { cache: new Map([[LEGACY_YSL_VALKYRIE_ROLE_ID, {}]]) }, permissions: { has: () => false } };
    const interaction = { guildId: 'guild', guild: { id: 'guild', members: { fetch: async () => member } }, user: { id: 'staff' },
      customId: SCOUT_CONFIG_ROLES_CUSTOM_ID, options: { getString: () => 'Vanaheim', getSubcommand: () => subcommand },
      reply: async (value: { content: string }) => { replies.push(value.content); },
      deferReply: async () => assert.fail('Restricted command must not start work'),
      deferUpdate: async () => assert.fail('Restricted config must not start work') } as never;
    const storage = new Proxy({}, { get: () => assert.fail('Restricted command must not touch storage') }) as never;
    if (['add', 'archive', 'delete'].includes(subcommand)) await handleDivisionCommand(interaction, storage, {});
    else if (['create', 'close'].includes(subcommand)) await handleSeasonCommand(interaction, storage);
    else if (subcommand === 'apply') await handleServerCommand(interaction, storage);
    else if (subcommand === 'config') await handleScoutCommand(interaction, storage, storage, storage);
    else await handleScoutConfigRoleSelect(interaction, storage);
    assert.equal(replies.length, 1, subcommand);
    assert.match(replies[0]!, /permission/i);
  }
});
