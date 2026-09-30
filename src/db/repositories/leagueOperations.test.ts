import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../client.js';
import {
  createLeagueTransaction,
  getLeagueTransaction,
  hasSuccessfulLeagueAudit,
  recordLeagueAudit,
  transitionLeagueTransaction,
} from './leagueOperations.js';

test('only a successful full audit opens the daily mutation gate', () => {
  const db = openDatabase(':memory:');
  recordLeagueAudit(db, { guildId: 'guild', auditDate: '2026-09-30', status: 'failed', issues: ['drift'] });
  assert.equal(hasSuccessfulLeagueAudit(db, 'guild', '2026-09-30'), false);
  recordLeagueAudit(db, { guildId: 'guild', auditDate: '2026-09-30', status: 'passed', issues: [] });
  assert.equal(hasSuccessfulLeagueAudit(db, 'guild', '2026-09-30'), true);
  assert.equal(hasSuccessfulLeagueAudit(db, 'guild', '2026-10-01'), false);
  db.close();
});

test('league transaction lifecycle is durable and transitions compare-and-swap', () => {
  const db = openDatabase(':memory:');
  createLeagueTransaction(db, {
    reference: 'YSL-TRX-1', guildId: 'guild', kind: 'trade', actorUserId: 'admin', payload: { players: ['one', 'two'] },
  });
  assert.equal(getLeagueTransaction(db, 'YSL-TRX-1')?.status, 'applying_discord');
  assert.equal(transitionLeagueTransaction(db, 'YSL-TRX-1', 'applying_discord', 'applying_sheets'), true);
  assert.equal(transitionLeagueTransaction(db, 'YSL-TRX-1', 'applying_discord', 'completed'), false);
  assert.equal(transitionLeagueTransaction(db, 'YSL-TRX-1', 'applying_sheets', 'announcement_pending'), true);
  assert.equal(transitionLeagueTransaction(db, 'YSL-TRX-1', 'announcement_pending', 'completed', { announcementId: 'message' }), true);
  assert.equal(getLeagueTransaction(db, 'YSL-TRX-1')?.announcementId, 'message');
  db.close();
});
