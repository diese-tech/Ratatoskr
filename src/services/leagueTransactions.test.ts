import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDeparturePlan, buildDiscordRenamePlan, buildDropPlan, buildRenamePlan, buildSelfDropPlan, buildTradePlan, LeagueMutationValidationError, type LeagueSnapshot } from '../domain/leagueOperations.js';
import { openDatabase } from '../db/client.js';
import {
  createLeagueTransaction,
  getLeagueReconciliationTicket,
  getLeagueTransaction,
  hasSuccessfulLeagueAudit,
  recordLeagueAudit,
  resolveOpenLeagueReconciliationTickets,
  transitionLeagueTransaction,
} from '../db/repositories/leagueOperations.js';
import { LeagueSheetDriftError, LeagueSheetReconciliationRequiredError } from './leagueSheets.js';
import { createLeagueAuditRepair, getLeagueAuditRepair } from '../db/repositories/leagueAuditRepairs.js';
import {
  buildLeagueAnnouncement,
  executeLeagueTransaction,
  leagueTransactionPlanFingerprint,
  LeagueTransactionPreviewChangedError,
  reconcilePendingLeagueTransactions,
} from './leagueTransactions.js';

function snapshot(): LeagueSnapshot {
  return {
    teams: [
      { teamKey: 'Vanaheim|A', franchise: 'A', division: 'Vanaheim', teamRoleId: 'team-a', teamRole: 'A VD', divisionRoleId: 'division', active: true },
      { teamKey: 'Vanaheim|B', franchise: 'B', division: 'Vanaheim', teamRoleId: 'team-b', teamRole: 'B VD', divisionRoleId: 'division', active: true },
    ],
    rosters: [
      { sheetRow: 6, division: 'Vanaheim', franchise: 'A', teamRoleId: 'team-a', team: 'A VD', discordId: 'one', player: 'One', rosterStatus: 'Captain' },
      { sheetRow: 7, division: 'Vanaheim', franchise: 'B', teamRoleId: 'team-b', team: 'B VD', discordId: 'two', player: 'Two', rosterStatus: 'Player' },
    ],
    names: [
      { sheetRow: 6, discordId: 'one', currentLeagueName: 'One', knownName: 'One', nameStatus: 'Current Discord Name', division: 'Vanaheim', franchise: 'A', leagueStatus: 'Captain' },
      { sheetRow: 7, discordId: 'two', currentLeagueName: 'Two', knownName: 'Two', nameStatus: 'Current Discord Name', division: 'Vanaheim', franchise: 'B', leagueStatus: 'Player' },
      { sheetRow: 8, discordId: 'free', currentLeagueName: 'Free', knownName: 'Free', nameStatus: 'Current Discord Name', division: 'Vanaheim', franchise: '', leagueStatus: 'Free Agent' },
    ],
    discordMembers: [
      { discordId: 'one', displayName: 'One', roleIds: ['team-a', 'division'] },
      { discordId: 'two', displayName: 'Two', roleIds: ['team-b', 'division'] },
      { discordId: 'free', displayName: 'Free', roleIds: ['free-agent', 'division'] },
    ],
    publicRosters: { Vanaheim: { teams: { A: ['One'], B: ['Two'] }, freeAgents: ['Free'] } },
    freeAgentRoleId: 'free-agent',
  };
}

function fixture(sheetFailure?: Error, prepareFailure?: Error) {
  const db = openDatabase(':memory:');
  const events: string[] = [];
  const announcementReferences: string[] = [];
  const current = snapshot();
  const sheets = {
    load: async () => ({ snapshot: current, sources: {} as never }),
    assertUnchanged: async () => { events.push('sheet-preflight'); },
    prepare: () => {
      events.push('sheet-targets');
      if (prepareFailure) throw prepareFailure;
      return { publicUpdates: [] };
    },
    apply: async () => { events.push('sheet-apply'); if (sheetFailure) throw sheetFailure; },
    appendTransactionHistory: async () => { events.push('history'); },
  };
  const discord = {
    validateMemberAbsent: async (discordId: string) => { events.push(`discord-absence:${discordId}`); },
    validateRoleState: async (discordId: string) => { events.push(`discord-preflight:${discordId}`); },
    validateDisplayName: async (discordId: string, expected: string) => { events.push(`discord-name-preflight:${discordId}:${expected}`); },
    applyRoleChange: async (change: { discordId: string }) => { events.push(`discord:${change.discordId}`); },
    rollbackRoleChange: async (change: { discordId: string }) => { events.push(`rollback:${change.discordId}`); },
    findAnnouncement: async () => undefined,
    announce: async (_announcement: unknown, reference: string) => {
      announcementReferences.push(reference);
      events.push('announce');
      return 'message';
    },
  };
  return { db, events, announcementReferences, current, sheets, discord };
}

test('every confirmed mutation audits before Discord and completes the durable sequence', async () => {
  const f = fixture();
  const result = await executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildTradePlan(current, 'one', 'two'),
    expectedPlanFingerprint: leagueTransactionPlanFingerprint(buildTradePlan(f.current, 'one', 'two')),
  });
  assert.equal(hasSuccessfulLeagueAudit(f.db, 'guild', '2026-09-30'), true);
  assert.deepEqual(f.events, [
    'sheet-preflight', 'sheet-targets', 'discord-preflight:one', 'discord-preflight:two',
    'discord:one', 'discord:two', 'sheet-apply', 'announce', 'history',
  ]);
  assert.equal(getLeagueTransaction(f.db, result.reference)?.status, 'completed');
  assert.equal(getLeagueTransaction(f.db, result.reference)?.announcementId, 'message');
  f.db.close();
});

test('rename can repair only its targeted Discord-name drift without bypassing the remaining audit', async () => {
  const f = fixture();
  f.current.discordMembers.find((member) => member.discordId === 'one')!.displayName = 'One Prime';

  const result = await executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildDiscordRenamePlan(current, 'one', 'One Prime'),
  });

  assert.equal(getLeagueTransaction(f.db, result.reference)?.status, 'completed');
  assert.ok(f.events.includes('sheet-apply'));
  f.db.close();
});

test('rename stops before writing if the Discord display name changes after the initial snapshot', async () => {
  const f = fixture();
  f.current.discordMembers.find((member) => member.discordId === 'one')!.displayName = 'One Prime';
  f.discord.validateDisplayName = async () => {
    throw new LeagueMutationValidationError('That player’s Discord display name changed after the transaction was loaded. Review the newest value; no changes were made.');
  };

  await assert.rejects(() => executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildDiscordRenamePlan(current, 'one', 'One Prime'),
  }), /display name changed.*no changes were made/i);

  assert.equal(f.events.includes('sheet-apply'), false);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM league_transactions').get() as { count: number }).count, 0);
  f.db.close();
});

test('rename exemption does not bypass unrelated league drift', async () => {
  const f = fixture();
  f.current.discordMembers.find((member) => member.discordId === 'one')!.displayName = 'One Prime';
  f.current.discordMembers.find((member) => member.discordId === 'two')!.roleIds.push('team-a');

  await assert.rejects(() => executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildDiscordRenamePlan(current, 'one', 'One Prime'),
  }), /multiple team roles/i);

  assert.equal(f.events.includes('sheet-apply'), false);
  f.db.close();
});

test('confirmation rejects a plan that differs from the administrator preview', async () => {
  const f = fixture();
  const previewed = buildTradePlan(f.current, 'one', 'two');
  const expectedPlanFingerprint = leagueTransactionPlanFingerprint(previewed);
  f.current.rosters.find((row) => row.discordId === 'one')!.rosterStatus = 'Player';
  f.current.names.find((row) => row.discordId === 'one')!.leagueStatus = 'Player';
  await assert.rejects(
    () => executeLeagueTransaction({
      db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
      freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
      buildPlan: (current) => buildTradePlan(current, 'one', 'two'), expectedPlanFingerprint,
    }),
    (error: unknown) => error instanceof LeagueTransactionPreviewChangedError
      && error.plan.rosters.find((row) => row.discordId === 'one')?.rosterStatus === 'Player',
  );
  assert.deepEqual(f.events, ['sheet-preflight']);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM league_transactions').get() as { count: number }).count, 0);
  f.db.close();
});

test('replacement selection changes the durable preview fingerprint', () => {
  assert.notEqual(
    leagueTransactionPlanFingerprint(buildDropPlan(snapshot(), 'one')),
    leagueTransactionPlanFingerprint(buildDropPlan(snapshot(), 'one', 'free')),
  );
});

test('trade announcement uses the locked Yggdrasil copy and pings only both team roles', () => {
  const plan = buildTradePlan(snapshot(), 'one', 'two');
  assert.deepEqual(buildLeagueAnnouncement(plan, 'Admin'), {
    content: '<@&team-a> <@&team-b>',
    allowedRoleIds: ['team-a', 'team-b'],
    title: 'Word Travels the Branches',
    description: [
      'Ratatoskr carries news of an agreement between <@&team-a> and <@&team-b>.',
      '',
      '<@one> leaves <@&team-a> to join <@&team-b>.',
      '<@two> leaves <@&team-b> to join <@&team-a>.',
    ].join('\n'),
    footer: 'Posted by Admin',
  });
});

test('departure announcement uses the locked copy, stored league name, and only the team ping', () => {
  const current = snapshot();
  current.discordMembers = current.discordMembers.filter((member) => member.discordId !== 'one');
  const plan = buildDeparturePlan(current, 'one');
  assert.deepEqual(buildLeagueAnnouncement(plan, 'Admin'), {
    content: '<@&team-a>',
    allowedRoleIds: ['team-a'],
    title: 'Word Travels the Branches',
    description: 'Ratatoskr carries word from <@&team-a>.\n\n**One** leaves <@&team-a> and the YSL server.',
    footer: 'Posted by Admin',
  });
});

test('combined exit announcements use one team notice and the locked transaction language', () => {
  const drop = buildDropPlan(snapshot(), 'one', 'free');
  assert.equal(buildLeagueAnnouncement(drop, 'Admin')?.description,
    'Ratatoskr carries word from <@&team-a>.\n\n<@&team-a> drops <@one> into free agency and picks up <@free>.');

  const selfDrop = buildSelfDropPlan(snapshot(), 'one', 'free');
  assert.equal(buildLeagueAnnouncement(selfDrop, 'Admin')?.description,
    'Ratatoskr carries word from <@&team-a>.\n\n<@one> self-drops from <@&team-a>. <@&team-a> picks up <@free> in their place.');

  const departed = snapshot();
  departed.discordMembers = departed.discordMembers.filter((member) => member.discordId !== 'one');
  const departure = buildDeparturePlan(departed, 'one', 'free');
  assert.equal(buildLeagueAnnouncement(departure, 'Admin')?.description,
    'Ratatoskr carries word from <@&team-a>.\n\n**One** leaves <@&team-a> and the YSL server. <@&team-a> picks up <@free> in their place.');
});

test('departure resolves only its selected absent roster member and skips Discord role mutation', async () => {
  const f = fixture();
  f.current.discordMembers = f.current.discordMembers.filter((member) => member.discordId !== 'one');
  const result = await executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildDeparturePlan(current, 'one'),
    expectedPlanFingerprint: leagueTransactionPlanFingerprint(buildDeparturePlan(f.current, 'one')),
  });
  assert.deepEqual(f.events, [
    'sheet-preflight', 'discord-absence:one', 'sheet-targets', 'sheet-apply', 'announce', 'history',
  ]);
  assert.equal(getLeagueTransaction(f.db, result.reference)?.kind, 'departure');
  assert.equal(f.events.some((event) => event.startsWith('discord-preflight:')), false);
  assert.equal(f.events.some((event) => event.startsWith('discord:one')), false);
  f.db.close();
});

test('departure with replacement validates and mutates only the present replacement', async () => {
  const f = fixture();
  f.current.discordMembers = f.current.discordMembers.filter((member) => member.discordId !== 'one');
  await executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildDeparturePlan(current, 'one', 'free'),
  });
  assert.deepEqual(f.events, [
    'sheet-preflight', 'discord-absence:one', 'sheet-targets', 'discord-preflight:free',
    'discord:free', 'sheet-apply', 'announce', 'history',
  ]);
  f.db.close();
});

test('self-drop with replacement performs both live Discord role changes under one transaction', async () => {
  const f = fixture();
  const result = await executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildSelfDropPlan(current, 'one', 'free'),
  });
  assert.equal(getLeagueTransaction(f.db, result.reference)?.kind, 'self-drop');
  assert.deepEqual(f.events, [
    'sheet-preflight', 'sheet-targets', 'discord-preflight:one', 'discord-preflight:free',
    'discord:one', 'discord:free', 'sheet-apply', 'announce', 'history',
  ]);
  f.db.close();
});

test('departure fails closed when fresh Discord absence cannot be confirmed', async () => {
  const f = fixture();
  f.current.discordMembers = f.current.discordMembers.filter((member) => member.discordId !== 'one');
  f.discord.validateMemberAbsent = async () => {
    f.events.push('discord-absence:one');
    throw new LeagueMutationValidationError('That player is back in the YSL server.');
  };
  await assert.rejects(() => executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildDeparturePlan(current, 'one'),
  }), /back in the YSL server/i);
  assert.deepEqual(f.events, ['sheet-preflight', 'discord-absence:one']);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM league_transactions').get() as { count: number }).count, 0);
  f.db.close();
});

test('departure still blocks unrelated absent roster members', async () => {
  const f = fixture();
  f.current.discordMembers = [];
  const reference = await executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildDeparturePlan(current, 'one'),
  }).then(() => '', (error: Error & { reference?: string }) => error.reference!);
  assert.ok(reference);
  assert.equal(getLeagueReconciliationTicket(f.db, reference)?.status, 'open');
  assert.deepEqual(f.events, []);
  f.db.close();
});

test('failed daily audit blocks every mutation and records no transaction', async () => {
  const f = fixture();
  f.current.publicRosters.Vanaheim!.teams.A = ['Wrong'];
  const reference = await executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildTradePlan(current, 'one', 'two'),
  }).then(() => '', (error: Error & { reference?: string }) => {
    assert.match(error.message, /made no changes.*league audit failed/i);
    return error.reference!;
  });
  assert.equal(hasSuccessfulLeagueAudit(f.db, 'guild', '2026-09-30'), false);
  assert.equal(getLeagueReconciliationTicket(f.db, reference)?.status, 'open');
  assert.deepEqual(f.events, []);
  f.db.close();
});

test('the same unresolved sheet drift reuses one durable ticket and a clean audit resolves it', async () => {
  const f = fixture();
  f.current.publicRosters.Vanaheim!.teams.A = ['Wrong'];
  const attempt = () => executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildRenamePlan(current, 'one', 'Renamed'),
  }).then(() => '', (error: Error & { reference?: string }) => error.reference!);
  const firstReference = await attempt();
  const secondReference = await attempt();
  assert.equal(secondReference, firstReference);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM league_reconciliation_tickets').get() as { count: number }).count, 1);

  f.current.publicRosters.Vanaheim!.teams.A = ['One'];
  await attempt();
  assert.equal(getLeagueReconciliationTicket(f.db, firstReference)?.status, 'resolved');
  f.db.close();
});

test('an unresolved public roster target blocks all Discord and durable mutation work', async () => {
  const f = fixture(undefined, new Error('No empty slot was found in the managed team block.'));
  await assert.rejects(() => executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildTradePlan(current, 'one', 'two'),
  }), /No empty slot/i);
  assert.deepEqual(f.events, ['sheet-preflight', 'sheet-targets']);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM league_transactions').get() as { count: number }).count, 0);
  f.db.close();
});

test('targeted role preflight validates complete role integrity even for a rename', async () => {
  const f = fixture();
  recordLeagueAudit(f.db, { guildId: 'guild', auditDate: '2026-09-30', status: 'passed', issues: [] });
  f.current.discordMembers.find((member) => member.discordId === 'one')!.roleIds.push('team-b');
  await assert.rejects(() => executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildRenamePlan(current, 'one', 'Renamed'),
  }), /multiple team roles/i);
  assert.deepEqual(f.events, []);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM league_transactions').get() as { count: number }).count, 0);
  f.db.close();
});

test('fresh role drift opens a durable no-write reconciliation ticket', async () => {
  const f = fixture();
  f.discord.validateRoleState = async (discordId: string) => {
    f.events.push(`discord-preflight:${discordId}`);
    throw new Error(`Complete league role state changed for ${discordId}.`);
  };
  const reference = await executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildTradePlan(current, 'one', 'two'),
  }).then(() => '', (error: Error & { reference?: string }) => error.reference!);
  assert.ok(reference);
  assert.equal(getLeagueReconciliationTicket(f.db, reference)?.status, 'open');
  assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM league_transactions').get() as { count: number }).count, 0);
  assert.deepEqual(f.events, ['sheet-preflight', 'sheet-targets', 'discord-preflight:one']);
  f.db.close();
});

test('role drift detected between participant mutations leaves a durable reconciliation transaction', async () => {
  const f = fixture();
  f.discord.applyRoleChange = async (change: { discordId: string }) => {
    f.events.push(`discord:${change.discordId}`);
    if (change.discordId === 'two') {
      throw Object.assign(new Error('Discord roles changed before Ratatoskr updated two.'), { reconciliationRequired: true });
    }
  };
  const reference = await executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildTradePlan(current, 'one', 'two'),
  }).then(() => '', (error: Error & { reference?: string }) => error.reference!);
  assert.equal(getLeagueTransaction(f.db, reference)?.status, 'reconciliation_required');
  assert.equal(f.events.some((event) => event.startsWith('rollback:')), false);
  assert.equal(f.events.includes('sheet-apply'), false);
  f.db.close();
});

test('targeted preflight rejects stale current-name assignment metadata after the daily audit', async () => {
  const f = fixture();
  recordLeagueAudit(f.db, { guildId: 'guild', auditDate: '2026-09-30', status: 'passed', issues: [] });
  f.current.names.find((row) => row.discordId === 'one')!.franchise = 'B';
  await assert.rejects(() => executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildRenamePlan(current, 'one', 'Renamed'),
  }), /Player Name History.*Current Rosters.*make the assignments match/i);
  assert.deepEqual(f.events, []);
  assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM league_transactions').get() as { count: number }).count, 0);
  f.db.close();
});

test('a safe sheet preflight failure rolls Discord back and closes the attempt as failed', async () => {
  const f = fixture(new LeagueSheetDriftError('changed'));
  const reference = await executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildTradePlan(current, 'one', 'two'),
  }).then(() => '', (error: Error & { reference?: string }) => { assert.match(error.message, /changed/); return error.reference!; });
  assert.deepEqual(f.events.slice(-2), ['rollback:two', 'rollback:one']);
  assert.equal(getLeagueTransaction(f.db, reference)?.status, 'failed');
  f.db.close();
});

test('an ambiguous sheet write never rolls Discord back and requires reconciliation', async () => {
  const f = fixture(new LeagueSheetReconciliationRequiredError('partial'));
  const reference = await executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildTradePlan(current, 'one', 'two'),
  }).then(() => '', (error: Error & { reference?: string }) => error.reference!);
  assert.equal(f.events.some((event) => event.startsWith('rollback:')), false);
  assert.equal(getLeagueTransaction(f.db, reference)?.status, 'reconciliation_required');
  f.db.close();
});

test('startup recovery reuses a confirmed announcement and appends history idempotently', async () => {
  const f = fixture();
  f.discord.announce = async (_announcement, reference) => {
    f.announcementReferences.push(reference);
    f.events.push('announce');
    throw new Error('temporary');
  };
  const reference = await executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildTradePlan(current, 'one', 'two'),
  }).then(() => '', (error: Error & { reference?: string }) => error.reference!);
  assert.equal(getLeagueTransaction(f.db, reference)?.status, 'announcement_pending');
  f.discord.announce = async (_announcement, recoveryReference) => {
    f.announcementReferences.push(recoveryReference);
    f.events.push('recovered-announce');
    return 'recovered-message';
  };
  await reconcilePendingLeagueTransactions({ db: f.db, sheets: f.sheets, discord: f.discord });
  assert.equal(getLeagueTransaction(f.db, reference)?.status, 'completed');
  assert.equal(getLeagueTransaction(f.db, reference)?.announcementId, 'recovered-message');
  assert.deepEqual(f.events.slice(-2), ['recovered-announce', 'history']);
  assert.deepEqual(f.announcementReferences, [reference, reference]);
  await reconcilePendingLeagueTransactions({ db: f.db, sheets: f.sheets, discord: f.discord });
  assert.equal(f.events.filter((event) => event === 'recovered-announce').length, 1);
  f.db.close();
});

test('startup recovery quarantines and reports transactions interrupted during mutation', async () => {
  const f = fixture();
  const payload = { plan: buildTradePlan(f.current, 'one', 'two'), record: { reference: '', effectiveDate: '2026-09-30', processedById: 'admin', processedBy: 'Admin' } };
  createLeagueTransaction(f.db, { reference: 'YSL-TRX-DISCORD', guildId: 'guild', kind: 'trade', actorUserId: 'admin', payload });
  createLeagueTransaction(f.db, { reference: 'YSL-TRX-SHEETS', guildId: 'guild', kind: 'trade', actorUserId: 'admin', payload });
  transitionLeagueTransaction(f.db, 'YSL-TRX-SHEETS', 'applying_discord', 'applying_sheets');
  const reports: { reference: string; message: string }[] = [];
  await reconcilePendingLeagueTransactions({
    db: f.db,
    sheets: f.sheets,
    discord: f.discord,
    reportError: async (reference, error) => {
      reports.push({ reference, message: error instanceof Error ? error.message : String(error) });
      return { staffDelivered: true };
    },
  });
  assert.equal(getLeagueTransaction(f.db, 'YSL-TRX-DISCORD')?.status, 'reconciliation_required');
  assert.equal(getLeagueTransaction(f.db, 'YSL-TRX-SHEETS')?.status, 'reconciliation_required');
  assert.deepEqual(reports.map((report) => report.reference), ['YSL-TRX-DISCORD', 'YSL-TRX-SHEETS']);
  assert.equal(reports.every((report) => /manual reconciliation is required/i.test(report.message)), true);
  await reconcilePendingLeagueTransactions({
    db: f.db, sheets: f.sheets, discord: f.discord,
    reportError: async () => { throw new Error('delivered alerts must not retry'); },
  });
  assert.deepEqual(f.events, []);
  f.db.close();
});

test('startup recovery retries an undelivered reconciliation alert on the next run', async () => {
  const f = fixture();
  const payload = { plan: buildTradePlan(f.current, 'one', 'two'), record: { reference: '', effectiveDate: '2026-09-30', processedById: 'admin', processedBy: 'Admin' } };
  createLeagueTransaction(f.db, { reference: 'YSL-TRX-RETRY', guildId: 'guild', kind: 'trade', actorUserId: 'admin', payload });
  let attempts = 0;
  const recover = () => reconcilePendingLeagueTransactions({
    db: f.db, sheets: f.sheets, discord: f.discord,
    reportError: async () => ({ staffDelivered: ++attempts > 1 }),
  });
  await recover();
  assert.equal(getLeagueTransaction(f.db, 'YSL-TRX-RETRY')?.reconciliationAlertedAt, null);
  await recover();
  assert.ok(getLeagueTransaction(f.db, 'YSL-TRX-RETRY')?.reconciliationAlertedAt);
  assert.equal(attempts, 2);
  await recover();
  assert.equal(attempts, 2);
  f.db.close();
});

test('startup recovery delivers an undelivered sheet reconciliation ticket once', async () => {
  const f = fixture();
  f.current.publicRosters.Vanaheim!.teams.A = ['Wrong'];
  const reference = await executeLeagueTransaction({
    db: f.db, operationScope: f.db, guildId: 'guild', actorUserId: 'admin', actorName: 'Admin',
    freeAgentRoleId: 'free-agent', now: new Date('2026-09-30T17:00:00-04:00'), sheets: f.sheets, discord: f.discord,
    buildPlan: (current) => buildRenamePlan(current, 'one', 'Renamed'),
  }).then(() => '', (error: Error & { reference?: string }) => error.reference!);
  let attempts = 0;
  const recover = () => reconcilePendingLeagueTransactions({
    db: f.db, sheets: f.sheets, discord: f.discord,
    reportError: async (reportedReference, error) => {
      assert.equal(reportedReference, reference);
      assert.match(error instanceof Error ? error.message : String(error), /made no changes/i);
      return { staffDelivered: ++attempts > 1 };
    },
  });
  await recover();
  assert.equal(getLeagueReconciliationTicket(f.db, reference)?.alertedAt, null);
  await recover();
  assert.ok(getLeagueReconciliationTicket(f.db, reference)?.alertedAt);
  await recover();
  assert.equal(attempts, 2);
  f.db.close();
});

test('startup recovery turns an interrupted audit repair into one durable staff reconciliation alert', async () => {
  const f = fixture();
  createLeagueAuditRepair(f.db, {
    reference: 'YSL-AUD-FIX-CRASH', guildId: 'guild', auditReference: 'YSL-AUD-1234', actorUserId: 'admin',
    finding: 'A player role may not match the managed sheets.', action: 'repair-roles',
  });
  const reports: string[] = [];
  const recover = () => reconcilePendingLeagueTransactions({
    db: f.db, sheets: f.sheets, discord: f.discord,
    reportError: async (reference, error) => {
      assert.equal(reference, 'YSL-AUD-FIX-CRASH');
      reports.push(error instanceof Error ? error.message : String(error));
      return { staffDelivered: true };
    },
  });

  await recover();
  assert.equal(getLeagueAuditRepair(f.db, 'YSL-AUD-FIX-CRASH')?.status, 'reconciliation_required');
  assert.ok(getLeagueReconciliationTicket(f.db, 'YSL-AUD-FIX-CRASH')?.alertedAt);
  assert.match(reports[0]!, /interrupted.*may be partially applied/i);
  await recover();
  assert.equal(reports.length, 1);
  resolveOpenLeagueReconciliationTickets(f.db, 'guild');
  await recover();
  assert.equal(reports.length, 1);
  f.db.close();
});
