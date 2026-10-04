import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../db/client.js';
import { getLeagueAuditState } from '../db/repositories/leagueAudits.js';
import type { LeagueSnapshot } from '../domain/leagueOperations.js';
import { nextLeagueAuditAt, recoverPendingLeagueAudit, runLeagueAudit, startLeagueAuditWorker, type LeagueAuditCard, type LeagueAuditCardPort } from './leagueAudit.js';
import { LeagueSheetInputError } from './leagueSheets.js';

function snapshot(): LeagueSnapshot {
  return {
    teams: [
      { teamKey: 'a_vd', division: 'Vanaheim', franchise: 'A', teamRole: 'A VD', teamRoleId: 'team-a', divisionRoleId: 'division', active: true },
      { teamKey: 'b_vd', division: 'Vanaheim', franchise: 'B', teamRole: 'B VD', teamRoleId: 'team-b', divisionRoleId: 'division', active: true },
    ],
    rosters: [
      { sheetRow: 6, division: 'Vanaheim', franchise: 'A', teamRoleId: 'team-a', team: 'A VD', discordId: 'one', player: 'One', rosterStatus: 'Captain' },
      { sheetRow: 7, division: 'Vanaheim', franchise: 'B', teamRoleId: 'team-b', team: 'B VD', discordId: 'two', player: 'Two', rosterStatus: 'Player' },
    ],
    names: [
      { sheetRow: 6, discordId: 'one', currentLeagueName: 'One', knownName: 'One', nameStatus: 'Current Discord Name', division: 'Vanaheim', franchise: 'A', leagueStatus: 'Captain' },
      { sheetRow: 7, discordId: 'two', currentLeagueName: 'Two', knownName: 'Two', nameStatus: 'Current Discord Name', division: 'Vanaheim', franchise: 'B', leagueStatus: 'Player' },
    ],
    discordMembers: [
      { discordId: 'one', displayName: 'One', roleIds: ['team-a', 'division'] },
      { discordId: 'two', displayName: 'Two', roleIds: ['team-b', 'division'] },
    ],
    publicRosters: { Vanaheim: { teams: { A: ['One'], B: [] }, freeAgents: [] } },
    freeAgentRoleId: 'free-agent',
  };
}

class Cards implements LeagueAuditCardPort {
  sent: Array<{ card: LeagueAuditCard; reference: string }> = [];
  deleted: string[] = [];
  failNextSend = false;
  loseNextSendResponse = false;
  failNextDelete = false;

  async findByReference(reference: string) {
    const index = this.sent.findIndex((entry) => entry.reference === reference);
    return index < 0 ? undefined : `message-${index + 1}`;
  }
  async send(card: LeagueAuditCard, reference: string) {
    if (this.failNextSend) { this.failNextSend = false; throw new Error('send failed'); }
    this.sent.push({ card, reference });
    if (this.loseNextSendResponse) { this.loseNextSendResponse = false; throw new Error('response lost'); }
    return `message-${this.sent.length}`;
  }
  async delete(messageId: string) {
    if (this.failNextDelete) { this.failNextDelete = false; throw new Error('delete failed'); }
    this.deleted.push(messageId);
  }
}

test('a dirty startup audit posts one unpinged staff card and records it durably', async () => {
  const db = openDatabase(':memory:');
  const cards = new Cards();
  try {
    const result = await runLeagueAudit({
      db,
      operationScope: db,
      guildId: 'guild',
      trigger: 'startup',
      now: new Date('2026-10-04T10:00:00.000Z'),
      freeAgentRoleId: 'free-agent',
      members: { getMembers: async () => snapshot().discordMembers },
      sheets: { load: async () => ({ snapshot: snapshot(), sources: {} as never }) },
      cards,
    });

    assert.equal(result.status, 'dirty');
    assert.equal(cards.sent.length, 1);
    assert.equal(cards.sent[0]?.card.allowedMentions, false);
    assert.match(cards.sent[0]!.card.title, /action required/i);
    assert.match(cards.sent[0]!.card.description, /roster sheets and setup/i);
    assert.equal(getLeagueAuditState(db, 'guild')?.currentMessageId, 'message-1');
  } finally {
    db.close();
  }
});

test('audit cards stay compact and offer a private review queue instead of listing every player', async () => {
  const db = openDatabase(':memory:');
  const cards = new Cards();
  const current = snapshot();
  current.rosters[0]!.discordId = '143011986349883392';
  current.rosters[0]!.player = 'Old League Name';
  current.names[0]!.discordId = '143011986349883392';
  current.names[0]!.currentLeagueName = 'Current League Name';
  current.discordMembers[0]!.discordId = '143011986349883392';
  try {
    await runLeagueAudit({
      db,
      operationScope: db,
      guildId: 'guild',
      trigger: 'startup',
      now: new Date('2026-10-04T10:00:00.000Z'),
      freeAgentRoleId: 'free-agent',
      members: { getMembers: async () => current.discordMembers },
      sheets: { load: async () => ({ snapshot: current, sources: {} as never }) },
      cards,
    });

    const card = cards.sent[0]!.card;
    const description = card.description;
    assert.match(description, /player names/i);
    assert.match(description, /review issues/i);
    assert.doesNotMatch(description, /Old League Name/);
    assert.doesNotMatch(description, /Current League Name/);
    assert.doesNotMatch(description, /143011986349883392/);
    assert.doesNotMatch(description, /inspect the audit log/i);
    assert.deepEqual(card.actions, [{ id: 'league-audit:review', label: 'Review issues' }]);
  } finally {
    db.close();
  }
});

test('large audits stay compact while preserving the complete private review queue', async () => {
  const db = openDatabase(':memory:');
  const cards = new Cards();
  const current = snapshot();
  current.publicRosters.Vanaheim!.teams.B = ['Two'];
  for (let index = 0; index < 60; index += 1) {
    const discordId = `14301198634988${String(index).padStart(4, '0')}`;
    current.rosters.push({ sheetRow: 8 + index, division: 'Vanaheim', franchise: 'A', teamRoleId: 'team-a', team: 'A VD', discordId, player: `Old League Name ${index}`, rosterStatus: 'Player' });
    current.names.push({ sheetRow: 8 + index, discordId, currentLeagueName: `Current League Name ${index}`, knownName: `Current League Name ${index}`, nameStatus: 'Current Discord Name', division: 'Vanaheim', franchise: 'A', leagueStatus: 'Player' });
    current.discordMembers.push({ discordId, displayName: `Current League Name ${index}`, roleIds: ['team-a', 'division'] });
    current.publicRosters.Vanaheim!.teams.A.push(`Current League Name ${index}`);
  }
  try {
    await runLeagueAudit({
      db, operationScope: db, guildId: 'guild', trigger: 'startup', now: new Date('2026-10-04T10:00:00.000Z'),
      freeAgentRoleId: 'free-agent', members: { getMembers: async () => current.discordMembers },
      sheets: { load: async () => ({ snapshot: current, sources: {} as never }) }, cards,
    });

    const description = cards.sent[0]!.card.description;
    assert.ok(description.length < 700);
    assert.match(description, /Player names: 60/);
    assert.match(description, /Review issues/);
    assert.doesNotMatch(description, /\b\d{17,20}\b/);
  } finally {
    db.close();
  }
});

test('restart recovery finds an ambiguously delivered card before deleting the prior card', async () => {
  const db = openDatabase(':memory:');
  const cards = new Cards();
  const input = {
    db, operationScope: db, guildId: 'guild', freeAgentRoleId: 'free-agent',
    members: { getMembers: async () => snapshot().discordMembers },
    sheets: { load: async () => ({ snapshot: snapshot(), sources: {} as never }) },
    cards,
  };
  try {
    await runLeagueAudit({ ...input, trigger: 'startup', now: new Date('2026-10-04T10:00:00.000Z') });
    cards.loseNextSendResponse = true;
    await assert.rejects(
      runLeagueAudit({ ...input, trigger: 'scheduled', now: new Date('2026-10-05T10:00:00.000Z') }),
      /response lost/,
    );

    await recoverPendingLeagueAudit({ db, guildId: 'guild', cards });

    assert.equal(cards.sent.length, 2);
    assert.deepEqual(cards.deleted, ['message-1']);
    assert.equal(getLeagueAuditState(db, 'guild')?.currentMessageId, 'message-2');
    assert.equal(getLeagueAuditState(db, 'guild')?.phase, 'settled');
  } finally {
    db.close();
  }
});

test('failed stale-card deletion retries cleanup without posting another card', async () => {
  const db = openDatabase(':memory:');
  const cards = new Cards();
  const input = {
    db, operationScope: db, guildId: 'guild', freeAgentRoleId: 'free-agent',
    members: { getMembers: async () => snapshot().discordMembers },
    sheets: { load: async () => ({ snapshot: snapshot(), sources: {} as never }) },
    cards,
  };
  try {
    await runLeagueAudit({ ...input, trigger: 'startup', now: new Date('2026-10-04T10:00:00.000Z') });
    cards.failNextDelete = true;
    await assert.rejects(
      runLeagueAudit({ ...input, trigger: 'scheduled', now: new Date('2026-10-05T10:00:00.000Z') }),
      /delete failed/,
    );
    assert.equal(getLeagueAuditState(db, 'guild')?.currentMessageId, 'message-2');
    assert.equal(getLeagueAuditState(db, 'guild')?.staleMessageId, 'message-1');

    await recoverPendingLeagueAudit({ db, guildId: 'guild', cards });

    assert.equal(cards.sent.length, 2);
    assert.deepEqual(cards.deleted, ['message-1']);
    assert.equal(getLeagueAuditState(db, 'guild')?.phase, 'settled');
  } finally {
    db.close();
  }
});

test('a failed replacement post retains the prior card and a durable retry marker', async () => {
  const db = openDatabase(':memory:');
  const cards = new Cards();
  const input = {
    db, operationScope: db, guildId: 'guild', freeAgentRoleId: 'free-agent',
    members: { getMembers: async () => snapshot().discordMembers },
    sheets: { load: async () => ({ snapshot: snapshot(), sources: {} as never }) },
    cards,
  };
  try {
    await runLeagueAudit({ ...input, trigger: 'startup', now: new Date('2026-10-04T10:00:00.000Z') });
    cards.failNextSend = true;
    await assert.rejects(
      runLeagueAudit({ ...input, trigger: 'scheduled', now: new Date('2026-10-05T10:00:00.000Z') }),
      /send failed/,
    );

    const state = getLeagueAuditState(db, 'guild');
    assert.equal(state?.currentMessageId, 'message-1');
    assert.equal(state?.phase, 'send_pending');
    assert.equal(state?.sendAttempted, true);
    assert.deepEqual(cards.deleted, []);
  } finally {
    db.close();
  }
});

test('a later dirty audit posts its fresh card before deleting the prior card', async () => {
  const db = openDatabase(':memory:');
  const cards = new Cards();
  const input = {
    db, operationScope: db, guildId: 'guild', freeAgentRoleId: 'free-agent',
    members: { getMembers: async () => snapshot().discordMembers },
    sheets: { load: async () => ({ snapshot: snapshot(), sources: {} as never }) },
    cards,
  };
  try {
    await runLeagueAudit({ ...input, trigger: 'startup', now: new Date('2026-10-04T10:00:00.000Z') });
    await runLeagueAudit({ ...input, trigger: 'scheduled', now: new Date('2026-10-05T10:00:00.000Z') });

    assert.deepEqual(cards.sent.map(({ card }) => card.footer.split(' • ')[0]), ['Startup audit', 'Daily audit']);
    assert.deepEqual(cards.deleted, ['message-1']);
    assert.equal(getLeagueAuditState(db, 'guild')?.currentMessageId, 'message-2');
    assert.equal(getLeagueAuditState(db, 'guild')?.phase, 'settled');
  } finally {
    db.close();
  }
});

test('a clean audit removes the outstanding card and resolves the durable state', async () => {
  const db = openDatabase(':memory:');
  const cards = new Cards();
  let current = snapshot();
  const input = {
    db, operationScope: db, guildId: 'guild', freeAgentRoleId: 'free-agent',
    members: { getMembers: async () => current.discordMembers },
    sheets: { load: async () => ({ snapshot: current, sources: {} as never }) },
    cards,
  };
  try {
    await runLeagueAudit({ ...input, trigger: 'startup', now: new Date('2026-10-04T10:00:00.000Z') });
    current = snapshot();
    current.publicRosters.Vanaheim!.teams.B = ['Two'];
    const result = await runLeagueAudit({ ...input, trigger: 'scheduled', now: new Date('2026-10-05T10:00:00.000Z') });

    assert.equal(result.status, 'clean');
    assert.deepEqual(cards.deleted, ['message-1']);
    const state = getLeagueAuditState(db, 'guild');
    assert.equal(state?.result, 'clean');
    assert.equal(state?.currentMessageId, null);
    assert.equal(state?.phase, 'settled');
  } finally {
    db.close();
  }
});

test('failed clean-state deletion remains durable and retries without a clean card', async () => {
  const db = openDatabase(':memory:');
  const cards = new Cards();
  let current = snapshot();
  const input = {
    db, operationScope: db, guildId: 'guild', freeAgentRoleId: 'free-agent',
    members: { getMembers: async () => current.discordMembers },
    sheets: { load: async () => ({ snapshot: current, sources: {} as never }) }, cards,
  };
  try {
    await runLeagueAudit({ ...input, trigger: 'startup', now: new Date('2026-10-04T10:00:00.000Z') });
    current = snapshot();
    current.publicRosters.Vanaheim!.teams.B = ['Two'];
    cards.failNextDelete = true;
    await assert.rejects(
      runLeagueAudit({ ...input, trigger: 'scheduled', now: new Date('2026-10-05T10:00:00.000Z') }),
      /delete failed/,
    );
    assert.equal(getLeagueAuditState(db, 'guild')?.result, 'clean');
    assert.equal(getLeagueAuditState(db, 'guild')?.currentMessageId, null);
    assert.equal(getLeagueAuditState(db, 'guild')?.staleMessageId, 'message-1');

    await recoverPendingLeagueAudit({ db, guildId: 'guild', cards });

    assert.equal(cards.sent.length, 1);
    assert.deepEqual(cards.deleted, ['message-1']);
    assert.equal(getLeagueAuditState(db, 'guild')?.phase, 'settled');
  } finally {
    db.close();
  }
});

test('an unreadable source posts an audit-failed card instead of claiming the league is clean', async () => {
  const db = openDatabase(':memory:');
  const cards = new Cards();
  try {
    const result = await runLeagueAudit({
      db, operationScope: db, guildId: 'guild', trigger: 'scheduled',
      now: new Date('2026-10-05T10:00:00.000Z'), freeAgentRoleId: 'free-agent',
      members: { getMembers: async () => { throw new Error('Discord unavailable'); } },
      sheets: { load: async () => { throw new Error('should not run'); } },
      cards,
    });

    assert.equal(result.status, 'error');
    assert.match(cards.sent[0]!.card.title, /could not complete/i);
    assert.doesNotMatch(cards.sent[0]!.card.description, /Discord unavailable/);
    assert.equal(getLeagueAuditState(db, 'guild')?.result, 'error');
  } finally {
    db.close();
  }
});

test('a known roster-sheet input problem gives staff the exact safe repair on the audit card', async () => {
  const db = openDatabase(':memory:');
  const cards = new Cards();
  try {
    const result = await runLeagueAudit({
      db, operationScope: db, guildId: 'guild', trigger: 'scheduled',
      now: new Date('2026-10-05T10:00:00.000Z'), freeAgentRoleId: 'free-agent',
      members: { getMembers: async () => snapshot().discordMembers },
      sheets: { load: async () => { throw new LeagueSheetInputError({
        code: 'LEAGUE_SHEET_MISSING_DISCORD_ID',
        summary: 'Player Name History row 234 has player information, but its Discord ID cell in column A is blank.',
        next: 'Open Player Name History row 234, move the existing values one column left, then retry the action.',
      }); } },
      cards,
    });

    assert.equal(result.status, 'error');
    const description = cards.sent[0]!.card.description;
    assert.match(description, /Player Name History row 234/);
    assert.match(description, /move the existing values one column left/);
    assert.match(description, /LEAGUE_SHEET_MISSING_DISCORD_ID/);
    assert.match(description, /No changes were made/);
    assert.doesNotMatch(description, /check which connection failed/i);
  } finally {
    db.close();
  }
});

test('the next daily audit remains 6:00 AM New York across daylight-saving changes', () => {
  assert.equal(nextLeagueAuditAt(new Date('2026-03-07T12:00:00.000Z')).toISOString(), '2026-03-08T10:00:00.000Z');
  assert.equal(nextLeagueAuditAt(new Date('2026-10-31T12:00:00.000Z')).toISOString(), '2026-11-01T11:00:00.000Z');
  assert.equal(nextLeagueAuditAt(new Date('2026-10-03T09:00:00.000Z')).toISOString(), '2026-10-03T10:00:00.000Z');
});

test('the worker persists its next run and reschedules after the daily audit', async () => {
  const db = openDatabase(':memory:');
  const cards = new Cards();
  const current = snapshot();
  current.publicRosters.Vanaheim!.teams.B = ['Two'];
  await runLeagueAudit({
    db, operationScope: db, guildId: 'guild', trigger: 'startup',
    now: new Date('2026-10-03T12:00:00.000Z'), freeAgentRoleId: 'free-agent',
    members: { getMembers: async () => current.discordMembers },
    sheets: { load: async () => ({ snapshot: current, sources: {} as never }) }, cards,
  });
  let now = new Date('2026-10-03T12:00:00.000Z');
  let scheduled: (() => void) | undefined;
  let runs = 0;
  try {
    const stop = startLeagueAuditWorker({
      db, guildId: 'guild', now: () => now,
      run: async () => { runs += 1; },
      setTimer: (callback) => { scheduled = callback; return { unref() {} }; },
      clearTimer: () => {},
    });
    assert.equal(getLeagueAuditState(db, 'guild')?.nextRunAt, '2026-10-04T10:00:00.000Z');

    now = new Date('2026-10-04T10:00:00.000Z');
    scheduled!();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(runs, 1);
    assert.equal(getLeagueAuditState(db, 'guild')?.nextRunAt, '2026-10-05T10:00:00.000Z');
    stop();
  } finally {
    db.close();
  }
});

test('overlapping audit triggers coalesce into one read and one rolling-card update', async () => {
  const db = openDatabase(':memory:');
  const cards = new Cards();
  let releaseLoad!: () => void;
  const loadGate = new Promise<void>((resolve) => { releaseLoad = resolve; });
  let loads = 0;
  const input = {
    db, operationScope: db, guildId: 'guild', freeAgentRoleId: 'free-agent',
    members: { getMembers: async () => snapshot().discordMembers },
    sheets: { load: async () => { loads += 1; await loadGate; return { snapshot: snapshot(), sources: {} as never }; } },
    cards,
  };
  try {
    const first = runLeagueAudit({ ...input, trigger: 'startup' as const, now: new Date('2026-10-04T10:00:00.000Z') });
    const second = runLeagueAudit({ ...input, trigger: 'scheduled' as const, now: new Date('2026-10-04T10:00:01.000Z') });
    releaseLoad();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(loads, 1);
    assert.equal(cards.sent.length, 1);
    assert.deepEqual(secondResult, firstResult);
  } finally {
    db.close();
  }
});
