import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../client.js';
import {
  completeLeagueAuditRepair,
  createLeagueAuditRepair,
  failLeagueAuditRepair,
  getLeagueAuditRepair,
  markLeagueAuditRepairReconciliationRequired,
} from './leagueAuditRepairs.js';

test('league audit repairs durably record the reviewed audit, administrator, action, and completion', () => {
  const db = openDatabase(':memory:');
  try {
    createLeagueAuditRepair(db, {
      reference: 'YSL-AUD-FIX-1234', guildId: 'guild', auditReference: 'YSL-AUD-1234',
      actorUserId: 'admin', finding: 'A human-readable issue.', action: 'repair-roles',
    });
    assert.deepEqual(getLeagueAuditRepair(db, 'YSL-AUD-FIX-1234'), {
      reference: 'YSL-AUD-FIX-1234', guildId: 'guild', auditReference: 'YSL-AUD-1234',
      actorUserId: 'admin', finding: 'A human-readable issue.', action: 'repair-roles',
      status: 'applying', errorMessage: null,
    });
    assert.equal(completeLeagueAuditRepair(db, 'YSL-AUD-FIX-1234'), true);
    assert.equal(getLeagueAuditRepair(db, 'YSL-AUD-FIX-1234')?.status, 'completed');
  } finally { db.close(); }
});

test('possibly partial league audit repairs retain the exact reconciliation reason', () => {
  const db = openDatabase(':memory:');
  try {
    createLeagueAuditRepair(db, {
      reference: 'YSL-AUD-FIX-5678', guildId: 'guild', auditReference: 'YSL-AUD-1234',
      actorUserId: 'admin', finding: 'A human-readable issue.', action: 'sync-public-roster',
    });
    markLeagueAuditRepairReconciliationRequired(db, 'YSL-AUD-FIX-5678', 'Public roster verification failed.');
    const repair = getLeagueAuditRepair(db, 'YSL-AUD-FIX-5678');
    assert.equal(repair?.status, 'reconciliation_required');
    assert.equal(repair?.errorMessage, 'Public roster verification failed.');
  } finally { db.close(); }
});

test('safe preflight failures are retained without entering startup reconciliation', () => {
  const db = openDatabase(':memory:');
  try {
    createLeagueAuditRepair(db, {
      reference: 'YSL-AUD-FIX-SAFE', guildId: 'guild', auditReference: 'YSL-AUD-1234',
      actorUserId: 'admin', finding: 'A role changed.', action: 'repair-roles',
    });
    assert.equal(failLeagueAuditRepair(db, 'YSL-AUD-FIX-SAFE', 'No changes were made.'), true);
    assert.equal(getLeagueAuditRepair(db, 'YSL-AUD-FIX-SAFE')?.status, 'failed');
  } finally { db.close(); }
});
