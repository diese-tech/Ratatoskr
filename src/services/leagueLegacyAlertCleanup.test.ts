import assert from 'node:assert/strict';
import test from 'node:test';
import { Collection } from 'discord.js';
import { openDatabase } from '../db/client.js';
import { getLegacyLeagueAlertCleanupCutoff, markLeagueAlertCleaned } from '../db/repositories/leagueOperations.js';
import { deleteLegacyResolvedLeagueAlerts } from './leagueAuditDiscord.js';

const alert = 'Ratatoskr could not finish **League roster audit repair**.\nReference: cfa7fa94-6775-4da3-8c92-ab664c7cceca';
function message(id: string, at: string, deleted: string[]) {
  return { id, author: { id: 'rat' }, content: alert, createdTimestamp: Date.parse(at), delete: async () => { deleted.push(id); } };
}

test('legacy cleanup scans full history once and later stops at its persisted successful cutoff', async () => {
  const db = openDatabase(':memory:');
  const deleted: string[] = [];
  const previous = '2026-10-05T12:00:00Z';
  const current = '2026-10-06T12:00:00Z';
  try {
    let requests = 0;
    const old = new Collection(Array.from({ length: 100 }, (_, i) => [String(i), message(String(i), '2026-10-04T12:00:00Z', deleted)] as const));
    const history = { fetch: async () => { requests++; return requests === 1 ? old : new Collection([['older', message('older', '2026-10-03T12:00:00Z', deleted)]]); } };
    await deleteLegacyResolvedLeagueAlerts(history, 'rat', previous);
    assert.equal(requests, 2);
    markLeagueAlertCleaned(db, 'g', `legacy-alerts-before:${previous}`);
    assert.equal(getLegacyLeagueAlertCleanupCutoff(db, 'g'), previous);
    assert.equal(getLegacyLeagueAlertCleanupCutoff(db, 'other'), undefined);
    requests = 0;
    deleted.length = 0;
    const adjacent = new Collection(Array.from({ length: 100 }, (_, i) => [String(i), message(String(i), i === 0 ? previous : '2026-10-04T12:00:00Z', deleted)] as const));
    await deleteLegacyResolvedLeagueAlerts({ fetch: async () => { requests++; return adjacent; } }, 'rat', current, getLegacyLeagueAlertCleanupCutoff(db, 'g'));
    assert.equal(requests, 1);
    assert.deepEqual(deleted, ['0']);
  } finally { db.close(); }
});
