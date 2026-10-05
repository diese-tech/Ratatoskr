import assert from 'node:assert/strict';
import test from 'node:test';
import { LeagueMutationValidationError, type LeagueSnapshot } from '../domain/leagueOperations.js';
import { buildLeagueAuditSheetRepair, buildManagedRoleRepair, executeLeagueAuditRepair } from './leagueAuditResolution.js';
import { humanizeLeagueAuditIssues } from './leagueAuditPresentation.js';
import { auditLeagueRoster } from '../domain/leagueOperations.js';
import { openDatabase } from '../db/client.js';
import { getLeagueAuditRepair } from '../db/repositories/leagueAuditRepairs.js';
import { getLeagueReconciliationTicket } from '../db/repositories/leagueOperations.js';

const playerId = '143011986349883392';

function snapshot(): LeagueSnapshot {
  return {
    teams: [{ teamKey: 'a_vd', division: 'Vanaheim', franchise: 'A', teamRole: 'A VD', teamRoleId: 'team-a', divisionRoleId: 'division-v', active: true }],
    rosters: [{ sheetRow: 6, division: 'Vanaheim', franchise: 'A', teamRoleId: 'team-a', team: 'A VD', discordId: playerId, player: 'Old Name', rosterStatus: 'Player' }],
    names: [{ sheetRow: 6, discordId: playerId, currentLeagueName: 'Current Name', knownName: 'Current Name', nameStatus: 'Current Discord Name', division: 'Vanaheim', franchise: 'A', leagueStatus: 'Player' }],
    discordMembers: [{ discordId: playerId, displayName: 'Current Name', roleIds: ['wrong-team', 'division-a', 'free-agent'] }],
    publicRosters: { Vanaheim: { teams: { A: ['Current Name'] }, freeAgents: [] } },
    freeAgentRoleId: 'free-agent',
  };
}

test('Discord-name repair updates every managed name while preserving the prior league name', () => {
  const current = snapshot();
  current.discordMembers[0]!.displayName = 'Discord Display';

  const plan = buildLeagueAuditSheetRepair(
    current,
    `Managed player names for ${playerId} do not match the current Discord display name.`,
    'use-discord-name',
  );

  assert.equal(plan.rosters[0]?.player, 'Discord Display');
  assert.equal(plan.nameUpdates[0]?.currentLeagueName, 'Discord Display');
  assert.ok(plan.nameUpdates.some((row) => row.discordId === playerId && row.knownName === 'Current Name'));
  assert.deepEqual(plan.publicChanges, [{
    division: 'Vanaheim', area: 'team', group: 'A', from: 'Current Name', to: 'Discord Display',
  }]);
});

test('using Player Name History repairs Current Rosters without overwriting an already-correct public roster', () => {
  const plan = buildLeagueAuditSheetRepair(
    snapshot(),
    `Current Rosters player name for ${playerId} does not match its Current League Name.`,
    'use-league-name',
  );

  assert.equal(plan.rosters[0]?.player, 'Current Name');
  assert.equal(plan.nameUpdates[0]?.currentLeagueName, 'Current Name');
  assert.deepEqual(plan.publicChanges, []);
});

test('using the roster name performs a history-preserving official rename', () => {
  const current = snapshot();
  current.names[0]!.knownName = 'Discord Display';
  const plan = buildLeagueAuditSheetRepair(
    current,
    `Current Rosters player name for ${playerId} does not match its Current League Name.`,
    'use-roster-name',
  );

  assert.equal(plan.nameUpdates[0]?.currentLeagueName, 'Old Name');
  assert.equal(plan.nameHistoryAppend?.knownName, 'Current Name');
  assert.deepEqual(plan.publicChanges, [{ division: 'Vanaheim', area: 'team', group: 'A', from: 'Current Name', to: 'Old Name' }]);
});

test('public roster repair makes only the exact managed block match canonical league names', () => {
  const current = snapshot();
  current.rosters[0]!.player = 'Current Name';
  current.publicRosters.Vanaheim!.teams.A = ['Unexpected'];
  const plan = buildLeagueAuditSheetRepair(current, 'Vanaheim A public roster does not match Current Rosters.', 'sync-public-roster');

  assert.deepEqual(plan.publicChanges, [{ division: 'Vanaheim', area: 'team', group: 'A', from: 'Unexpected', to: 'Current Name' }]);
  assert.equal(plan.rosters[0]?.player, 'Current Name');
});

test('public roster repair waits for conflicting player names to be resolved first', () => {
  const current = snapshot();
  current.publicRosters.Vanaheim!.teams.A = ['Unexpected'];
  assert.throws(
    () => buildLeagueAuditSheetRepair(current, 'Vanaheim A public roster does not match Current Rosters.', 'sync-public-roster'),
    /resolve the player-name issue first/i,
  );
});

test('an absent free agent can be marked inactive and removed from only their division list', () => {
  const current = snapshot();
  current.rosters = [];
  current.names[0]!.franchise = '';
  current.names[0]!.leagueStatus = 'Free Agent';
  current.discordMembers = [];
  current.publicRosters.Vanaheim!.teams.A = [];
  current.publicRosters.Vanaheim!.freeAgents = ['Current Name'];

  const plan = buildLeagueAuditSheetRepair(
    current,
    `Current free agent ${playerId} is not in the Discord member snapshot.`,
    'mark-inactive',
  );

  assert.equal(plan.nameUpdates[0]?.leagueStatus, 'Inactive');
  assert.deepEqual(plan.publicChanges, [{ division: 'Vanaheim', area: 'free-agent', group: 'Free Agents', from: 'Current Name', to: '' }]);
});

test('managed-role repair removes every conflicting league role and adds only the sheet-backed assignment', () => {
  const current = snapshot();
  current.teams.push({ teamKey: 'b_ad', division: 'Alfheim', franchise: 'B', teamRole: 'B AD', teamRoleId: 'wrong-team', divisionRoleId: 'division-a', active: true });

  assert.deepEqual(buildManagedRoleRepair(current, playerId), {
    discordId: playerId,
    remove: ['wrong-team', 'division-a', 'free-agent'],
    add: ['team-a', 'division-v'],
  });
});

test('managed-role repair refuses ambiguous roster or current-name authority', () => {
  const current = snapshot();
  current.names.push({ ...current.names[0]!, sheetRow: 7 });
  assert.throws(() => buildManagedRoleRepair(current, playerId), /exactly one current name/i);
});

test('confirmed sheet repair rechecks the exact finding before applying and returns for a fresh audit', async () => {
  const current = snapshot();
  const finding = humanizeLeagueAuditIssues(current, auditLeagueRoster(current))[0]!;
  let appliedPlayer: string | undefined;
  let approvalNote: string | undefined;
  const db = openDatabase(':memory:');
  try {
    const result = await executeLeagueAuditRepair({
      db, operationScope: {}, guildId: 'guild', auditReference: 'YSL-AUD-1234',
      actorUserId: 'admin', actorName: 'Admin', now: new Date('2026-10-04T12:00:00Z'),
      expectedFinding: finding, action: 'use-discord-name', freeAgentRoleId: 'free-agent',
      members: { getMembers: async () => current.discordMembers },
      sheets: {
        load: async () => ({ snapshot: current, sources: {} as never }),
        prepare: (_loaded, plan) => ({ publicUpdates: plan.publicChanges as never }),
        apply: async (_loaded, plan, record) => {
          appliedPlayer = plan.rosters[0]?.player;
          approvalNote = record.approvalNote;
        },
      },
      discord: {
        validateDisplayName: async () => undefined,
        reconcileManagedRoles: async () => { throw new Error('not expected'); },
      },
    });

    assert.equal(appliedPlayer, 'Current Name');
    assert.equal(approvalNote, 'Ratatoskr approved roster audit repair');
    assert.match(result.reference, /^YSL-AUD-FIX-/);
    const repair = getLeagueAuditRepair(db, result.reference);
    assert.equal(repair?.status, 'completed');
    assert.equal(repair?.auditReference, 'YSL-AUD-1234');
    assert.equal(repair?.actorUserId, 'admin');
  } finally { db.close(); }
});

test('Discord-name repair stops before writing if a forced name recheck finds a newer value', async () => {
  const current = snapshot();
  const finding = humanizeLeagueAuditIssues(current, auditLeagueRoster(current))[0]!;
  let sheetWrites = 0;
  const db = openDatabase(':memory:');
  try {
    await assert.rejects(() => executeLeagueAuditRepair({
      db, operationScope: {}, guildId: 'guild', auditReference: 'YSL-AUD-1234',
      actorUserId: 'admin', actorName: 'Admin', now: new Date('2026-10-04T12:00:00Z'),
      expectedFinding: finding, action: 'use-discord-name', freeAgentRoleId: 'free-agent',
      members: { getMembers: async () => current.discordMembers },
      sheets: {
        load: async () => ({ snapshot: current, sources: {} as never }),
        prepare: () => ({ publicUpdates: [] }),
        apply: async () => { sheetWrites += 1; },
      },
      discord: {
        validateDisplayName: async () => {
          throw new LeagueMutationValidationError(
            'That player’s Discord display name changed after the audit was loaded. Review the newest audit card; no changes were made.',
          );
        },
        reconcileManagedRoles: async () => undefined,
      },
    }), /display name changed.*no changes were made/i);

    assert.equal(sheetWrites, 0);
    const repair = db.prepare('SELECT status FROM league_audit_repairs').get() as { status: string };
    assert.equal(repair.status, 'failed');
  } finally { db.close(); }
});

test('confirmed repair refuses stale findings without writing either system', async () => {
  const current = snapshot();
  let writes = 0;
  const db = openDatabase(':memory:');
  try {
    await assert.rejects(() => executeLeagueAuditRepair({
      db, operationScope: {}, guildId: 'guild', auditReference: 'YSL-AUD-1234',
      actorUserId: 'admin', actorName: 'Admin', now: new Date('2026-10-04T12:00:00Z'),
      expectedFinding: 'An old finding', action: 'use-league-name', freeAgentRoleId: 'free-agent',
      members: { getMembers: async () => current.discordMembers },
      sheets: {
        load: async () => ({ snapshot: current, sources: {} as never }), prepare: () => ({ publicUpdates: [] }),
        apply: async () => { writes += 1; },
      },
      discord: { validateDisplayName: async () => undefined, reconcileManagedRoles: async () => { writes += 1; } },
    }), /changed since this review page opened/i);
    assert.equal(writes, 0);
    const count = db.prepare('SELECT COUNT(*) AS count FROM league_audit_repairs').get() as { count: number };
    assert.equal(count.count, 0);
  } finally { db.close(); }
});

test('a possibly partial repair is durably marked for staff reconciliation', async () => {
  const current = snapshot();
  const finding = humanizeLeagueAuditIssues(current, auditLeagueRoster(current))[0]!;
  const db = openDatabase(':memory:');
  try {
    let reference: string | undefined;
    await assert.rejects(async () => {
      try {
        await executeLeagueAuditRepair({
          db, operationScope: {}, guildId: 'guild', auditReference: 'YSL-AUD-1234',
          actorUserId: 'admin', actorName: 'Admin', now: new Date('2026-10-04T12:00:00Z'),
          expectedFinding: finding, action: 'use-discord-name', freeAgentRoleId: 'free-agent',
          members: { getMembers: async () => current.discordMembers },
          sheets: {
            load: async () => ({ snapshot: current, sources: {} as never }), prepare: () => ({ publicUpdates: [] }),
            apply: async () => { throw new Error('Public roster verification failed.'); },
          },
          discord: { validateDisplayName: async () => undefined, reconcileManagedRoles: async () => undefined },
        });
      } catch (error) {
        reference = (error as { reference?: string }).reference;
        assert.equal((error as { leagueReconciliationTicket?: boolean }).leagueReconciliationTicket, true);
        throw error;
      }
    }, /Public roster verification failed/);
    assert.ok(reference);
    assert.equal(getLeagueAuditRepair(db, reference)?.status, 'reconciliation_required');
    assert.equal(getLeagueReconciliationTicket(db, reference)?.status, 'open');
  } finally { db.close(); }
});

test('a late role preflight change records a safe failure without opening reconciliation', async () => {
  const current = snapshot();
  current.rosters[0]!.player = 'Current Name';
  current.teams.push({
    teamKey: 'b_ad', division: 'Alfheim', franchise: 'B', teamRole: 'B AD',
    teamRoleId: 'wrong-team', divisionRoleId: 'division-a', active: true,
  });
  const finding = humanizeLeagueAuditIssues(current, auditLeagueRoster(current))
    .find((issue) => issue.includes('Discord team'))!;
  const db = openDatabase(':memory:');
  try {
    await assert.rejects(() => executeLeagueAuditRepair({
      db, operationScope: {}, guildId: 'guild', auditReference: 'YSL-AUD-1234',
      actorUserId: 'admin', actorName: 'Admin', now: new Date('2026-10-04T12:00:00Z'),
      expectedFinding: finding, action: 'repair-roles', freeAgentRoleId: 'free-agent',
      members: { getMembers: async () => current.discordMembers },
      sheets: {
        load: async () => ({ snapshot: current, sources: {} as never }), prepare: () => ({ publicUpdates: [] }),
        apply: async () => { throw new Error('not expected'); },
      },
      discord: {
        validateDisplayName: async () => undefined,
        reconcileManagedRoles: async () => {
          throw new LeagueMutationValidationError('Managed roles changed; no roles were changed.');
        },
      },
    }), /Managed roles changed/);
    const repair = db.prepare('SELECT reference FROM league_audit_repairs').get() as { reference: string };
    assert.equal(getLeagueAuditRepair(db, repair.reference)?.status, 'failed');
    assert.equal(getLeagueReconciliationTicket(db, repair.reference), undefined);
  } finally { db.close(); }
});
