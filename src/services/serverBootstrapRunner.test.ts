import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { Collection, type Guild } from 'discord.js';
import type { ManagedResourceStore } from '../storage/index.js';
import { runServerBootstrap, serverSetupErrorMessage } from './serverBootstrapRunner.js';

test('duplicate server roles explain the Discord fix without sending staff to a roster sheet', () => {
  const message = serverSetupErrorMessage('Role "Allfather" is ambiguous: 2 roles share that name in this guild. Resolve manually before running bootstrap.');
  assert.match(message, /2 Discord roles named “Allfather”/);
  assert.match(message, /Rename or remove.*in Discord/);
  assert.doesNotMatch(message, /League Teams|ambiguous|bootstrap/);
});

test('server setup can load before staff alert settings are configured', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    "await import('./src/services/serverBootstrapRunner.ts');"], {
    cwd: process.cwd(), env: { ...process.env, STAFF_OPS_CHANNEL_ID: '' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
});

test('server bootstrap dry-run awaits asynchronous storage without writing Discord or persistence', async () => {
  let reads = 0;
  const storage: ManagedResourceStore = {
    async getActiveManagedResourceByLogicalKey() {
      await Promise.resolve();
      reads += 1;
      return undefined;
    },
    async listManagedResourcesByDomain() {
      await Promise.resolve();
      reads += 1;
      return [];
    },
    async insertManagedResource() {
      throw new Error('dry-run must not insert managed resources');
    },
    async markManagedResourceObsolete() {
      throw new Error('dry-run must not retire managed resources');
    },
    async setManagedResourceParent() {
      throw new Error('dry-run must not move managed resources');
    },
    async markManagedResourcePurged() {
      throw new Error('dry-run must not purge managed resources');
    },
  };

  let discordCreates = 0;
  const guild = {
    id: 'guild-1',
    name: 'Test Guild',
    roles: {
      everyone: { id: 'everyone' },
      cache: new Collection(),
      fetch: async () => undefined,
      create: async () => {
        discordCreates += 1;
        throw new Error('dry-run must not create Discord roles');
      },
    },
    channels: {
      cache: new Collection(),
      fetch: async () => undefined,
      create: async () => {
        discordCreates += 1;
        throw new Error('dry-run must not create Discord channels');
      },
    },
  } as unknown as Guild;
  const log: string[] = [];

  await runServerBootstrap(storage, guild, { apply: false, deleteObsolete: false }, (line) => log.push(line));

  assert.ok(reads > 0);
  assert.equal(discordCreates, 0);
  assert.match(log.join('\n'), /Preview only/);
  assert.match(log.at(-1) ?? '', /Review the list above/);
  assert.match(log.at(-1) ?? '', /\/server bootstrap apply/);
  assert.match(log.at(-1) ?? '', /npm run guild:apply/);
});
