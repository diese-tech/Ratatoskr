import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../db/client.js';
import {
  createLeagueAuditRepair,
  getLeagueAuditRepair,
  markLeagueAuditRepairReconciliationRequired,
} from '../db/repositories/leagueAuditRepairs.js';
import {
  createOrGetLeagueReconciliationTicket,
  getLeagueReconciliationTicket,
  markLeagueReconciliationTicketAlerted,
  listResolvedLeagueAlertReferences,
} from '../db/repositories/leagueOperations.js';
import { previewLeagueRepairRecovery, reconcileLeagueRepairRecord } from './leagueRepairRecovery.js';
import { cleanLeagueSnapshot } from './leagueOpsFixtures.test-support.js';
import { isLegacyResolvedLeagueAlertMessage } from './leagueAuditDiscord.js';

function fixture() {
  const db = openDatabase(':memory:');
  const snapshot = cleanLeagueSnapshot();
  let reads = 0;
  let unavailable = false;
  createLeagueAuditRepair(db, {
    reference: 'old-repair',
    guildId: 'g',
    actorUserId: 'old-admin',
    auditReference: 'old-audit',
    finding: 'Old player-name drift',
    action: 'use-discord-name',
  });
  markLeagueAuditRepairReconciliationRequired(db, 'old-repair', 'Interrupted sheet write');
  createOrGetLeagueReconciliationTicket(db, {
    reference: 'old-repair',
    guildId: 'g',
    actorUserId: 'old-admin',
    fingerprint: 'old',
    summary: 'Old repair may be partial',
  });
  markLeagueReconciliationTicketAlerted(db, 'old-repair');
  const input = {
    db,
    operationScope: db,
    guildId: 'g',
    freeAgentRoleId: 'free',
    members: { getMembers: async () => snapshot.discordMembers },
    sheets: {
      load: async () => {
        reads++;
        if (unavailable) throw Error('Sheets unavailable');
        return { snapshot, sources: {} as never };
      },
    },
  };
  return {
    db,
    input,
    snapshot,
    reads: () => reads,
    fail: () => {
      unavailable = true;
    },
  };
}

test('explicit reconciliation rechecks fresh surfaces, preserves historical ambiguity, and closes its alert record idempotently', async () => {
  const f = fixture();
  try {
    const preview = await previewLeagueRepairRecovery(f.input, 'old-repair');
    assert.deepEqual(preview.findings, []);
    assert.equal(getLeagueAuditRepair(f.db, 'old-repair')!.status, 'reconciliation_required');
    await reconcileLeagueRepairRecord({
      ...f.input,
      reference: 'old-repair',
      expectedFingerprint: preview.fingerprint,
      actorUserId: 'admin',
    });
    assert.equal(f.reads(), 2);
    assert.equal(getLeagueAuditRepair(f.db, 'old-repair')!.status, 'failed');
    assert.match(getLeagueAuditRepair(f.db, 'old-repair')!.errorMessage!, /Manually reconciled.*No mutation replayed/);
    assert.equal(getLeagueReconciliationTicket(f.db, 'old-repair')!.status, 'resolved');
    assert.deepEqual(listResolvedLeagueAlertReferences(f.db, 'g'), ['old-repair']);
    await reconcileLeagueRepairRecord({
      ...f.input,
      reference: 'old-repair',
      expectedFingerprint: preview.fingerprint,
      actorUserId: 'admin',
    });
    assert.equal((f.db.prepare('SELECT count(*) n FROM league_repair_resolutions').get() as { n: number }).n, 1);
  } finally {
    f.db.close();
  }
});

test('new drift or unavailable Sheets cannot close an interrupted repair', async () => {
  for (const change of ['drift', 'unavailable']) {
    const f = fixture();
    try {
      const preview = await previewLeagueRepairRecovery(f.input, 'old-repair');
      if (change === 'drift') f.snapshot.discordMembers[0]!.displayName = 'Changed';
      else f.fail();
      await assert.rejects(
        reconcileLeagueRepairRecord({
          ...f.input,
          reference: 'old-repair',
          expectedFingerprint: preview.fingerprint,
          actorUserId: 'admin',
        }),
      );
      assert.equal(getLeagueAuditRepair(f.db, 'old-repair')!.status, 'reconciliation_required');
      assert.equal(getLeagueReconciliationTicket(f.db, 'old-repair')!.status, 'open');
      assert.equal((f.db.prepare('SELECT count(*) n FROM league_repair_resolutions').get() as { n: number }).n, 0);
    } finally {
      f.db.close();
    }
  }
});

test('a recovery preview reports fresh Discord-name drift and rejects cross-guild references', async () => {
  const f = fixture();
  try {
    f.snapshot.discordMembers[0]!.displayName = 'Changed';
    const preview = await previewLeagueRepairRecovery(f.input, 'old-repair');
    assert.ok(preview.findings.some((finding) => finding.includes('Discord name now:')));
    await assert.rejects(
      reconcileLeagueRepairRecord({
        ...f.input,
        reference: 'old-repair',
        expectedFingerprint: preview.fingerprint,
        actorUserId: 'admin',
      }),
    );
    await assert.rejects(previewLeagueRepairRecovery({ ...f.input, guildId: 'other' }, 'old-repair'));
  } finally {
    f.db.close();
  }
});

test('legacy UUID cleanup only selects old bot-owned league repair/review alerts', () => {
  const cutoff = '2026-10-05T20:00:00Z';
  const message = {
    author: { id: 'rat' },
    createdTimestamp: Date.parse('2026-10-04T20:00:00Z'),
    content:
      'Ratatoskr could not finish **League roster audit repair**.\nError code: LEAGUE_SHEET_MISSING_DISCORD_ID\nReference: cfa7fa94-6775-4da3-8c92-ab664c7cceca',
  };
  assert.equal(isLegacyResolvedLeagueAlertMessage(message, 'rat', cutoff), true);
  assert.equal(isLegacyResolvedLeagueAlertMessage({ ...message, author: { id: 'human' } }, 'rat', cutoff), false);
  assert.equal(
    isLegacyResolvedLeagueAlertMessage({ ...message, createdTimestamp: Date.parse(cutoff) + 1 }, 'rat', cutoff),
    false,
  );
  assert.equal(
    isLegacyResolvedLeagueAlertMessage(
      { ...message, content: message.content.replace('League roster audit repair', 'Scout repair') },
      'rat',
      cutoff,
    ),
    false,
  );
  assert.equal(
    isLegacyResolvedLeagueAlertMessage(
      { ...message, content: message.content.replace('cfa7fa94-6775-4da3-8c92-ab664c7cceca', 'YSL-AUD-FIX-12345678') },
      'rat',
      cutoff,
    ),
    false,
  );
});
