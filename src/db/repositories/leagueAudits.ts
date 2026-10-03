import type Database from 'better-sqlite3';

export type LeagueAuditState = {
  guildId: string;
  result: 'clean' | 'dirty' | 'error';
  findings: string[];
  runReference: string;
  runAt: string;
  trigger: 'startup' | 'scheduled';
  phase: 'send_pending' | 'delete_pending' | 'settled';
  sendAttempted: boolean;
  currentMessageId: string | null;
  staleMessageId: string | null;
  nextRunAt: string | null;
};

type Row = {
  guild_id: string;
  result: LeagueAuditState['result'];
  findings_json: string;
  run_reference: string;
  run_at: string;
  trigger: LeagueAuditState['trigger'];
  phase: LeagueAuditState['phase'];
  send_attempted: number;
  current_message_id: string | null;
  stale_message_id: string | null;
  next_run_at: string | null;
};

function toState(row: Row): LeagueAuditState {
  return {
    guildId: row.guild_id,
    result: row.result,
    findings: JSON.parse(row.findings_json) as string[],
    runReference: row.run_reference,
    runAt: row.run_at,
    trigger: row.trigger,
    phase: row.phase,
    sendAttempted: row.send_attempted === 1,
    currentMessageId: row.current_message_id,
    staleMessageId: row.stale_message_id,
    nextRunAt: row.next_run_at,
  };
}

export function getLeagueAuditState(db: Database.Database, guildId: string): LeagueAuditState | undefined {
  const row = db.prepare('SELECT * FROM league_audit_cards WHERE guild_id = ?').get(guildId) as Row | undefined;
  return row ? toState(row) : undefined;
}

export function beginDirtyLeagueAudit(db: Database.Database, input: {
  guildId: string;
  result: 'dirty' | 'error';
  findings: string[];
  runReference: string;
  runAt: string;
  trigger: LeagueAuditState['trigger'];
}): void {
  db.prepare(`INSERT INTO league_audit_cards (
      guild_id, result, findings_json, run_reference, run_at, trigger, phase,
      send_attempted, current_message_id, stale_message_id
    ) VALUES (?, ?, ?, ?, ?, ?, 'send_pending', 0, NULL, NULL)
    ON CONFLICT(guild_id) DO UPDATE SET
      result = excluded.result,
      findings_json = excluded.findings_json,
      run_reference = excluded.run_reference,
      run_at = excluded.run_at,
      trigger = excluded.trigger,
      phase = 'send_pending',
      send_attempted = 0,
      stale_message_id = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    .run(input.guildId, input.result, JSON.stringify(input.findings), input.runReference, input.runAt, input.trigger);
}

export function beginCleanLeagueAudit(db: Database.Database, input: {
  guildId: string;
  runReference: string;
  runAt: string;
  trigger: LeagueAuditState['trigger'];
}): void {
  db.prepare(`INSERT INTO league_audit_cards (
      guild_id, result, findings_json, run_reference, run_at, trigger, phase,
      send_attempted, current_message_id, stale_message_id
    ) VALUES (?, 'clean', '[]', ?, ?, ?, 'settled', 0, NULL, NULL)
    ON CONFLICT(guild_id) DO UPDATE SET
      result = 'clean', findings_json = '[]', run_reference = excluded.run_reference,
      run_at = excluded.run_at, trigger = excluded.trigger,
      phase = CASE WHEN current_message_id IS NULL THEN 'settled' ELSE 'delete_pending' END,
      stale_message_id = current_message_id, current_message_id = NULL, send_attempted = 0,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    .run(input.guildId, input.runReference, input.runAt, input.trigger);
}

export function markLeagueAuditSendAttempted(db: Database.Database, guildId: string, runReference: string): boolean {
  return db.prepare(`UPDATE league_audit_cards SET send_attempted = 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE guild_id = ? AND run_reference = ? AND phase = 'send_pending'`).run(guildId, runReference).changes === 1;
}

export function confirmLeagueAuditCard(db: Database.Database, guildId: string, runReference: string, messageId: string): boolean {
  return db.prepare(`UPDATE league_audit_cards SET
      stale_message_id = CASE WHEN current_message_id = ? THEN NULL ELSE current_message_id END,
      current_message_id = ?, phase = 'delete_pending',
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE guild_id = ? AND run_reference = ? AND phase = 'send_pending'`)
    .run(messageId, messageId, guildId, runReference).changes === 1;
}

export function settleLeagueAuditCard(db: Database.Database, guildId: string, runReference: string): boolean {
  return db.prepare(`UPDATE league_audit_cards SET phase = 'settled', stale_message_id = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE guild_id = ? AND run_reference = ? AND phase = 'delete_pending'`).run(guildId, runReference).changes === 1;
}

export function setLeagueAuditNextRunAt(db: Database.Database, guildId: string, nextRunAt: string | null): boolean {
  return db.prepare(`UPDATE league_audit_cards SET next_run_at = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE guild_id = ?`).run(nextRunAt, guildId).changes === 1;
}
