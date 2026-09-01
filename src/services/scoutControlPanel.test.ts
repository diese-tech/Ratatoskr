import assert from 'node:assert/strict';
import test from 'node:test';
import type { Client } from 'discord.js';
import { closeDatabase, openDatabase } from '../db/client.js';
import { upsertDivision } from '../db/repositories/divisions.js';
import {
  createScoutSetup,
  getScoutSetupById,
  setScoutControlMessage,
  setScoutSetupSignupMessage,
  tryCreateInitialScoutRoster,
} from '../db/repositories/scoutSetups.js';
import type { ScoutSetup } from '../db/types.js';
import { SCOUT_ROLES, SCOUT_TEAMS } from '../domain/index.js';
import { renderScoutControlPanelPrompt, scoutControlPanelMarker } from './scoutControlPanel.js';
import { ensureScoutControlPanel } from './scoutControlPanel.js';

const setup = {
  id: 42,
  divisionDisplayName: 'Vanaheim',
  createdBy: 'captain-1',
  startAt: 2_000_000_000,
} as ScoutSetup;

test('roster-ready control panel identifies the setup, pings its creator, and exposes review plus cancellation', () => {
  const view = renderScoutControlPanelPrompt(setup);
  assert.match(view.content, /<@captain-1>/);
  assert.match(view.content, /Vanaheim/);
  assert.match(view.content, /setup #42/);
  assert.match(view.content, new RegExp(scoutControlPanelMarker(42)));
  assert.deepEqual(view.allowedMentions, { parse: [], users: ['captain-1'], roles: [] });
  assert.deepEqual(
    view.components[0]?.toJSON().components.map((component) => 'custom_id' in component ? component.custom_id : undefined),
    ['scout:review:42', 'scout:cancel:42:0'],
  );
});

test('a replacement control panel mentions the creator without notifying them again', () => {
  const view = renderScoutControlPanelPrompt(setup, false);
  assert.match(view.content, /<@captain-1>/);
  assert.deepEqual(view.allowedMentions, { parse: [], users: [], roles: [] });
});

test('a deleted stored control panel is recreated by CAS without pinging the creator twice', async () => {
  const db = openDatabase(':memory:');
  try {
    const division = upsertDivision(db, {
      guildId: 'guild', divisionKey: 'vanaheim', displayName: 'Vanaheim', roleId: 'division-role',
      managerRoleId: 'manager-role', captainRoleId: 'captain-role', categoryId: 'division-category',
    });
    const created = createScoutSetup(db, {
      guildId: 'guild', divisionId: division.id, divisionKey: division.divisionKey,
      divisionDisplayName: division.displayName, createdBy: 'captain-1', signupChannelId: 'signups',
      resultsChannelId: 'results', operationsChannelId: 'scout-ops', divisionRoleId: 'division-role',
      emojiByRole: { solo: 'solo', jungle: 'jungle', mid: 'mid', support: 'support', carry: 'carry' },
      startAt: 2_000_000_000, roleLimit: 2,
    });
    setScoutSetupSignupMessage(db, created.id, 'signup-message');
    const slots = SCOUT_ROLES.flatMap((role) =>
      SCOUT_TEAMS.map((team, index) => ({ team, role, userId: `${role}-${index}` })),
    );
    assert.equal(tryCreateInitialScoutRoster(db, created.id, slots), true);
    assert.equal(setScoutControlMessage(db, created.id, 'deleted-control'), true);

    let sentPayload: ReturnType<typeof renderScoutControlPanelPrompt> | undefined;
    const channel = {
      isTextBased: () => true,
      isSendable: () => true,
      messages: {
        fetch: async (input: string | { limit: number }) =>
          typeof input === 'string' ? undefined : { size: 0, find: () => undefined, last: () => undefined },
      },
      send: async (payload: ReturnType<typeof renderScoutControlPanelPrompt>) => {
        sentPayload = payload;
        return { id: 'replacement-control', delete: async () => undefined };
      },
    };
    const client = {
      user: { id: 'ratatoskr' },
      channels: { fetch: async () => channel },
    } as unknown as Client;

    assert.equal(await ensureScoutControlPanel(client, db, created.id), 'created');
    assert.equal(getScoutSetupById(db, created.id)?.controlMessageId, 'replacement-control');
    assert.deepEqual(sentPayload?.allowedMentions.users, []);
  } finally {
    closeDatabase(db);
  }
});
