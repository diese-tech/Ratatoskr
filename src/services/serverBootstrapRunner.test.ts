import assert from 'node:assert/strict';
import test from 'node:test';
import { Collection, type Guild } from 'discord.js';
import type { ManagedResourceStore } from '../storage/index.js';
import { runServerBootstrap } from './serverBootstrapRunner.js';

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
  assert.match(log.join('\n'), /MODE: DRY RUN/);
  assert.match(log.at(-1) ?? '', /Review the plan above/);
});
