import assert from 'node:assert/strict';
import test from 'node:test';
import { Collection, type Guild } from 'discord.js';
import { openDatabase, insertManagedResource } from '../db/index.js';
import { yslGuildStructure } from '../config/guild-structure.js';
import { resolveFranchiseRepresentativeId, FRANCHISE_REPRESENTATIVE_KEY } from './scoutRoleIdentity.js';
import { tryAcquireDivisionOperation } from './divisionOperation.js';

test('franchise role is provisioned, rejects ambiguity, and retains managed identity after rename', () => {
  const db = openDatabase(':memory:');
  const roles = new Collection<string, {id: string; name: string}>([
    ['rep', {id: 'rep', name: 'Franchise Representative'}],
  ]);
  const guild = { id: 'guild', roles: { cache: roles } } as unknown as Guild;
  try {
    assert.equal(yslGuildStructure.roles.filter((r) => r.key === 'franchise_representative').length, 1);
    assert.equal(resolveFranchiseRepresentativeId(db, guild), 'rep');
    roles.set('duplicate', { id: 'duplicate', name: 'Franchise Representative' });
    assert.throws(() => resolveFranchiseRepresentativeId(db, guild), /ambiguous/);
    insertManagedResource(db, { guildId: 'guild', discordResourceId: 'rep', resourceType: 'role',
      scaffoldDomain: 'server', logicalKey: FRANCHISE_REPRESENTATIVE_KEY });
    roles.get('rep')!.name = 'Renamed representative';
    assert.equal(resolveFranchiseRepresentativeId(db, guild), 'rep');
    roles.delete('rep');
    assert.equal(resolveFranchiseRepresentativeId(db, guild), null, 'a missing managed role must not grant access via another name match');
  } finally { db.close(); }
});

test('division create/teardown guard rejects overlap while other divisions can proceed', async () => {
  const db = openDatabase(':memory:');
  try {
    const release = tryAcquireDivisionOperation(db, 'guild', 'vanaheim')!;
    await Promise.resolve(); // Real handlers hold this guard across Discord awaits.
    assert.equal(tryAcquireDivisionOperation(db, 'guild', 'vanaheim'), undefined);
    const other = tryAcquireDivisionOperation(db, 'guild', 'alfheim');
    assert.ok(other);
    other();
    release();
    const retry = tryAcquireDivisionOperation(db, 'guild', 'vanaheim');
    assert.ok(retry);
    retry();
  } finally { db.close(); }
});
